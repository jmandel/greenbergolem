// Combined progress log for a run .
//
// Every task and every subagent invocation appends a line here. Consumers
// (the UI viewer, the `progress` tail utility, or a human with `tail -f`)
// watch this file to follow the run.
//
// Schema: one JSON object per line. Consumers MUST ignore unknown keys so we
// can extend event shapes without breaking readers.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type ProgressKind =
  | "workflow-start"
  | "workflow-end"
  | "task-start"
  | "task-success"
  | "task-failure"
  | "task-cached"
  | "subagent-start"
  | "subagent-stdout"
  | "subagent-stderr"
  | "subagent-exit"
  | "artifact-written"
  | "note";

export interface ProgressEvent {
  timestamp: string;
  runId: string;
  kind: ProgressKind;
  invocationId?: string;
  taskType?: string;
  workflow?: string;
  message?: string;
  // For stdout/stderr chunks — kept bounded so the file stays scannable.
  textHead?: string;
  // Free-form structured payload — anything, never required.
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export class ProgressLog {
  constructor(private readonly path: string) {}

  async emit(evt: Omit<ProgressEvent, "timestamp"> & { timestamp?: string }): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...evt });
    await appendFile(this.path, line + "\n", "utf8");
  }
}

/** Clip a chunk so we don't balloon the progress log with huge transcripts. */
export function clipChunk(text: string, maxLen = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= maxLen ? t : t.slice(0, maxLen) + "…";
}
