// Append-only JSONL run log . Every orchestrator dispatch
// and every task outcome lands here so a reviewer can replay exactly what
// happened, with what inputs, at what cost.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type ProvenanceKind =
  | "workflow-start"
  | "workflow-end"
  | "task-start"
  | "task-success"
  | "task-failure"
  | "task-cached"
  | "subagent-call"
  | "note";

export interface ProvenanceEntry {
  timestamp: string;
  runId: string;
  kind: ProvenanceKind;
  invocationId?: string;
  taskType?: string;
  workflow?: string;
  inputs?: string[];
  outputs?: string[];
  errorSummary?: string;
  note?: string;
  costUsd?: number;
  latencyMs?: number;
  // Free-form extras — never strip; readers ignore what they don't know.
  [key: string]: unknown;
}

export class ProvenanceLog {
  constructor(private readonly path: string) {}

  async append(entry: Omit<ProvenanceEntry, "timestamp"> & { timestamp?: string }): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    await appendFile(this.path, line + "\n", "utf8");
  }
}
