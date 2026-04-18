// Higher-level wrapper around lib/subagent.ts that bakes in the
// subagent contract (§4.B–D, §14):
//
//   - prepare a clean working directory under <outDir>/workspace/
//   - copy TASK.md, CONTRACT.md, and any input files into it
//   - pipe a short stdin prompt that orients the subagent
//   - stream JSONL events into the run's progress.jsonl
//   - after exit, read the named output file(s) and validate the JSON
//     projection against a Zod schema
//
// Every domain task (claim-pack, paper-profile, occurrence-judge, ...) uses
// this wrapper — the only per-task pieces are the prompt template, the
// contract markdown, and the Zod schema.

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { z } from "zod";
import { invokeSubagent, SubagentSemaphore, type AgentCli, type SubagentResult } from "./subagent.ts";
import { ProgressLog, clipChunk } from "../orchestrator/progress.ts";
import { extractJsonFromMarkdown, parseFrontmatter, validateArtifact } from "./artifacts.ts";

export interface PreparedFile {
  /** Destination filename inside the workspace. */
  name: string;
  /** Either inline content or an absolute src path to copy from. */
  content?: string;
  srcPath?: string;
}

export interface SubagentTaskOpts<T> {
  taskType: string;                     // "claim-pack", "paper-profile", ...
  workspaceDir: string;                 // task will run inside here
  files: PreparedFile[];                // inputs staged into workspace
  prompt: string;                       // short stdin orienting message
  outputFilename: string;               // e.g. "report.md"
  schema: z.ZodType<T>;                 // applied to the extracted JSON projection
  cli?: AgentCli;                       // defaults to copilot
  model?: string;                       // copilot model override
  timeoutMs?: number;
  progress?: ProgressLog;
  runId?: string;
  availableTools?: string[];            // optional copilot tool allowlist
  maxAutopilotContinues?: number;
  semaphore?: SubagentSemaphore;        // share a gate across many calls
  promptVersion?: string;
  contractVersion?: string;
}

export interface SubagentTaskResult<T> {
  json: T;
  reportMarkdown: string;
  reportPath: string;
  subagent: SubagentResult;
  frontmatter: ReturnType<typeof parseFrontmatter>["frontmatter"];
}

export async function runSubagentTask<T>(opts: SubagentTaskOpts<T>): Promise<SubagentTaskResult<T>> {
  await mkdir(opts.workspaceDir, { recursive: true });
  for (const f of opts.files) {
    const dest = join(opts.workspaceDir, f.name);
    await mkdir(join(dest, "..").replace(/\/$/, ""), { recursive: true }).catch(() => {});
    if (f.srcPath) {
      await cp(f.srcPath, dest);
    } else {
      await writeFile(dest, f.content ?? "", "utf8");
    }
  }

  const invocationId =
    `${opts.taskType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runId = opts.runId ?? "ad-hoc";
  const progress = opts.progress;

  await progress?.emit({
    runId,
    kind: "subagent-start",
    invocationId,
    taskType: opts.taskType,
    message: `workspace=${opts.workspaceDir}`,
  });

  const release = opts.semaphore ? await opts.semaphore.acquire() : () => {};
  let result: SubagentResult;
  try {
    result = await invokeSubagent({
      cli: opts.cli ?? "copilot",
      cwd: opts.workspaceDir,
      prompt: opts.prompt,
      model: opts.model,
      timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      invocationId,
      availableTools: opts.availableTools,
      maxAutopilotContinues: opts.maxAutopilotContinues,
      onEvent: (evt) => {
        switch (evt.kind) {
          case "agent-intent":
            void progress?.emit({ runId, kind: "note", invocationId, message: `intent: ${clipChunk(evt.intent)}` });
            break;
          case "agent-tool-start":
            void progress?.emit({ runId, kind: "note", invocationId, message: `tool ▶ ${evt.toolName}`, data: { args: evt.args } });
            break;
          case "agent-file-created":
            void progress?.emit({ runId, kind: "artifact-written", invocationId, message: evt.path });
            break;
          case "agent-file-edited":
            void progress?.emit({ runId, kind: "artifact-written", invocationId, message: `edited ${evt.path}` });
            break;
          case "agent-message":
            void progress?.emit({ runId, kind: "note", invocationId, message: clipChunk(evt.text) });
            break;
          case "agent-task-complete":
            void progress?.emit({ runId, kind: "note", invocationId, message: `task_complete: ${clipChunk(evt.summary)}` });
            break;
          case "agent-result":
            void progress?.emit({
              runId,
              kind: "note",
              invocationId,
              message: `result: ${evt.premiumRequests ?? "?"} premium reqs, +${evt.linesAdded ?? 0}/-${evt.linesRemoved ?? 0} lines`,
              data: { sessionDurationMs: evt.sessionDurationMs },
            });
            break;
          case "stderr-chunk":
            if (evt.text.trim()) {
              void progress?.emit({ runId, kind: "subagent-stderr", invocationId, textHead: clipChunk(evt.text) });
            }
            break;
          default:
            break;
        }
      },
    });
  } finally {
    release();
  }

  await progress?.emit({
    runId,
    kind: "subagent-exit",
    invocationId,
    data: { exitCode: result.exitCode, killed: result.killed, latencyMs: result.latencyMs },
  });

  const reportPath = join(opts.workspaceDir, opts.outputFilename);
  let reportMarkdown: string;
  try {
    reportMarkdown = await readFile(reportPath, "utf8");
  } catch {
    const msg = `subagent exited ${result.exitCode} but did not produce ${basename(opts.outputFilename)} (logs: ${result.logDir})`;
    await progress?.emit({ runId, kind: "task-failure", invocationId, taskType: opts.taskType, message: msg });
    throw new Error(msg);
  }
  const { frontmatter, body } = parseFrontmatter(reportMarkdown);
  const extracted = extractJsonFromMarkdown(body);
  let json: T;
  try {
    json = validateArtifact(opts.schema, extracted);
  } catch (e) {
    const msg = `schema validation failed for ${opts.taskType}: ${(e as Error).message}`;
    await progress?.emit({ runId, kind: "task-failure", invocationId, taskType: opts.taskType, message: msg });
    throw new Error(msg);
  }

  return { json, reportMarkdown, reportPath, subagent: result, frontmatter };
}
