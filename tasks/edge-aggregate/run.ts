// edge-aggregate: collapse per-occurrence judgments into paper→paper
// EdgeBundles . Dominant role is the plurality winner with
// supportive/critical breaking ties over neutral/unclear. Mixed-signal
// edges (supportive ∧ critical occurrences) are flagged for audit.

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import {
  EdgeBundleSchema,
  type EdgeBundle,
  type OccurrenceJudgment,
  type OccurrenceRole,
  type CitationOccurrenceRecord,
  type SubclaimLabel,
} from "../../contracts/index.ts";
import { writeArtifact } from "../../lib/artifacts.ts";
import { ProgressLog } from "../../orchestrator/progress.ts";

const ROLE_WEIGHTS: Record<OccurrenceRole, number> = {
  supportive: 3,
  critical: 3,
  mixed: 2,
  neutral: 1,
  unclear: 0,
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      "run-id": { type: "string" },
      "judgments-jsonl": { type: "string" },
      "occurrences-jsonl": { type: "string" },
      "subclaim-labels-jsonl": { type: "string" },  // optional overlay
      "claim-id": { type: "string" },
    },
  });
  const outDir = values["out-dir"];
  const judPath = values["judgments-jsonl"];
  const occPath = values["occurrences-jsonl"];
  if (!outDir || !judPath || !occPath) {
    console.error("usage: --out-dir <dir> --judgments-jsonl <path> --occurrences-jsonl <path> [--subclaim-labels-jsonl <path>] [--claim-id ID]");
    process.exit(2);
  }
  const runId = values["run-id"] ?? "ad-hoc";
  const progress = new ProgressLog(join(outDir, "..", "progress.jsonl"));

  const judgments = (await readJsonl(judPath)) as OccurrenceJudgment[];
  const occurrences = (await readJsonl(occPath)) as CitationOccurrenceRecord[];
  const occById = new Map<string, CitationOccurrenceRecord>();
  for (const o of occurrences) occById.set(o.occurrenceId, o);
  const claimId = values["claim-id"] ?? judgments[0]?.claimId ?? "unknown-claim";

  // Merge optional subclaim-label overlay. Mutates each judgment's
  // subclaimIds in-place so the existing per-edge loop sees them.
  const subclaimPath = values["subclaim-labels-jsonl"];
  if (subclaimPath) {
    const labels = (await readJsonl(subclaimPath)) as SubclaimLabel[];
    const byOcc = new Map(labels.map((l) => [l.occurrenceId, l.subclaimIds]));
    for (const j of judgments) {
      const ids = byOcc.get(j.occurrenceId);
      if (ids !== undefined) j.subclaimIds = ids;
    }
  }

  await progress.emit({
    runId,
    kind: "task-start",
    taskType: "edge-aggregate",
    message: `${judgments.length} judgments, claim=${claimId}`,
  });

  // Group judgments by (citingPaperId, citedPaperId), joined via occurrence record.
  const byEdge = new Map<string, { citing: string; cited: string; judgments: OccurrenceJudgment[] }>();
  let missing = 0;
  for (const j of judgments) {
    const occ = occById.get(j.occurrenceId);
    if (!occ) { missing++; continue; }
    const k = `${occ.citingPaperId}→${occ.citedPaperId}`;
    const bucket = byEdge.get(k) ?? { citing: occ.citingPaperId, cited: occ.citedPaperId, judgments: [] };
    bucket.judgments.push(j);
    byEdge.set(k, bucket);
  }

  const edges: EdgeBundle[] = [];
  for (const [, bucket] of byEdge) {
    const counts: Record<OccurrenceRole, number> = {
      supportive: 0, critical: 0, neutral: 0, mixed: 0, unclear: 0,
    };
    const inventionCounts: Record<string, number> = {};
    const rolesBySubclaim: Record<string, Record<OccurrenceRole, number>> = {};
    let confSum = 0;
    let confCount = 0;
    for (const o of bucket.judgments) {
      counts[o.role] = (counts[o.role] ?? 0) + 1;
      confSum += o.confidence;
      confCount++;
      const inv = (o as { inventionType?: string | null }).inventionType;
      if (inv) inventionCounts[inv] = (inventionCounts[inv] ?? 0) + 1;
      // Per-subclaim tally. Skip occurrences without labels so we
      // don't over-count; downstream metrics understand an empty
      // rolesBySubclaim.
      const subIds = o.subclaimIds ?? [];
      for (const sid of subIds) {
        if (!rolesBySubclaim[sid]) {
          rolesBySubclaim[sid] = { supportive: 0, critical: 0, neutral: 0, mixed: 0, unclear: 0 };
        }
        rolesBySubclaim[sid][o.role] = (rolesBySubclaim[sid][o.role] ?? 0) + 1;
      }
    }
    const dominantRole = pickDominant(counts);
    const mixedSignal = counts.supportive > 0 && counts.critical > 0;
    const edge: EdgeBundle = EdgeBundleSchema.parse({
      edgeId: `edge-${bucket.citing}-to-${bucket.cited}`,
      claimId,
      citingPaperId: bucket.citing,
      citedPaperId: bucket.cited,
      dominantRole,
      occurrenceIds: bucket.judgments.map((o) => o.occurrenceId),
      roleCounts: counts,
      confidence: confCount > 0 ? confSum / confCount : 0,
      mixedSignal,
      inventionTypes: Object.keys(inventionCounts).sort(),
      inventionCounts,
      rolesBySubclaim,
    });
    edges.push(edge);
  }

  // Persist
  const jsonlPath = join(outDir, "edges.jsonl");
  await writeJsonl(jsonlPath, edges);
  const csvPath = join(outDir, "edges.csv");
  await writeCsv(csvPath, edges);

  const roleHist: Record<string, number> = {};
  const inventionHist: Record<string, number> = {};
  let mixedCount = 0;
  let withInventionCount = 0;
  for (const e of edges) {
    roleHist[e.dominantRole] = (roleHist[e.dominantRole] ?? 0) + 1;
    if (e.mixedSignal) mixedCount++;
    if (e.inventionTypes.length > 0) withInventionCount++;
    for (const [id, n] of Object.entries(e.inventionCounts)) {
      inventionHist[id] = (inventionHist[id] ?? 0) + n;
    }
  }

  const report = [
    `# edge-aggregate report`,
    ``,
    `Judgments in: **${judgments.length}**  `,
    `Unique edges: **${edges.length}**  `,
    `Mixed-signal edges (supportive ∧ critical): **${mixedCount}**  `,
    `Edges carrying any invention flag: **${withInventionCount}**`,
    ``,
    `## Dominant role`,
    ``,
    ...Object.entries(roleHist).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Invention types (occurrence-level counts)`,
    ``,
    ...(Object.keys(inventionHist).length > 0
      ? Object.entries(inventionHist).map(([k, v]) => `- ${k}: ${v}`)
      : ["_(none flagged)_"]),
    ``,
    "```json",
    JSON.stringify({ edges: edges.length, mixed: mixedCount, withInvention: withInventionCount, roleHist, inventionHist }, null, 2),
    "```",
    ``,
  ].join("\n");

  await writeArtifact({
    id: `edge-aggregate.${claimId}`,
    kind: "edge-aggregate",
    markdownPath: join(outDir, "report.md"),
    jsonPath: join(outDir, "edges.json"),
    markdown: report,
    json: { claimId, count: edges.length, edges },
    frontmatter: {
      task: "edge-aggregate",
      status: "ok",
      inputs: [judPath],
      json: "edges.json",
    },
  });

  await progress.emit({
    runId,
    kind: "task-success",
    taskType: "edge-aggregate",
    message: `${edges.length} edges`,
    data: { mixed: mixedCount, roleHist },
  });

  console.log(`[edge-aggregate] ${edges.length} edges (mixed=${mixedCount}, roles=${JSON.stringify(roleHist)})`);
}

function pickDominant(counts: Record<OccurrenceRole, number>): OccurrenceRole {
  // Weighted plurality: weight x count. Supportive and critical share the
  // top weight so a single supportive beats any number of neutrals.
  let best: OccurrenceRole = "unclear";
  let bestScore = -1;
  for (const [role, n] of Object.entries(counts) as Array<[OccurrenceRole, number]>) {
    const score = n * (ROLE_WEIGHTS[role] ?? 0);
    if (score > bestScore) {
      best = role;
      bestScore = score;
    }
  }
  return best;
}


async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

async function writeCsv(path: string, edges: EdgeBundle[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const header = "edgeId,citingPaperId,citedPaperId,dominantRole,supportive,critical,neutral,mixed,unclear,confidence,mixedSignal";
  const rows = edges.map((e) =>
    [
      e.edgeId,
      e.citingPaperId,
      e.citedPaperId,
      e.dominantRole,
      e.roleCounts.supportive ?? 0,
      e.roleCounts.critical ?? 0,
      e.roleCounts.neutral ?? 0,
      e.roleCounts.mixed ?? 0,
      e.roleCounts.unclear ?? 0,
      e.confidence.toFixed(3),
      e.mixedSignal,
    ].join(","),
  );
  await writeFile(path, [header, ...rows].join("\n") + "\n", "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
