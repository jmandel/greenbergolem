// Orchestrator.
//
// Reads workflow.yaml, drives the task mesh, wires flags between tasks so
// each task gets the artifacts it needs from upstream. For the pilot this
// is a linear driver with checkpointed cache — a task whose declared
// output file(s) already exist is skipped.
//
// Each run writes to run/<runId>/ and uses fixed subdirectory names per
// the workflow template's `outDir` so paths are stable across reruns.

import { parseArgs } from "node:util";
import { readFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { ProvenanceLog } from "../lib/provenance.ts";
import { ProgressLog } from "./progress.ts";

interface TaskDef {
  entrypoint: string;
  retries?: number;
  concurrency?: number;
  usesSubagent?: boolean;
}
interface Step {
  task: string;
  outDir: string;
}
interface WorkflowDef {
  description: string;
  steps: Step[];
}
interface WorkflowConfig {
  version: number;
  tasks: Record<string, TaskDef>;
  workflows: Record<string, WorkflowDef>;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      workflow: { type: "string" },
      config: { type: "string", default: "workflow.yaml" },
      "run-dir": { type: "string" },
      "run-id": { type: "string" },
      "claim": { type: "string" },
      "claim-file": { type: "string" },
      "years": { type: "string", default: "2020-2024" },
      "per-query": { type: "string", default: "50" },
      "cap": { type: "string", default: "500" },
      "profile-concurrency": { type: "string", default: "8" },
      "profile-model": { type: "string", default: "claude-opus-4.7" },
      "gate-concurrency": { type: "string", default: "8" },
      "gate-model": { type: "string", default: "claude-opus-4.7" },
      "judge-concurrency": { type: "string", default: "6" },
      "judge-model": { type: "string", default: "claude-opus-4.7" },
      "limit": { type: "string" },
      "skip-completed": { type: "boolean", default: true },
    },
  });

  if (!values.workflow) {
    console.error("usage: bun orchestrator/run.ts --workflow <name> [--claim ...] [--run-id ...]");
    process.exit(2);
  }

  const config = parseYaml(await readFile(values.config!, "utf8")) as WorkflowConfig;
  const wf = config.workflows[values.workflow];
  if (!wf) {
    console.error(`unknown workflow: ${values.workflow}`);
    console.error(`available: ${Object.keys(config.workflows).join(", ")}`);
    process.exit(2);
  }

  const runId = values["run-id"] ?? `run-${Date.now()}`;
  const runDir = values["run-dir"] ?? join("run", runId);
  await mkdir(runDir, { recursive: true });

  const prov = new ProvenanceLog(join(runDir, "provenance.jsonl"));
  const progress = new ProgressLog(join(runDir, "progress.jsonl"));

  await prov.append({ runId, kind: "workflow-start", workflow: values.workflow, note: wf.description });
  await progress.emit({ runId, kind: "workflow-start", workflow: values.workflow });
  console.log(`[orchestrator] workflow=${values.workflow} runDir=${runDir} runId=${runId}`);

  const steps = wf.steps;

  // Resolve per-step input wiring. Keys are task names, values are the
  // CLI flags we append to `bun <entrypoint>` for that step.
  const wiring: Record<string, (stepOut: string) => string[]> = {
    "claim-pack": () => [
      ...(values.claim ? ["--input", values.claim] : []),
      ...(values["claim-file"] ? ["--input-file", values["claim-file"]!] : []),
      "--years", values.years!,
    ],
    "seed-search": () => [
      "--claim-json", join(runDir, "claim-pack", "claim-pack.json"),
      "--per-query", values["per-query"]!,
      "--cap", values.cap!,
    ],
    "fetch-fulltext": () => [
      "--seed-jsonl", join(runDir, "seed-search", "papers.seed.jsonl"),
    ],
    "paper-profile": () => [
      "--claim-json", join(runDir, "claim-pack", "claim-pack.json"),
      "--registry-jsonl", join(runDir, "fetch-fulltext", "papers.registry.jsonl"),
      "--papers-dir", join(runDir, "fetch-fulltext", "papers"),
      "--concurrency", values["profile-concurrency"]!,
      "--model", values["profile-model"]!,
      ...(values.limit ? ["--limit", values.limit!] : []),
    ],
    "occurrence-extract": () => [
      "--registry-jsonl", join(runDir, "fetch-fulltext", "papers.registry.jsonl"),
      "--papers-dir", join(runDir, "fetch-fulltext", "papers"),
    ],
    "occurrence-gate": () => [
      "--claim-json", join(runDir, "claim-pack", "claim-pack.json"),
      "--occurrences-jsonl", join(runDir, "occurrence-extract", "occurrences.jsonl"),
      "--concurrency", values["gate-concurrency"]!,
      "--model", values["gate-model"]!,
      ...(values.limit ? ["--limit", values.limit!] : []),
    ],
    "occurrence-judge": () => [
      "--claim-json", join(runDir, "claim-pack", "claim-pack.json"),
      "--occurrences-jsonl", join(runDir, "occurrence-extract", "occurrences.jsonl"),
      "--gated-jsonl", join(runDir, "occurrence-gate", "gate.jsonl"),
      "--profiles-jsonl", join(runDir, "paper-profile", "profiles.jsonl"),
      "--papers-dir", join(runDir, "fetch-fulltext", "papers"),
      "--concurrency", values["judge-concurrency"]!,
      "--model", values["judge-model"]!,
      ...(values.limit ? ["--limit", values.limit!] : []),
    ],
    "edge-aggregate": () => [
      "--judgments-jsonl", join(runDir, "occurrence-judge", "judgments.jsonl"),
      "--occurrences-jsonl", join(runDir, "occurrence-extract", "occurrences.jsonl"),
      "--claim-id", deriveClaimIdPath(runDir),
    ],
    "graph-analyze": () => [
      "--profiles-jsonl", join(runDir, "paper-profile", "profiles.jsonl"),
      "--registry-jsonl", join(runDir, "fetch-fulltext", "papers.registry.jsonl"),
      "--edges-jsonl", join(runDir, "edge-aggregate", "edges.jsonl"),
      "--claim-json", join(runDir, "claim-pack", "claim-pack.json"),
    ],
    "render": () => [
      "--graph-json", join(runDir, "graph-analyze", "graph.json"),
      "--judgments-jsonl", join(runDir, "occurrence-judge", "judgments.jsonl"),
      "--claim-json", join(runDir, "claim-pack", "claim-pack.json"),
    ],
  };

  // Skip-rule per task: file whose existence means "done".
  const doneFile: Record<string, string> = {
    "claim-pack": "claim-pack.json",
    "seed-search": "papers.seed.jsonl",
    "fetch-fulltext": "papers.registry.jsonl",
    "paper-profile": "profiles.jsonl",
    "occurrence-extract": "occurrences.jsonl",
    "occurrence-gate": "gate.jsonl",
    "occurrence-judge": "judgments.jsonl",
    "edge-aggregate": "edges.jsonl",
    "graph-analyze": "graph.json",
    "render": "viewer.html",
  };

  for (const step of steps) {
    const def = config.tasks[step.task];
    if (!def) {
      console.error(`missing task definition: ${step.task}`);
      process.exit(2);
    }
    const outDir = join(runDir, step.outDir);
    const doneSentinel = doneFile[step.task] ? join(outDir, doneFile[step.task]!) : null;

    if (values["skip-completed"] && doneSentinel) {
      try {
        await access(doneSentinel);
        await prov.append({ runId, kind: "task-cached", taskType: step.task, outputs: [outDir] });
        await progress.emit({ runId, kind: "task-cached", taskType: step.task, message: `skip (done: ${doneSentinel})` });
        console.log(`[orchestrator] ${step.task} skipped (exists: ${doneSentinel})`);
        continue;
      } catch {
        // not done, run it
      }
    }

    const extra = (wiring[step.task] ?? (() => []))(outDir);
    const args = ["run", def.entrypoint, "--out-dir", outDir, "--run-id", runId, ...extra];

    await prov.append({ runId, kind: "task-start", taskType: step.task });
    await progress.emit({ runId, kind: "task-start", taskType: step.task, message: `-> ${outDir}` });
    const t0 = Date.now();
    const code = await runChild("bun", args);
    const latencyMs = Date.now() - t0;

    if (code !== 0) {
      await prov.append({ runId, kind: "task-failure", taskType: step.task, latencyMs, errorSummary: `exit ${code}` });
      await progress.emit({ runId, kind: "task-failure", taskType: step.task, message: `exit ${code}` });
      console.error(`[orchestrator] task ${step.task} failed (exit ${code})`);
      process.exit(code);
    }

    await prov.append({ runId, kind: "task-success", taskType: step.task, latencyMs, outputs: [outDir] });
    console.log(`[orchestrator] ${step.task} ok (${latencyMs}ms) -> ${outDir}`);
  }

  await prov.append({ runId, kind: "workflow-end" });
  await progress.emit({ runId, kind: "workflow-end" });
  console.log(`[orchestrator] done; run dir: ${runDir}`);
}

function runChild(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: "inherit", env: process.env });
    c.on("error", reject);
    c.on("exit", (code) => resolve(code ?? -1));
  });
}

/** Try to read the claim id from the claim-pack artifact; fall back to "unknown". */
function deriveClaimIdPath(runDir: string): string {
  try {
    const p = join(runDir, "claim-pack", "claim-pack.json");
    const raw = require("node:fs").readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.id ?? "unknown-claim";
  } catch {
    return "unknown-claim";
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
