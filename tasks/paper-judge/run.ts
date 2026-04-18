// paper-judge: one subagent call per citing-paper chunk. For each
// citing paper, we group outgoing occurrences by cited paper (= edges),
// split the edge list into chunks of max N edges (default 10), and
// run one subagent call per chunk. The agent sees the citing paper's
// body once per chunk (not per edge) plus N cited papers' bodies plus
// all pre-extracted occurrences between them.
//
// Output files:
//   out-dir/edge-judgments.jsonl  — one EdgeJudgment per line
//                                   (derived from chunk outputs)
//   out-dir/judgments.jsonl       — one OccurrenceJudgment per line
//                                   (edge-aggregate format; downstream
//                                   unchanged)
//   out-dir/report.md             — coverage summary

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, stat, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ClaimPackSchema,
  PaperProfileSchema,
  OccurrenceRoleSchema,
  OccurrenceRelevanceSchema,
  type ClaimPack,
  type CitationOccurrenceRecord,
  type PaperProfile,
  type OccurrenceJudgment,
  type ResolvedClaimPack,
} from "../../contracts/index.ts";
import { resolveClaimPack } from "../../contracts/resolve.ts";
import { runSubagentTask, type PreparedFile } from "../../lib/subagent-runner.ts";
import { SubagentSemaphore } from "../../lib/subagent.ts";
import { writeArtifact } from "../../lib/artifacts.ts";
import { ProgressLog } from "../../orchestrator/progress.ts";

const TASK_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPT_VERSION = "paper-judge.v1";
const CONTRACT_VERSION = "paper-judge.contract.v1";

// No arbitrary body-length truncations. The agent reads the full
// citing and cited paper bodies from the staged bundles (citing/body.md
// and cited/<id>/body.md). What we put inline in CITING_PAPER.md is
// the paper profile only (evidence class, stance, rationale) — a
// pointer, not a substitute.

const OccurrenceVerdictSchema = z.object({
  occurrenceId: z.string(),
  onClaim: z.boolean(),
  relevance: OccurrenceRelevanceSchema,
  role: OccurrenceRoleSchema.optional().nullable(),
  inventionType: z.string().regex(/^[a-z][a-z0-9-]*$/).optional().nullable(),
  citingEvidence: z.array(z.string()).default([]),
  citedEvidence: z.array(z.string()).default([]),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});

const EdgeJudgmentSchema = z.object({
  edgeId: z.string(),
  citingPaperId: z.string(),
  citedPaperId: z.string(),
  claimId: z.string(),
  occurrenceJudgments: z.array(OccurrenceVerdictSchema),
  missedOccurrences: z.array(z.unknown()).optional().default([]),
  edgeSummary: z.object({
    dominantRole: OccurrenceRoleSchema,
    mixedSignal: z.boolean(),
    hasInvention: z.boolean(),
    rationale: z.string(),
    confidence: z.number().min(0).max(1),
  }),
});

const ChunkOutputSchema = z.array(EdgeJudgmentSchema);

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      "run-id": { type: "string" },
      "claim-json": { type: "string" },
      "occurrences-jsonl": { type: "string" },
      "profiles-jsonl": { type: "string" },
      "papers-dir": { type: "string" },
      "edges-per-chunk": { type: "string", default: "10" },
      "concurrency": { type: "string", default: "8" },
      "model": { type: "string", default: "claude-opus-4.7" },
      "cli": { type: "string", default: "copilot" },
      "limit": { type: "string" },                 // cap on number of chunks
    },
  });

  const outDir = values["out-dir"];
  const claimPath = values["claim-json"];
  const occPath = values["occurrences-jsonl"];
  const profilesPath = values["profiles-jsonl"];
  const papersDir = values["papers-dir"];
  if (!outDir || !claimPath || !occPath || !profilesPath || !papersDir) {
    console.error("usage: --out-dir <dir> --claim-json <path> --occurrences-jsonl <path> --profiles-jsonl <path> --papers-dir <dir> [--edges-per-chunk 10] [--concurrency N] [--limit N]");
    process.exit(2);
  }
  const runId = values["run-id"] ?? "ad-hoc";
  const conc = Math.max(1, Math.min(16, Number(values.concurrency) || 8));
  const edgesPerChunk = Math.max(1, Math.min(30, Number(values["edges-per-chunk"]) || 10));
  const limit = values.limit ? Math.max(1, Number(values.limit)) : Infinity;
  const progress = new ProgressLog(join(outDir, "..", "progress.jsonl"));

  const claim = ClaimPackSchema.parse(JSON.parse(await readFile(claimPath, "utf8"))) as ClaimPack;
  const resolved = resolveClaimPack(claim);
  const allOccurrences = (await readJsonl(occPath)) as CitationOccurrenceRecord[];
  const profiles = (await readJsonl(profilesPath)).map((p) => PaperProfileSchema.parse(p)) as PaperProfile[];
  const profileByPaperId = new Map(profiles.map((p) => [p.paperId, p]));
  const relevantIds = new Set(profiles.filter((p) => p.relevant).map((p) => p.paperId));

  // Only judge occurrences where the CITING paper is on-claim. Off-
  // claim citing papers' citations are not about this claim and we'd
  // be spending LLM budget judging their methods refs and such. The
  // CITED paper is NOT filtered: a relevant paper citing an off-claim
  // paper in support of the claim is a dead-end invention we
  // specifically want to catch.
  const occurrences = allOccurrences.filter((o) => relevantIds.has(o.citingPaperId));
  const skipped = allOccurrences.length - occurrences.length;

  // Group occurrences by citing paper → cited paper (nested).
  const byCiting = new Map<string, Map<string, CitationOccurrenceRecord[]>>();
  for (const o of occurrences) {
    const edges = byCiting.get(o.citingPaperId) ?? new Map<string, CitationOccurrenceRecord[]>();
    const occs = edges.get(o.citedPaperId) ?? [];
    occs.push(o);
    edges.set(o.citedPaperId, occs);
    byCiting.set(o.citingPaperId, edges);
  }

  // Build chunks: for each citing paper, partition its outgoing edges
  // into groups of edgesPerChunk.
  interface Chunk {
    citingPaperId: string;
    chunkIdx: number;
    totalChunks: number;
    edges: Array<{ citedPaperId: string; occurrences: CitationOccurrenceRecord[] }>;
  }
  const chunks: Chunk[] = [];
  for (const [citingPaperId, edges] of byCiting) {
    const edgeList = [...edges.entries()].map(([citedPaperId, occurrences]) => ({ citedPaperId, occurrences }));
    // Sort by cited paperId for deterministic chunking (cache key stability).
    edgeList.sort((a, b) => a.citedPaperId.localeCompare(b.citedPaperId));
    const totalChunks = Math.ceil(edgeList.length / edgesPerChunk);
    for (let i = 0; i < edgeList.length; i += edgesPerChunk) {
      chunks.push({
        citingPaperId,
        chunkIdx: Math.floor(i / edgesPerChunk),
        totalChunks,
        edges: edgeList.slice(i, i + edgesPerChunk),
      });
    }
  }
  // Process bigger chunks first (more edges → more signal, less bursty).
  chunks.sort((a, b) => b.edges.length - a.edges.length);
  const toProcess = isFinite(limit) ? chunks.slice(0, limit) : chunks;

  await progress.emit({
    runId,
    kind: "task-start",
    taskType: "paper-judge",
    message: `${toProcess.length} chunks (of ${chunks.length}), ${byCiting.size} citing papers, ${occurrences.length} occurrences (${skipped} skipped — off-claim citing), conc=${conc}, edges-per-chunk=${edgesPerChunk}`,
  });

  const claimMd = renderClaimMd(resolved);
  const taxonomiesMd = renderInventionTaxonomyMd(resolved);
  const validInventionIds = new Set<string>(resolved.inventionTypes.map((t) => t.id));
  const validSubclaimIds = new Set<string>(resolved.subclaims.map((s) => s.id));
  const contractMd = await readFile(join(TASK_DIR, "CONTRACT.md"), "utf8");
  const promptTpl = await readFile(join(TASK_DIR, "prompt.md"), "utf8");

  const semaphore = new SubagentSemaphore(conc);
  const allEdgeJudgments: Array<z.infer<typeof EdgeJudgmentSchema> & { provenance: unknown }> = [];
  let cached = 0;
  let failed = 0;
  let done = 0;

  await Promise.all(toProcess.map((chunk) =>
    (async () => {
      const chunkId = `${chunk.citingPaperId}-chunk${chunk.chunkIdx}`;
      const chunkDir = join(outDir, "chunks", chunkId);
      const chunkJsonPath = join(chunkDir, "edge-judgments.json");
      const cacheKeyPath = join(chunkDir, ".cache-key");
      const cacheKey = chunkCacheHash(claim.id, chunk);

      // Cache check
      try {
        const stored = await readFile(cacheKeyPath, "utf8");
        if (stored.trim() === cacheKey) {
          await access(chunkJsonPath);
          const raw = JSON.parse(await readFile(chunkJsonPath, "utf8")) as { edgeJudgments: unknown; provenance: unknown };
          const parsed = ChunkOutputSchema.parse(raw.edgeJudgments);
          for (const ej of parsed) allEdgeJudgments.push({ ...ej, provenance: raw.provenance });
          cached++;
          done++;
          if (done % 25 === 0) await emitProgress(progress, runId, done, toProcess.length, cached, failed);
          return;
        }
      } catch {
        // proceed
      }

      const citingProfile = profileByPaperId.get(chunk.citingPaperId);
      const citingMd = renderCitingPaperMd(chunk.citingPaperId, citingProfile, chunk.edges);
      const edgesMd = renderEdgesMd(chunk.citingPaperId, chunk.edges);

      // Stage each cited paper's full bundle so the agent can read
      // them thoroughly (grep/view/xmllint), not just from the inline
      // hint excerpts.
      const citedStaged: PreparedFile[] = [];
      for (const e of chunk.edges) {
        citedStaged.push(...(await tryStageJats(papersDir, e.citedPaperId, `cited/${e.citedPaperId}`)));
      }

      const scopeMd = renderScopeMd(chunk.citingPaperId, chunk.edges);

      const inputs: PreparedFile[] = [
        { name: "CLAIM.md", content: claimMd },
        { name: "TAXONOMIES.md", content: taxonomiesMd },
        { name: "SCOPE.md", content: scopeMd },
        { name: "CITING_PAPER.md", content: citingMd },
        { name: "EDGES.md", content: edgesMd },
        { name: "CONTRACT.md", content: contractMd },
        ...(await tryStageJats(papersDir, chunk.citingPaperId, "citing")),
        ...citedStaged,
      ];

      // Bundle critical content into the stdin prompt. Everything the
      // agent MUST read to do its job is embedded here with filename
      // labels; the same files are also on disk for view/re-reference.
      // Source-paper and target-paper bodies are NOT inlined — the
      // agent reads them from staged bundles so its context is not
      // blown out before it starts thinking.
      const stdinPrompt = [
        promptTpl,
        "",
        "---",
        "",
        "The files below are embedded here **and** also staged on disk",
        "under the same filenames. You have already read them through",
        "this message; they are on disk for re-reference. Source paper",
        "full body (`citing/body.md`, `citing/raw.xml`) and each target",
        "paper's full bundle (`cited/<paperId>/...`) are NOT inlined —",
        "read those from disk with `view` / `bash grep` as needed.",
        "",
        "## INPUT.md",
        "",
        `Chunk ${chunk.chunkIdx + 1} of ${chunk.totalChunks} for source paper \`${chunk.citingPaperId}\`.`,
        `Target papers in this chunk: ${chunk.edges.map((e) => "`" + e.citedPaperId + "`").join(", ")}.`,
        `Claim ID: \`${claim.id}\`.`,
        `Your output is ONE report.md whose final JSON block is an ARRAY of exactly ${chunk.edges.length} EdgeJudgment entries — one per target paper.`,
        "",
        "## CLAIM.md",
        "",
        claimMd,
        "",
        "## TAXONOMIES.md",
        "",
        taxonomiesMd,
        "",
        "## SCOPE.md",
        "",
        scopeMd,
        "",
        "## CITING_PAPER.md",
        "",
        citingMd,
        "",
        "## EDGES.md",
        "",
        edgesMd,
        "",
        "## CONTRACT.md",
        "",
        contractMd,
      ].join("\n");

      try {
        const result = await runSubagentTask({
          taskType: "paper-judge",
          workspaceDir: chunkDir,
          files: inputs,
          prompt: stdinPrompt,
          outputFilename: "report.md",
          schema: ChunkOutputSchema,
          cli: values.cli as "copilot",
          model: values.model,
          // Timeout is the actual safety net. Agents are allowed to
          // self-continue as many times as they need within the wall
          // budget. maxAutopilotContinues is set high enough to be
          // effectively unbounded (50 = more iterations than any
          // well-behaved chunk should need).
          timeoutMs: 30 * 60 * 1000,
          availableTools: ["bash", "view", "create", "edit", "report_intent", "task_complete"],
          maxAutopilotContinues: 50,
          progress,
          runId,
          semaphore,
          promptVersion: PROMPT_VERSION,
          contractVersion: CONTRACT_VERSION,
        });

        // Scrub per-edge: sanitize inventionTypes, normalize defaults.
        const scrubbed = result.json.map((ej) => ({
          edgeId: ej.edgeId,
          citingPaperId: ej.citingPaperId,
          citedPaperId: ej.citedPaperId,
          claimId: ej.claimId,
          missedOccurrences: ej.missedOccurrences ?? [],
          edgeSummary: ej.edgeSummary,
          occurrenceJudgments: ej.occurrenceJudgments.map((o) => ({
            occurrenceId: o.occurrenceId,
            onClaim: o.onClaim,
            relevance: o.relevance,
            role: o.role ?? null,
            inventionType: o.inventionType && validInventionIds.has(o.inventionType) ? o.inventionType : null,
            citingEvidence: o.citingEvidence ?? [],
            citedEvidence: o.citedEvidence ?? [],
            rationale: o.rationale,
            confidence: o.confidence,
          })),
        }));

        const provenance = {
          agent: "copilot",
          model: values.model!,
          promptVersion: PROMPT_VERSION,
          contractVersion: CONTRACT_VERSION,
          invocationId: result.subagent.invocationId,
          timestamp: new Date().toISOString(),
          latencyMs: result.subagent.latencyMs,
        };
        await mkdir(chunkDir, { recursive: true });
        await writeFile(chunkJsonPath, JSON.stringify({ edgeJudgments: scrubbed, provenance }, null, 2) + "\n", "utf8");
        await writeFile(join(chunkDir, "report.md"), result.reportMarkdown, "utf8");
        await writeFile(cacheKeyPath, cacheKey + "\n", "utf8");
        for (const ej of scrubbed) allEdgeJudgments.push({ ...ej, provenance });
        done++;
        if (done % 25 === 0 || done === toProcess.length) await emitProgress(progress, runId, done, toProcess.length, cached, failed);
      } catch (e) {
        failed++;
        done++;
        await progress.emit({
          runId,
          kind: "note",
          taskType: "paper-judge",
          message: `${chunkId} FAILED: ${(e as Error).message.slice(0, 200)} (${done}/${toProcess.length})`,
        });
      }
    })()
  ));

  // Write outputs
  await mkdir(outDir, { recursive: true });
  const edgeJsonl = join(outDir, "edge-judgments.jsonl");
  await writeFile(edgeJsonl, allEdgeJudgments.map((e) => JSON.stringify(e)).join("\n") + (allEdgeJudgments.length ? "\n" : ""), "utf8");

  // Derive OccurrenceJudgment records for downstream edge-aggregate.
  const occurrenceJudgments: OccurrenceJudgment[] = [];
  for (const ej of allEdgeJudgments) {
    for (const o of ej.occurrenceJudgments) {
      const label = {
        role: (o.role ?? "unclear") as OccurrenceJudgment["role"],
        inventionType: o.inventionType ?? undefined,
        relevance: o.relevance,
        citingEvidence: o.citingEvidence,
        citedEvidence: o.citedEvidence,
        rationale: o.rationale,
        confidence: o.confidence,
        provenance: ej.provenance as any,
      };
      occurrenceJudgments.push({
        occurrenceId: o.occurrenceId,
        claimId: ej.claimId,
        role: label.role,
        inventionType: label.inventionType,
        relevance: label.relevance,
        confidence: o.confidence,
        citingEvidence: label.citingEvidence,
        citedEvidence: label.citedEvidence,
        rationale: label.rationale,
        needsReview: false,
      });
    }
  }
  const judgmentsJsonl = join(outDir, "judgments.jsonl");
  await writeFile(judgmentsJsonl, occurrenceJudgments.map((j) => JSON.stringify(j)).join("\n") + (occurrenceJudgments.length ? "\n" : ""), "utf8");

  const dominantHist: Record<string, number> = {};
  let mixed = 0, withInvention = 0;
  // Aggregate per-chunk latency so we can evaluate whether the
  // 30-min timeout is adequate and whether concurrency is tuned well.
  const latencies: number[] = [];
  const seenInvocations = new Set<string>();
  for (const e of allEdgeJudgments) {
    dominantHist[e.edgeSummary.dominantRole] = (dominantHist[e.edgeSummary.dominantRole] ?? 0) + 1;
    if (e.edgeSummary.mixedSignal) mixed++;
    if (e.edgeSummary.hasInvention) withInvention++;
    const prov = e.provenance as { invocationId?: string; latencyMs?: number } | undefined;
    if (prov?.invocationId && !seenInvocations.has(prov.invocationId)) {
      seenInvocations.add(prov.invocationId);
      if (typeof prov.latencyMs === "number") latencies.push(prov.latencyMs);
    }
  }
  latencies.sort((a, b) => a - b);
  const p = (q: number): number => {
    if (latencies.length === 0) return 0;
    return latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;
  };
  const latencyStats = {
    count: latencies.length,
    p50_ms: p(0.5),
    p90_ms: p(0.9),
    p99_ms: p(0.99),
    max_ms: latencies.at(-1) ?? 0,
    mean_ms: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
  };
  const report = [
    `# paper-judge report`,
    ``,
    `Chunks processed: **${toProcess.length}** (cached ${cached}, failed ${failed}).`,
    `Edges produced: **${allEdgeJudgments.length}** (expected ${chunks.reduce((n, c) => n + c.edges.length, 0)}).`,
    `Occurrence judgments: **${occurrenceJudgments.length}**.`,
    ``,
    `## Dominant role histogram`,
    ``,
    ...Object.entries(dominantHist).sort(([, a], [, b]) => b - a).map(([r, n]) => `- ${r}: ${n}`),
    ``,
    `Mixed-signal edges: **${mixed}**`,
    `Edges with invention tag: **${withInvention}**`,
    ``,
    `## Per-chunk processing time`,
    ``,
    `Chunks with latency recorded: ${latencyStats.count}`,
    `- mean: ${Math.round(latencyStats.mean_ms/1000)}s`,
    `- p50: ${Math.round(latencyStats.p50_ms/1000)}s`,
    `- p90: ${Math.round(latencyStats.p90_ms/1000)}s`,
    `- p99: ${Math.round(latencyStats.p99_ms/1000)}s`,
    `- max: ${Math.round(latencyStats.max_ms/1000)}s (timeout is 30 min = 1800s — flag if p99 > 50% of that)`,
    ``,
    "```json",
    JSON.stringify({
      chunks: toProcess.length, cached, failed,
      edges: allEdgeJudgments.length,
      occurrenceJudgments: occurrenceJudgments.length,
      dominantHist, mixed, withInvention,
      latencyStats,
    }, null, 2),
    "```",
    ``,
  ].join("\n");
  await writeArtifact({
    id: `paper-judge.${claim.id}`,
    kind: "paper-judge",
    markdownPath: join(outDir, "report.md"),
    jsonPath: join(outDir, "summary.json"),
    markdown: report,
    json: {
      chunks: toProcess.length, cached, failed,
      edges: allEdgeJudgments.length,
      occurrenceJudgments: occurrenceJudgments.length,
      dominantHist, mixed, withInvention,
      latencyStats,
    },
    frontmatter: {
      task: "paper-judge",
      status: failed > 0 ? "needs-review" : "ok",
      inputs: [claimPath, occPath, profilesPath],
      json: "summary.json",
    },
  });

  await progress.emit({
    runId,
    kind: "task-success",
    taskType: "paper-judge",
    message: `${toProcess.length} chunks, ${allEdgeJudgments.length} edges, ${occurrenceJudgments.length} occurrence judgments (cached ${cached}, failed ${failed})`,
    data: { dominantHist, mixed, withInvention },
  });

  console.log(`[paper-judge] ${toProcess.length} chunks → ${allEdgeJudgments.length} edges, ${occurrenceJudgments.length} occurrence judgments`);
  console.log(`[paper-judge] dominant: ${JSON.stringify(dominantHist)}  mixed=${mixed}  invention=${withInvention}`);
  console.log(`[paper-judge] registry: ${edgeJsonl}`);
  console.log(`[paper-judge] judgments: ${judgmentsJsonl}`);
}

async function emitProgress(progress: ProgressLog, runId: string, done: number, total: number, cached: number, failed: number): Promise<void> {
  await progress.emit({
    runId,
    kind: "note",
    taskType: "paper-judge",
    message: `chunks ${done}/${total} (cached ${cached}, failed ${failed})`,
  });
}

function chunkCacheHash(claimId: string, chunk: { citingPaperId: string; chunkIdx: number; edges: Array<{ citedPaperId: string; occurrences: readonly CitationOccurrenceRecord[] }> }): string {
  const h = createHash("sha256");
  h.update(claimId + "|" + chunk.citingPaperId + "|" + chunk.chunkIdx);
  // Order-independent within the chunk (edges already sorted by caller).
  for (const e of chunk.edges) {
    h.update("|" + e.citedPaperId + ":");
    const parts = e.occurrences.map((o) => `${o.occurrenceId}=${o.sentence.slice(0, 160)}`).sort();
    h.update(parts.join("|"));
  }
  return h.digest("hex");
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function tryStageJats(papersDir: string, paperId: string, label: string): Promise<PreparedFile[]> {
  const base = join(papersDir, paperId);
  const files: PreparedFile[] = [];
  const addIfExists = async (relSrc: string, relDest: string) => {
    try {
      await stat(join(base, relSrc));
      files.push({ name: `${label}/${relDest}`, srcPath: join(base, relSrc) });
    } catch {
      // skip
    }
  };
  await addIfExists("raw.xml", "raw.xml");
  await addIfExists("references.json", "references.json");
  await addIfExists("sections.json", "sections.json");
  await addIfExists("body.md", "body.md");
  return files;
}

function renderClaimMd(claim: ResolvedClaimPack): string {
  return [
    `# Focal claim`,
    ``,
    `**Canonical:** ${claim.canonicalClaim}`,
    ``,
    `**Claim ID:** \`${claim.id}\``,
    `**Year window:** ${claim.years[0]}–${claim.years[1]}`,
    ``,
    claim.aliases.length ? ["## Aliases", "", ...claim.aliases.map((a) => `- ${a}`), ""].join("\n") : "",
    claim.subclaims.length
      ? ["## Subclaims", "", ...claim.subclaims.map((s) => `- \`${s.id}\`: ${s.text}`), ""].join("\n")
      : "",
    claim.hints.judge
      ? ["## Judge hints (claim-specific guidance)", "", claim.hints.judge, ""].join("\n")
      : "",
    claim.reviewerNotes ? ["## Reviewer notes", "", claim.reviewerNotes, ""].join("\n") : "",
  ].filter(Boolean).join("\n");
}

function renderInventionTaxonomyMd(resolved: ResolvedClaimPack): string {
  const lines: string[] = [];
  lines.push("# Invention sub-types for this run");
  lines.push("");
  if (resolved.inventionTypes.length === 0) {
    lines.push("_No invention sub-types for this run._ Leave `inventionType` absent on all occurrences.");
    return lines.join("\n");
  }
  lines.push("Use at most one `inventionType` per occurrence from the kebab-case ids below — ONLY when the citation clearly exhibits that distortion.");
  lines.push("");
  for (const t of resolved.inventionTypes) {
    lines.push(`- \`${t.id}\` — **${t.label}**: ${t.definition}`);
    if (t.examples?.length) for (const ex of t.examples.slice(0, 3)) lines.push(`  - e.g. ${ex}`);
  }
  return lines.join("\n");
}

function renderCitingPaperMd(
  paperId: string,
  profile: PaperProfile | undefined,
  edges: readonly { citedPaperId: string; occurrences: readonly CitationOccurrenceRecord[] }[],
): string {
  const lines: string[] = [];
  lines.push(`# Source (citing) paper — profile only`);
  lines.push("");
  lines.push(`**Paper ID:** \`${paperId}\``);
  if (profile) {
    lines.push(`**Relevance (paper-profile):** ${profile.relevant} (${profile.relevance.toFixed(2)})`);
    lines.push(`**Evidence class:** ${profile.evidenceClass}`);
    lines.push(`**Intrinsic stance:** ${profile.intrinsicStance}`);
    if (profile.rationale) lines.push(`**Paper-profile rationale:** ${profile.rationale}`);
    lines.push("");
    lines.push(`> The profile above is a one-pass classifier's output with its own rationale and up-to-5 example claim spans. It is a **pointer**, not a substitute for reading the paper. Read the full body yourself:`);
  }
  lines.push("");
  lines.push("```");
  lines.push(`view citing/body.md                     # full markdown body`);
  lines.push(`bash "grep -n 'keyword' citing/body.md" # find citation sites`);
  lines.push(`view citing/sections.json               # section structure with inline markers`);
  lines.push(`view citing/raw.xml                     # full JATS XML`);
  lines.push("```");
  lines.push("");
  lines.push(`## Target (cited) papers in this chunk (${edges.length})`);
  lines.push("");
  for (const e of edges) {
    lines.push(`- \`${e.citedPaperId}\` — ${e.occurrences.length} pre-extracted citation site${e.occurrences.length === 1 ? "" : "s"}; bundle at \`cited/${e.citedPaperId}/\``);
  }
  return lines.join("\n");
}

function renderScopeMd(
  citingPaperId: string,
  edges: readonly { citedPaperId: string; occurrences: readonly CitationOccurrenceRecord[] }[],
): string {
  const lines: string[] = [];
  lines.push(`# Scope of this chunk`);
  lines.push("");
  lines.push(`**Source paper (citing):** \`${citingPaperId}\``);
  lines.push(`  Full bundle staged under \`citing/\` (raw.xml, body.md, sections.json, references.json).`);
  lines.push("");
  lines.push(`**Target papers (cited) — ${edges.length} in this chunk:**`);
  lines.push("");
  for (const e of edges) {
    lines.push(`- \`${e.citedPaperId}\` — ${e.occurrences.length} pre-extracted occurrence${e.occurrences.length === 1 ? "" : "s"}; full bundle staged under \`cited/${e.citedPaperId}/\`.`);
  }
  lines.push("");
  lines.push(`**Your job**: for each source→target edge in this chunk, for each pre-extracted occurrence on that edge, decide onClaim + role + optional inventionType. The pre-extracted occurrences in EDGES.md are QUICK HINTS (citing sentence + paragraph). They tell you *where* in the source paper each citation sits — but you should still read the source paper's overall argument (\`citing/body.md\`, \`citing/raw.xml\`) AND each target paper's body (\`cited/<paperId>/body.md\`) yourself to verify what the source claims about each target.`);
  lines.push("");
  lines.push(`Use bash/view/grep to explore. Example workflows:`);
  lines.push("");
  lines.push("```");
  lines.push(`# See the source paper's overall stance and structure`);
  lines.push(`view citing/body.md`);
  lines.push("");
  lines.push(`# Find where a specific cited paper is discussed`);
  lines.push(`bash "grep -n 'Gautret\\|\\[12\\]' citing/body.md"`);
  lines.push("");
  lines.push(`# Read a target paper's key sections`);
  lines.push(`view cited/<paperId>/body.md`);
  lines.push(`bash "grep -n 'mortality\\|hazard ratio\\|primary outcome' cited/<paperId>/body.md"`);
  lines.push("");
  lines.push(`# For numerical claims, drill into tables / supplementary`);
  lines.push(`bash "grep -n 'Table\\|95%' cited/<paperId>/body.md | head -30"`);
  lines.push("```");
  return lines.join("\n");
}

function renderEdgesMd(
  citingPaperId: string,
  edges: readonly { citedPaperId: string; occurrences: readonly CitationOccurrenceRecord[] }[],
): string {
  const lines: string[] = [];
  lines.push(`# Pre-extracted occurrence hints`);
  lines.push("");
  lines.push(`For each edge in this chunk, a QUICK LIST of where the source paper cites the target paper — the citing sentence + surrounding paragraph that structural extraction found. Treat as pointers, not ground truth. You MUST read both papers yourself (via \`view\` / \`bash grep\`) before judging.`);
  lines.push("");
  for (const e of edges) {
    lines.push(`## Edge: \`${citingPaperId}\` → \`${e.citedPaperId}\``);
    lines.push("");
    lines.push(`Edge ID: \`edge-${citingPaperId}-to-${e.citedPaperId}\``);
    lines.push(`Target paper bundle: \`cited/${e.citedPaperId}/\``);
    lines.push("");
    lines.push(`### Pre-extracted occurrences (${e.occurrences.length})`);
    lines.push("");
    for (const o of e.occurrences) {
      lines.push(`#### \`${o.occurrenceId}\` (section: ${o.section ?? "?"})`);
      lines.push("");
      lines.push(`**Citing sentence:**`);
      lines.push("> " + o.sentence.replace(/\n/g, "\n> "));
      lines.push("");
      lines.push(`**Surrounding paragraph (hint only — view citing/body.md for full context):**`);
      lines.push("> " + o.paragraph.replace(/\n/g, "\n> "));
      lines.push("");
      if (o.groupedCitations.length > 0) {
        lines.push(`Grouped with: ${o.groupedCitations.map((g) => `\`${g}\``).join(", ")}`);
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
