// graph-analyze: compute authority scores + pipeline-declared analyses
// from edges + paper profiles, producing a GraphBundle.
//
// Analyses are generated deterministically from the resolved claim
// pack (catalog merge + default-analysis generation in
// contracts/resolve.ts). graph-analyze does not decide WHICH metrics
// to compute or what to label them — it dispatches by template id.

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import {
  ClaimPackSchema,
  GraphBundleSchema,
  PaperProfileSchema,
  PaperRegistryRowSchema,
  type EdgeBundle,
  type GraphBundle,
  type GraphNode,
  type AnalysisResult,
  type AnalysisSpec,
  type ClaimPack,
  type OccurrenceRole,
  type PaperProfile,
  type PaperRegistryRow,
  type ResolvedClaimPack,
} from "../../contracts/index.ts";
import { resolveClaimPack } from "../../contracts/resolve.ts";
import { TEMPLATES, type MetricContext } from "../../lib/metric-templates.ts";
import { writeArtifact } from "../../lib/artifacts.ts";
import { ProgressLog } from "../../orchestrator/progress.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      "run-id": { type: "string" },
      "profiles-jsonl": { type: "string" },
      "registry-jsonl": { type: "string" },
      "edges-jsonl": { type: "string" },
      "claim-json": { type: "string" },
    },
  });
  const outDir = values["out-dir"];
  const profilesPath = values["profiles-jsonl"];
  const registryPath = values["registry-jsonl"];
  const edgesPath = values["edges-jsonl"];
  const claimPath = values["claim-json"];
  if (!outDir || !profilesPath || !registryPath || !edgesPath || !claimPath) {
    console.error("usage: --out-dir <dir> --profiles-jsonl <path> --registry-jsonl <path> --edges-jsonl <path> --claim-json <path>");
    process.exit(2);
  }
  const runId = values["run-id"] ?? "ad-hoc";
  const progress = new ProgressLog(join(outDir, "..", "progress.jsonl"));

  const claim = ClaimPackSchema.parse(JSON.parse(await readFile(claimPath, "utf8"))) as ClaimPack;
  const resolved = resolveClaimPack(claim);
  const profiles = (await readJsonl(profilesPath)).map((p) => PaperProfileSchema.parse(p)) as PaperProfile[];
  const registry = (await readJsonl(registryPath)).map((r) => PaperRegistryRowSchema.parse(r)) as PaperRegistryRow[];
  const registryById = new Map(registry.map((r) => [r.paperId, r]));
  const edges = (await readJsonl(edgesPath)) as EdgeBundle[];

  await progress.emit({
    runId,
    kind: "task-start",
    taskType: "graph-analyze",
    message: `profiles=${profiles.length} edges=${edges.length} analyses=${resolved.analyses.length}`,
  });

  const profileById = new Map(profiles.map((p) => [p.paperId, p]));
  const relevantProfiles = profiles.filter((p) => p.relevant);
  const relevantIds = new Set(relevantProfiles.map((p) => p.paperId));

  // Keep edges where the CITING paper is relevant. The cited paper
  // is allowed to be off-claim — that's where dead-end invention
  // lives: a relevant paper citing an off-claim paper in support of
  // the claim is exactly a dead-end citation, which paper-judge
  // flags and we very much want to surface, not filter out.
  const graphEdges = edges.filter((e) => relevantIds.has(e.citingPaperId));

  // Node set: all relevant papers, plus any off-claim papers that
  // receive a citation from a relevant paper (so dead-end edges
  // have real endpoints).
  const citedOffClaimIds = new Set<string>();
  for (const e of graphEdges) {
    if (!relevantIds.has(e.citedPaperId)) citedOffClaimIds.add(e.citedPaperId);
  }
  const nodeProfiles = [
    ...relevantProfiles,
    ...profiles.filter((p) => citedOffClaimIds.has(p.paperId)),
  ];

  // Build graph nodes.
  const nodes: GraphNode[] = [];
  const missingMeta: string[] = [];
  for (const p of nodeProfiles) {
    const r = registryById.get(p.paperId);
    if (!r) { missingMeta.push(p.paperId); continue; }
    nodes.push({
      paperId: p.paperId,
      profile: p,
      year: r.year,
      title: r.title,
      authors: r.authors,
      venue: r.venue,
      ids: r.ids,
      retracted: r.retracted?.isRetracted,
    });
  }
  if (missingMeta.length > 0) {
    console.warn(`[graph-analyze] warning: ${missingMeta.length} profiles had no registry row (dropped from graph)`);
  }

  // Authority via supportive in-degree + PageRank.
  const inDegree = new Map<string, number>();
  const supportiveInDegree = new Map<string, number>();
  for (const id of relevantIds) {
    inDegree.set(id, 0);
    supportiveInDegree.set(id, 0);
  }
  for (const e of graphEdges) {
    inDegree.set(e.citedPaperId, (inDegree.get(e.citedPaperId) ?? 0) + 1);
    if (e.dominantRole === "supportive") {
      supportiveInDegree.set(e.citedPaperId, (supportiveInDegree.get(e.citedPaperId) ?? 0) + 1);
    }
  }
  const pr = pageRank(Array.from(relevantIds), graphEdges);
  const maxSupIn = Math.max(1, ...Array.from(supportiveInDegree.values()));
  const maxPr = Math.max(1e-9, ...Array.from(pr.values()));
  const authority = Array.from(relevantIds).map((id) => {
    const s = (supportiveInDegree.get(id) ?? 0) / maxSupIn;
    const p = (pr.get(id) ?? 0) / maxPr;
    const score = 0.6 * s + 0.4 * p;
    return {
      paperId: id,
      authorityScore: score,
      isAuthority: score > 0.5,
      supportiveInDegree: supportiveInDegree.get(id) ?? 0,
      totalInDegree: inDegree.get(id) ?? 0,
      pageRank: pr.get(id) ?? 0,
    };
  });

  // Orphans.
  const connected = new Set<string>();
  for (const e of graphEdges) {
    connected.add(e.citingPaperId);
    connected.add(e.citedPaperId);
  }
  const orphans = Array.from(relevantIds).filter((id) => !connected.has(id));

  // Run declared analyses (global + one scope per subclaim).
  const analyses = runAnalyses(resolved, graphEdges, profileById);

  // Global edge-role totals (denominator info for the viewer).
  const edgeTotals: Record<OccurrenceRole, number> = {
    supportive: 0, critical: 0, neutral: 0, mixed: 0, unclear: 0,
  };
  for (const e of graphEdges) edgeTotals[e.dominantRole]++;

  const bundle: GraphBundle = GraphBundleSchema.parse({
    graphId: `graph-${claim.id}-${Date.now()}`,
    claimId: claim.id,
    runId,
    papers: nodes,
    edges: graphEdges,
    orphanPaperIds: orphans,
    analyses,
    edgeTotals,
    authority,
  });

  await writeArtifact({
    id: bundle.graphId,
    kind: "graph-bundle",
    markdownPath: join(outDir, "report.md"),
    jsonPath: join(outDir, "graph.json"),
    markdown: renderReport(bundle, edges.length - graphEdges.length),
    json: bundle,
    frontmatter: {
      task: "graph-analyze",
      status: "ok",
      inputs: [profilesPath, registryPath, edgesPath, claimPath],
      json: "graph.json",
    },
  });

  const topAuth = [...authority].sort((a, b) => b.authorityScore - a.authorityScore).slice(0, 10);
  await writeFile(
    join(outDir, "top-authorities.json"),
    JSON.stringify({ topAuthorities: topAuth.map((a) => ({ ...a, profile: profileById.get(a.paperId) })) }, null, 2) + "\n",
    "utf8",
  );

  await progress.emit({
    runId,
    kind: "task-success",
    taskType: "graph-analyze",
    message: `graph: ${bundle.papers.length} papers, ${bundle.edges.length} edges, ${authority.filter((a) => a.isAuthority).length} authorities, ${Object.keys(analyses).length} analyses`,
    data: { analyses: Object.fromEntries(Object.entries(analyses).map(([k, v]) => [k, v.value])) },
  });

  console.log(`[graph-analyze] papers=${bundle.papers.length} edges=${bundle.edges.length} orphans=${orphans.length} analyses=${Object.keys(analyses).length}`);
}

// ---------- Analysis dispatch ----------

/**
 * Run every analysis from the resolved claim pack, plus subclaim-scoped
 * variants of every analysis for each subclaim where at least one edge
 * has subclaim data. Subclaim-scoped entries are keyed `<id>@<scope>`.
 */
function runAnalyses(
  resolved: ResolvedClaimPack,
  edges: EdgeBundle[],
  profileById: Map<string, PaperProfile>,
): Record<string, AnalysisResult> {
  const out: Record<string, AnalysisResult> = {};

  const baseCtx: MetricContext = {
    edges,
    profileById,
    evidenceClass: resolved.evidenceClass,
  };
  for (const spec of resolved.analyses) {
    runOne(out, spec, baseCtx);
  }

  // Subclaim-scoped: only if any edge actually carries subclaim data.
  const observedSubclaims = new Set<string>();
  for (const e of edges) {
    for (const sid of Object.keys(e.rolesBySubclaim ?? {})) observedSubclaims.add(sid);
  }
  for (const sid of observedSubclaims) {
    const ctx: MetricContext = { ...baseCtx, scope: sid };
    for (const spec of resolved.analyses) {
      runOne(out, { ...spec, id: `${spec.id}@${sid}`, scope: sid }, ctx);
    }
  }

  return out;
}

function runOne(
  out: Record<string, AnalysisResult>,
  spec: AnalysisSpec,
  ctx: MetricContext,
): void {
  const fn = TEMPLATES[spec.template];
  if (!fn) {
    throw new Error(`analysis "${spec.id}" uses unknown template "${spec.template}"`);
  }
  const { value, denominator } = fn(spec.params, ctx);
  out[spec.id] = {
    id: spec.id,
    template: spec.template,
    params: spec.params,
    label: spec.label,
    value,
    denominator,
    scope: spec.scope,
  };
}

// ---------- PageRank ----------

function pageRank(nodes: string[], edges: EdgeBundle[], damping = 0.85, iterations = 40): Map<string, number> {
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const N = nodes.length;
  if (N === 0) return new Map();
  const out: number[][] = nodes.map(() => []);
  const outDeg: number[] = new Array(N).fill(0);
  for (const e of edges) {
    const a = idx.get(e.citingPaperId);
    const b = idx.get(e.citedPaperId);
    if (a === undefined || b === undefined) continue;
    out[a]!.push(b);
    outDeg[a]!++;
  }
  let r = new Array(N).fill(1 / N);
  for (let it = 0; it < iterations; it++) {
    const next = new Array(N).fill((1 - damping) / N);
    let danglingMass = 0;
    for (let i = 0; i < N; i++) if (outDeg[i]! === 0) danglingMass += r[i]!;
    const danglingContribution = (damping * danglingMass) / N;
    for (let i = 0; i < N; i++) {
      next[i] += danglingContribution;
      if (outDeg[i]! === 0) continue;
      const share = (damping * r[i]!) / outDeg[i]!;
      for (const j of out[i]!) next[j]! += share;
    }
    r = next;
  }
  const map = new Map<string, number>();
  for (let i = 0; i < N; i++) map.set(nodes[i]!, r[i]!);
  return map;
}

// ---------- Report ----------

function renderReport(bundle: GraphBundle, droppedEdges: number): string {
  const roleHist: Record<string, number> = {};
  for (const e of bundle.edges) roleHist[e.dominantRole] = (roleHist[e.dominantRole] ?? 0) + 1;
  const classHist: Record<string, number> = {};
  for (const p of bundle.papers) classHist[p.profile.evidenceClass] = (classHist[p.profile.evidenceClass] ?? 0) + 1;
  const authCount = bundle.authority.filter((a) => a.isAuthority).length;
  const fmt = (v: number | null | undefined): string =>
    v === null || v === undefined ? "N/A (too sparse)" : v.toFixed(3);

  const globalAnalyses: AnalysisResult[] = Object.values(bundle.analyses).filter((a) => !a.scope);
  const scopedAnalyses: AnalysisResult[] = Object.values(bundle.analyses).filter((a) => a.scope);

  const lines: string[] = [];
  lines.push(`# graph-analyze report`, ``);
  lines.push(`Relevant papers: **${bundle.papers.length}**  `);
  lines.push(`Graph edges: **${bundle.edges.length}** (dropped ${droppedEdges} edges touching irrelevant nodes)  `);
  lines.push(`Orphan relevant papers: **${bundle.orphanPaperIds.length}**  `);
  lines.push(`Authority nodes (score > 0.5): **${authCount}**`, ``);

  lines.push(`## Edge totals`, ``);
  for (const [k, v] of Object.entries(bundle.edgeTotals)) lines.push(`- ${k}: ${v}`);
  lines.push(``);

  lines.push(`## Edge role distribution (dominantRole)`, ``);
  for (const [k, v] of Object.entries(roleHist)) lines.push(`- ${k}: ${v}`);
  lines.push(``);

  lines.push(`## Paper evidence classes`, ``);
  for (const [k, v] of Object.entries(classHist)) lines.push(`- ${k}: ${v}`);
  lines.push(``);

  lines.push(`## Analyses (global)`, ``);
  for (const a of globalAnalyses) {
    const denom = typeof a.denominator === "number" ? ` (denom=${a.denominator})` : "";
    lines.push(`- **${a.label}** \`[${a.id}]\`: ${fmt(a.value)}${denom}`);
  }

  if (scopedAnalyses.length > 0) {
    lines.push(``, `## Analyses (per subclaim)`, ``);
    const byScope = new Map<string, AnalysisResult[]>();
    for (const a of scopedAnalyses) {
      if (!byScope.has(a.scope!)) byScope.set(a.scope!, []);
      byScope.get(a.scope!)!.push(a);
    }
    for (const [sid, arr] of byScope) {
      lines.push(`### \`${sid}\``);
      for (const a of arr) {
        const denom = typeof a.denominator === "number" ? ` (denom=${a.denominator})` : "";
        lines.push(`- **${a.label}**: ${fmt(a.value)}${denom}`);
      }
      lines.push(``);
    }
  }

  lines.push(``, "```json");
  lines.push(JSON.stringify({
    papers: bundle.papers.length,
    edges: bundle.edges.length,
    authorities: authCount,
    orphans: bundle.orphanPaperIds.length,
    analyses: Object.fromEntries(Object.entries(bundle.analyses).map(([k, v]) => [k, { value: v.value, denominator: v.denominator }])),
  }, null, 2));
  lines.push("```", ``);
  return lines.join("\n");
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
