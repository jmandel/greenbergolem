// CLI-agent wrapper . Every LLM-reasoning unit of work is a
// single subagent invocation: prepared cwd on disk, prompt on stdin, named
// output file contract. Stateless — no session carries between calls.
//
// Primary CLI: `copilot` (GitHub Copilot CLI, 1.0.30+). Runs with --yolo to
// bypass permission prompts, writes files into the prepared cwd, and emits
// JSONL events to stdout for progress tracking.
//
// The wrapper is CLI-agnostic: add a new entry to AgentCli and a case in
// buildCommand(). Concurrency is capped via SubagentSemaphore (default 8 per
// user guidance — raise with care).

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";

export type AgentCli = "copilot" | "claude" | "codex" | "echo-test";

export interface SubagentInvocationOpts {
  cli: AgentCli;
  cwd: string;                          // prepared working directory
  prompt: string;                        // piped to stdin; also saved to <logDir>/prompt.md
  model?: string;                        // agent-specific identifier (default: claude-opus-4.7 for copilot)
  timeoutMs?: number;                    // hard timeout; SIGTERM on expiry
  logDir?: string;                       // where to stream stdout/stderr/meta. Defaults to <cwd>/.subagent/<id>/
  invocationId?: string;
  env?: Record<string, string>;
  onEvent?: (evt: SubagentEvent) => void; // progress callback; cheap to ignore
  // Max continuation turns the agent may take in autopilot mode before giving
  // up. Bounds runaway agents. Default 10, usually plenty for a well-scoped
  // subagent task.
  maxAutopilotContinues?: number;
  // Tool allowlist — each tool is schema tokens in the preamble. We ship a
  // narrow default (`view`, `create`, `str_replace_editor`, `bash`) because
  // the full tool surface is ~35k tokens by itself; the default covers 99%
  // of our task types. Pass explicit list to override; pass `[]` to use
  // copilot's unrestricted defaults.
  availableTools?: string[];
}

/** Default tool allowlist for subagent invocations. Tight for token cost. */
export const DEFAULT_COPILOT_TOOLS = ["view", "create", "str_replace_editor", "bash"] as const;

export type SubagentEvent =
  | { kind: "start"; invocationId: string; cli: AgentCli; model?: string; cwd: string }
  | { kind: "stdout-chunk"; text: string }
  | { kind: "stderr-chunk"; text: string }
  | { kind: "exit"; exitCode: number; killed: boolean; latencyMs: number }
  // Structured events parsed out of copilot's JSONL stdout. Best-effort —
  // consumers should fall back to stdout-chunk if they need the raw form.
  | { kind: "agent-turn"; phase: "start" | "end"; turnId: string }
  | { kind: "agent-tool-start"; toolName: string; args: unknown; toolCallId: string }
  | { kind: "agent-tool-complete"; toolName: string; success: boolean; toolCallId: string; result?: unknown }
  | { kind: "agent-message"; text: string; messageId: string }
  | { kind: "agent-file-created"; path: string }
  | { kind: "agent-file-edited"; path: string }
  | { kind: "agent-intent"; intent: string }
  | { kind: "agent-task-complete"; summary: string }
  | { kind: "agent-result"; exitCode: number; premiumRequests?: number; linesAdded?: number; linesRemoved?: number; sessionDurationMs?: number };

export interface SubagentResult {
  invocationId: string;
  cli: AgentCli;
  model?: string;
  exitCode: number;
  killed: boolean;
  latencyMs: number;
  stdout: string;
  stderr: string;
  logDir: string;
}

export async function invokeSubagent(opts: SubagentInvocationOpts): Promise<SubagentResult> {
  const invocationId =
    opts.invocationId ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logDir = opts.logDir ?? join(opts.cwd, ".subagent", invocationId);
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, "prompt.md"), opts.prompt, "utf8");

  const { cmd, args, env: cliEnv, stdinMode } = buildCommand(opts);

  const started = Date.now();
  const stdoutStream = createWriteStream(join(logDir, "stdout.log"));
  const stderrStream = createWriteStream(join(logDir, "stderr.log"));

  opts.onEvent?.({ kind: "start", invocationId, cli: opts.cli, model: opts.model, cwd: opts.cwd });

  return await new Promise<SubagentResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...cliEnv, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let lineBuf = "";
    const to = opts.timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      stdoutStream.write(s);
      opts.onEvent?.({ kind: "stdout-chunk", text: s });
      if (opts.cli === "copilot") {
        lineBuf += s;
        const idx = lineBuf.lastIndexOf("\n");
        if (idx >= 0) {
          const complete = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          for (const line of complete.split("\n")) {
            if (!line.trim()) continue;
            const parsed = parseCopilotLine(line);
            if (parsed) opts.onEvent?.(parsed);
          }
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      stderrStream.write(s);
      opts.onEvent?.({ kind: "stderr-chunk", text: s });
    });
    child.on("error", (e) => {
      if (to) clearTimeout(to);
      reject(e);
    });
    child.on("exit", async (code) => {
      if (to) clearTimeout(to);
      const latencyMs = Date.now() - started;
      stdoutStream.end();
      stderrStream.end();
      const exitCode = killed ? 124 : code ?? -1;
      const meta = {
        invocationId,
        cli: opts.cli,
        model: opts.model,
        cwd: opts.cwd,
        exitCode,
        killed,
        latencyMs,
        command: [cmd, ...args],
        timestamp: new Date().toISOString(),
      };
      await writeFile(join(logDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
      opts.onEvent?.({ kind: "exit", exitCode, killed, latencyMs });
      resolve({
        invocationId,
        cli: opts.cli,
        model: opts.model,
        exitCode,
        killed,
        latencyMs,
        stdout,
        stderr,
        logDir,
      });
    });

    if (stdinMode === "prompt") {
      child.stdin.write(opts.prompt);
    }
    child.stdin.end();
  });
}

interface CommandSpec {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  // "prompt" = pipe opts.prompt to stdin; "none" = close stdin immediately
  // (prompt is already in argv or embedded elsewhere).
  stdinMode: "prompt" | "none";
}

function buildCommand(opts: SubagentInvocationOpts): CommandSpec {
  switch (opts.cli) {
    case "copilot": {
      // Copilot CLI 1.0.30+. We use `--autopilot` (not `-p`) so the prompt
      // rides on stdin — `-p` has a hard argv-length cap we'd otherwise
      // bump against for real task prompts. `--yolo` bypasses permission
      // prompts; `--no-ask-user` keeps it autonomous; `--output-format json`
      // yields JSONL events that we stream into the progress log.
      //
      // Context trim for our subagent use case:
      //   --disable-builtin-mcps   — drops github-mcp-server (fat schema)
      //   --no-custom-instructions — skips auto-loading AGENTS.md / CLAUDE.md
      //                              from the cwd; we prepare the cwd
      //                              deliberately so this bloat is wasted
      //   --available-tools=...    — optional per-task tool allowlist
      const model = opts.model ?? "claude-opus-4.7";
      const maxCont = opts.maxAutopilotContinues ?? 10;
      const args = [
        "--autopilot",
        "--yolo",
        "--no-ask-user",
        "--no-auto-update",
        "--no-color",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--model",
        model,
        "--output-format",
        "json",
        "--max-autopilot-continues",
        String(maxCont),
      ];
      // `availableTools === undefined` → use the narrow default. Explicit `[]`
      // opts into copilot's full default tool surface (~35k schema tokens).
      const tools = opts.availableTools ?? DEFAULT_COPILOT_TOOLS;
      if (tools.length > 0) {
        args.push(`--available-tools=${tools.join(",")}`);
      }
      return { cmd: "copilot", args, env: {}, stdinMode: "prompt" };
    }
    case "claude":
      return {
        cmd: "claude",
        args: [
          "-p",
          "--permission-mode",
          "bypassPermissions",
          "--output-format",
          "text",
          ...(opts.model ? ["--model", opts.model] : []),
        ],
        env: {},
        stdinMode: "prompt",
      };
    case "codex":
      return {
        cmd: "codex",
        args: ["exec", ...(opts.model ? ["--model", opts.model] : [])],
        env: {},
        stdinMode: "prompt",
      };
    case "echo-test":
      // Plumbing test stand-in: cat echoes stdin to stdout. Zero cost.
      return { cmd: "cat", args: [], env: {}, stdinMode: "prompt" };
  }
}

/**
 * Parse one line of copilot --output-format json JSONL into a SubagentEvent.
 * Returns null for lines we don't care about (ephemeral MCP status, etc.).
 * Best-effort — never throws; unknown event types fall through.
 */
function parseCopilotLine(line: string): SubagentEvent | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const t: string = obj?.type ?? "";
  const d = obj?.data ?? {};
  switch (t) {
    case "assistant.turn_start":
      return { kind: "agent-turn", phase: "start", turnId: String(d.turnId ?? "") };
    case "assistant.turn_end":
      return { kind: "agent-turn", phase: "end", turnId: String(d.turnId ?? "") };
    case "assistant.message":
      if (typeof d.content === "string" && d.content.length > 0) {
        return { kind: "agent-message", text: d.content, messageId: String(d.messageId ?? "") };
      }
      return null;
    case "tool.execution_start": {
      const name = String(d.toolName ?? "");
      if (name === "report_intent") {
        return { kind: "agent-intent", intent: String(d.arguments?.intent ?? "") };
      }
      if (name === "task_complete") {
        return { kind: "agent-task-complete", summary: String(d.arguments?.summary ?? "") };
      }
      return {
        kind: "agent-tool-start",
        toolName: name,
        args: d.arguments,
        toolCallId: String(d.toolCallId ?? ""),
      };
    }
    case "tool.execution_complete":
      return {
        kind: "agent-tool-complete",
        toolName: String(d.toolName ?? d.result?.toolName ?? ""),
        success: Boolean(d.success),
        toolCallId: String(d.toolCallId ?? ""),
        result: d.result,
      };
    case "session.info": {
      const info = String(d.infoType ?? "");
      const msg = String(d.message ?? "");
      if (info === "file_created") return { kind: "agent-file-created", path: msg };
      if (info === "file_edited") return { kind: "agent-file-edited", path: msg };
      return null;
    }
    case "result": {
      const usage = obj.usage ?? {};
      return {
        kind: "agent-result",
        exitCode: Number(obj.exitCode ?? 0),
        premiumRequests: usage.premiumRequests,
        linesAdded: usage.codeChanges?.linesAdded,
        linesRemoved: usage.codeChanges?.linesRemoved,
        sessionDurationMs: usage.sessionDurationMs,
      };
    }
    default:
      return null;
  }
}

/**
 * Concurrency gate for fanned-out subagent work. Default cap is 8 per user
 * guidance — the Copilot CLI / backend is documented to support up to 8
 * parallel sessions. Raise only with evidence that the backend will serve it.
 */
export class SubagentSemaphore {
  private inflight = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max = 8) {}

  async acquire(): Promise<() => void> {
    if (this.inflight >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inflight++;
    return () => {
      this.inflight--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
