// Pretty-print + tail a progress.jsonl file.
// Usage: bun orchestrator/tail.ts run/<run-id>/progress.jsonl [--follow]

import { parseArgs } from "node:util";
import { watch, existsSync } from "node:fs";
import { open } from "node:fs/promises";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      follow: { type: "boolean", short: "f", default: false },
    },
  });

  const path = positionals[0];
  if (!path) {
    console.error("usage: bun orchestrator/tail.ts <progress.jsonl> [--follow]");
    process.exit(2);
  }

  let pos = 0;
  const drain = async (): Promise<void> => {
    if (!existsSync(path)) return;
    const fh = await open(path, "r");
    try {
      const stat = await fh.stat();
      if (stat.size <= pos) return;
      const buf = Buffer.alloc(stat.size - pos);
      await fh.read(buf, 0, buf.length, pos);
      pos = stat.size;
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          console.log(format(JSON.parse(line)));
        } catch {
          /* skip malformed */
        }
      }
    } finally {
      await fh.close();
    }
  };

  await drain();
  if (values.follow) {
    watch(path, { persistent: true }, () => {
      void drain();
    });
    await new Promise(() => {}); // keep alive
  }
}

function format(evt: any): string {
  const ts = typeof evt.timestamp === "string" ? evt.timestamp.slice(11, 19) : "??:??:??";
  const id = evt.invocationId ? ` (${String(evt.invocationId).slice(-10)})` : "";
  const kind = String(evt.kind ?? "?");
  switch (kind) {
    case "workflow-start":
      return `${ts} ▶ workflow ${evt.workflow ?? ""} — ${evt.message ?? ""}`;
    case "workflow-end":
      return `${ts} ✓ workflow end`;
    case "task-start":
      return `${ts} ▶ task ${evt.taskType ?? ""}${id}`;
    case "task-success":
      return `${ts} ✓ task ${evt.taskType ?? ""}${id} ${evt.message ? `— ${evt.message}` : ""}`;
    case "task-failure":
      return `${ts} ✗ task ${evt.taskType ?? ""}${id} ${evt.message ? `— ${evt.message}` : ""}`;
    case "task-cached":
      return `${ts} ⋯ task ${evt.taskType ?? ""}${id} (cached)`;
    case "subagent-start":
      return `${ts} ▶ subagent${id}`;
    case "subagent-exit": {
      const d = evt.data ?? {};
      return `${ts} ◼ subagent${id} exit=${d.exitCode ?? "?"} ${d.latencyMs ?? "?"}ms`;
    }
    case "subagent-stderr":
      return `${ts} ! stderr${id}: ${evt.textHead ?? ""}`;
    case "artifact-written":
      return `${ts} · wrote${id}: ${evt.message ?? ""}`;
    case "note":
      return `${ts} · note${id}: ${evt.message ?? ""}`;
    default:
      return `${ts} [${kind}]${id} ${JSON.stringify(evt)}`;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
