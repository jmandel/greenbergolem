// subclaim-label: post-hoc task that assigns subclaim ids to
// on-claim occurrences missing them in paper-judge's judgments.jsonl.
// Output is a sidecar `subclaim-labels.jsonl` that edge-aggregate can
// merge via its --subclaim-labels-jsonl flag.
//
// Only-when-missing semantics: occurrences whose paper-judge output
// already carries `subclaimIds` are passed through unchanged (no LLM
// call). Only occurrences without are batched through a subagent for
// classification. This makes the task a no-op for future runs whose
// paper-judge prompt produces subclaimIds inline, while still being
// useful as a gap-filler for older runs or post-hoc re-labeling.
//
// Design: batch ~BATCH_SIZE occurrences per subagent call, everything
// bundled into stdin (no per-batch staged files). Each call sees the
// claim + subclaim list + the list of (occurrenceId, citing sentence)
// pairs, and returns one subclaim-id array per occurrence.

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ClaimPackSchema,
  type ClaimPack,
  type CitationOccurrenceRecord,
  type OccurrenceJudgment,
  type SubclaimLabel,
} from "../../contracts/index.ts";
import { runSubagentTask, type PreparedFile } from "../../lib/subagent-runner.ts";
import { SubagentSemaphore } from "../../lib/subagent.ts";
import { ProgressLog } from "../../orchestrator/progress.ts";

const TASK_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPT_VERSION = "subclaim-label.v1";
const CONTRACT_VERSION = "subclaim-label.contract.v1";

const LabelOutputSchema = z.array(
  z.object({
    occurrenceId: z.string(),
    subclaimIds: z.array(z.string()),
    rationale: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
);

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      "run-id": { type: "string" },
      "claim-json": { type: "string" },
      "judgments-jsonl": { type: "string" },
      "occurrences-jsonl": { type: "string" },
      "batch-size": { type: "string", default: "25" },
      "concurrency": { type: "string", default: "10" },
      "cli": { type: "string", default: "copilot" },
      "model": { type: "string", default: "claude-haiku-4-5-20251001" },
    },
  });
  const outDir = values["out-dir"];
  const claimPath = values["claim-json"];
  const judPath = values["judgments-jsonl"];
  const occPath = values["occurrences-jsonl"];
  if (!outDir || !claimPath || !judPath || !occPath) {
    console.error("usage: --out-dir <dir> --claim-json <path> --judgments-jsonl <path> --occurrences-jsonl <path> [--batch-size N] [--concurrency N] [--cli copilot] [--model <id>]");
    process.exit(2);
  }
  const runId = values["run-id"] ?? "ad-hoc";
  const batchSize = Math.max(1, Math.min(100, Number(values["batch-size"]) || 25));
  const conc = Math.max(1, Number(values["concurrency"]) || 10);
  const progress = new ProgressLog(join(outDir, "..", "progress.jsonl"));

  const claim = ClaimPackSchema.parse(JSON.parse(await readFile(claimPath, "utf8"))) as ClaimPack;
  const subclaims = claim.subclaims;
  if (subclaims.length === 0) {
    console.error("[subclaim-label] claim pack has no subclaims — nothing to label");
    process.exit(0);
  }
  const validSubclaimIds = new Set(subclaims.map((s) => s.id));

  const judgments = (await readJsonl(judPath)) as OccurrenceJudgment[];
  const occurrences = (await readJsonl(occPath)) as CitationOccurrenceRecord[];
  const occById = new Map(occurrences.map((o) => [o.occurrenceId, o]));

  // Only label on-claim occurrences. Everything else gets an implicit
  // empty subclaimIds at edge-aggregate time (no label written).
  const onClaim = judgments.filter((j) => j.relevance !== "not-about-claim");

  // Short-circuit pass-through: occurrences whose judgment already
  // carries subclaimIds (e.g. a newer paper-judge prompt produced
  // them inline) don't need an LLM call. Emit their label directly
  // and only batch the remainder for the subagent.
  const preLabeled: SubclaimLabel[] = [];
  const needsLabeling: OccurrenceJudgment[] = [];
  for (const j of onClaim) {
    const ids = j.subclaimIds;
    if (ids !== undefined) {
      const validIds = ids.filter((id) => validSubclaimIds.has(id));
      preLabeled.push({ occurrenceId: j.occurrenceId, subclaimIds: validIds });
    } else {
      needsLabeling.push(j);
    }
  }

  await progress.emit({
    runId,
    kind: "task-start",
    taskType: "subclaim-label",
    message: `${onClaim.length} on-claim (${preLabeled.length} pre-labeled by paper-judge, ${needsLabeling.length} need LLM pass), batch=${batchSize}, conc=${conc}, cli=${values.cli} model=${values.model}`,
  });

  const batches: OccurrenceJudgment[][] = [];
  for (let i = 0; i < needsLabeling.length; i += batchSize) batches.push(needsLabeling.slice(i, i + batchSize));

  await mkdir(outDir, { recursive: true });
  await mkdir(join(outDir, "batches"), { recursive: true });

  const promptTpl = await readFile(join(TASK_DIR, "prompt.md"), "utf8");
  const contractMd = await readFile(join(TASK_DIR, "CONTRACT.md"), "utf8");
  const claimMd = renderClaimMd(claim);

  const semaphore = new SubagentSemaphore(conc);
  const allLabels: SubclaimLabel[] = [];
  let done = 0;
  let cached = 0;
  let failed = 0;

  await Promise.all(batches.map(async (batch, batchIdx) => {
    const key = batchCacheHash(claim.id, batch);
    const batchDir = join(outDir, "batches", key);
    const cachePath = join(batchDir, ".cache-key");
    const resultPath = join(batchDir, "labels.json");
    try {
      await access(cachePath);
      const stored = (await readFile(cachePath, "utf8")).trim();
      if (stored === key) {
        const prior = JSON.parse(await readFile(resultPath, "utf8")) as SubclaimLabel[];
        allLabels.push(...prior);
        cached++;
        done++;
        if (done % 10 === 0) await tick(progress, runId, done, batches.length, cached, failed);
        return;
      }
    } catch { /* proceed */ }

    const occsMd = renderOccurrencesMd(batch, occById);
    const stdinPrompt = [
      promptTpl,
      "",
      "---",
      "",
      "The files below are embedded here for your convenience; the same",
      "content is on disk for re-reference, but everything you need is",
      "inline. You do not need to read anything from disk.",
      "",
      "## CLAIM.md",
      "",
      claimMd,
      "",
      "## OCCURRENCES.md",
      "",
      occsMd,
      "",
      "## CONTRACT.md",
      "",
      contractMd,
    ].join("\n");

    const inputs: PreparedFile[] = [
      { name: "CLAIM.md", content: claimMd },
      { name: "OCCURRENCES.md", content: occsMd },
      { name: "CONTRACT.md", content: contractMd },
    ];

    try {
      await mkdir(batchDir, { recursive: true });
      const result = await runSubagentTask({
        taskType: "subclaim-label",
        workspaceDir: batchDir,
        files: inputs,
        prompt: stdinPrompt,
        outputFilename: "report.md",
        schema: LabelOutputSchema,
        cli: values.cli as "copilot",
        model: values.model,
        timeoutMs: 10 * 60 * 1000,
        availableTools: ["bash", "view", "create", "edit", "report_intent", "task_complete"],
        maxAutopilotContinues: 20,
        progress,
        runId,
        semaphore,
        promptVersion: PROMPT_VERSION,
        contractVersion: CONTRACT_VERSION,
      });
      const parsed = LabelOutputSchema.parse(result.json);
      // Validate subclaim ids against taxonomy.
      const occIdsInBatch = new Set(batch.map((j) => j.occurrenceId));
      const cleaned: SubclaimLabel[] = [];
      for (const row of parsed) {
        if (!occIdsInBatch.has(row.occurrenceId)) continue;
        const validIds = row.subclaimIds.filter((id) => validSubclaimIds.has(id));
        cleaned.push({
          occurrenceId: row.occurrenceId,
          subclaimIds: validIds,
          rationale: row.rationale,
          confidence: row.confidence,
        });
      }
      await writeFile(resultPath, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
      await writeFile(cachePath, key + "\n", "utf8");
      allLabels.push(...cleaned);
      done++;
      if (done % 10 === 0) await tick(progress, runId, done, batches.length, cached, failed);
    } catch (e) {
      failed++;
      done++;
      await progress.emit({
        runId,
        kind: "note",
        taskType: "subclaim-label",
        message: `batch ${batchIdx} failed: ${String(e).slice(0, 200)}`,
      });
    }
  }));

  // Merge in the pre-labeled passthrough (paper-judge inline output).
  allLabels.push(...preLabeled);

  // Sort labels by occurrenceId for stable output.
  allLabels.sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId));

  const jsonlPath = join(outDir, "subclaim-labels.jsonl");
  await writeFile(jsonlPath, allLabels.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

  // Histogram for the summary.
  const hist: Record<string, number> = {};
  let unlabeled = 0;
  for (const l of allLabels) {
    if (l.subclaimIds.length === 0) unlabeled++;
    for (const sid of l.subclaimIds) hist[sid] = (hist[sid] ?? 0) + 1;
  }
  const summary = {
    totalOnClaim: onClaim.length,
    preLabeledByPaperJudge: preLabeled.length,
    llmLabeled: needsLabeling.length,
    batches: batches.length,
    processed: done,
    cached,
    failed,
    labels: allLabels.length,
    unlabeledOccurrences: unlabeled,
    subclaimCounts: hist,
  };
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");

  const report = [
    `# subclaim-label report`,
    ``,
    `On-claim occurrences: **${onClaim.length}**`,
    `Pre-labeled by paper-judge (inline, passthrough): **${preLabeled.length}**`,
    `Sent through LLM classifier: **${needsLabeling.length}**`,
    `Batches: **${batches.length}** (cached=${cached}, failed=${failed})`,
    `Labels written: **${allLabels.length}**`,
    `Unlabeled (on-claim but no specific subclaim): **${unlabeled}**`,
    ``,
    `## Per-subclaim occurrence counts`,
    ``,
    ...subclaims.map((s) => `- \`${s.id}\`: **${hist[s.id] ?? 0}** — ${s.text}`),
    ``,
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    ``,
  ].join("\n");
  await writeFile(join(outDir, "report.md"), report, "utf8");

  await progress.emit({
    runId,
    kind: "task-success",
    taskType: "subclaim-label",
    message: `${allLabels.length} labels written`,
    data: summary,
  });

  console.log(`[subclaim-label] wrote ${allLabels.length} labels to ${jsonlPath}`);
}

function renderClaimMd(claim: ClaimPack): string {
  const lines: string[] = [];
  lines.push(`# Claim`, ``);
  lines.push(`**Claim:** ${claim.canonicalClaim}`);
  lines.push(`**Claim ID:** \`${claim.id}\``);
  lines.push(``);
  lines.push(`## Subclaims`, ``);
  for (const s of claim.subclaims) {
    lines.push(`- \`${s.id}\`: ${s.text}`);
  }
  return lines.join("\n");
}

function renderOccurrencesMd(
  batch: OccurrenceJudgment[],
  occById: Map<string, CitationOccurrenceRecord>,
): string {
  const lines: string[] = [];
  lines.push(`# Occurrences to label (${batch.length})`);
  lines.push(``);
  for (const j of batch) {
    const occ = occById.get(j.occurrenceId);
    const sentence = occ?.sentence ?? "(sentence missing from occurrence record)";
    const section = occ?.section ?? "?";
    lines.push(`## \`${j.occurrenceId}\``);
    lines.push(`- **Section:** ${section}`);
    lines.push(`- **Citing sentence:** ${sentence}`);
    lines.push(`- **Paper-judge verdict:** role=${j.role}, relevance=${j.relevance}${j.inventionType ? `, invention=${j.inventionType}` : ""}`);
    lines.push(``);
  }
  return lines.join("\n");
}

function batchCacheHash(claimId: string, batch: OccurrenceJudgment[]): string {
  const h = createHash("sha256");
  h.update(claimId);
  for (const j of [...batch].sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId))) {
    h.update("|");
    h.update(j.occurrenceId);
    h.update("/");
    h.update(j.role);
    h.update("/");
    h.update(j.relevance);
  }
  return h.digest("hex").slice(0, 20);
}

async function tick(
  progress: ProgressLog,
  runId: string,
  done: number,
  total: number,
  cached: number,
  failed: number,
): Promise<void> {
  await progress.emit({
    runId,
    kind: "note",
    taskType: "subclaim-label",
    message: `batches ${done}/${total} (cached ${cached}, failed ${failed})`,
  });
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
