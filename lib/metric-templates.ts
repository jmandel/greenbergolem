// Metric template catalog. Each template is a named, parameterized
// formula that graph-analyze dispatches to based on the resolved
// claim pack's `analyses[]`. Adding a template = adding a function
// here + documenting it in the research playbook.

import type { EdgeBundle } from "../contracts/graph.ts";
import type { PaperProfile } from "../contracts/paper.ts";
import type { TaxonomyTerm } from "../contracts/taxonomy.ts";
import type { OccurrenceRole } from "../contracts/occurrence.ts";

/** Context every template gets. Immutable. */
export interface MetricContext {
  edges: readonly EdgeBundle[];
  profileById: ReadonlyMap<string, PaperProfile>;
  evidenceClass: readonly TaxonomyTerm[];
  /** Optional subclaim scope: if set, metrics use rolesBySubclaim[scope]. */
  scope?: string;
}

export interface TemplateResult {
  value: number | null;
  denominator?: number;
}

export type TemplateFn = (params: Record<string, unknown>, ctx: MetricContext) => TemplateResult;

// ---------- Helpers ----------

const MIN_SUPPORTIVE_FOR_RATIOS = 10;
const MIN_SUPPORTIVE_FOR_CONCENTRATION = 15;
const MIN_STANCE_EDGES_FOR_STARVATION = 10;

function roleFor(edge: EdgeBundle, scope?: string): OccurrenceRole | undefined {
  if (!scope) return edge.dominantRole;
  const counts = edge.rolesBySubclaim?.[scope];
  if (!counts) return undefined;
  const order: OccurrenceRole[] = ["supportive", "critical", "mixed", "neutral", "unclear"];
  let best: OccurrenceRole | undefined;
  let bestN = -1;
  for (const r of order) {
    const n = counts[r] ?? 0;
    if (n > bestN) { best = r; bestN = n; }
  }
  return bestN > 0 ? best : undefined;
}

function groupOf(id: string, ctx: MetricContext): string | undefined {
  return ctx.evidenceClass.find((t) => t.id === id)?.group;
}

function countEdgesByRole(ctx: MetricContext): Record<OccurrenceRole, number> {
  const out: Record<OccurrenceRole, number> = {
    supportive: 0, critical: 0, neutral: 0, mixed: 0, unclear: 0,
  };
  for (const e of ctx.edges) {
    const r = roleFor(e, ctx.scope);
    if (r) out[r]++;
  }
  return out;
}

// ---------- Templates ----------

/**
 * `within-group-supportive-share`
 * params: { group: string }
 * Value: |supportive edges where citing.group = X AND cited.group = X| /
 *        |supportive edges (global)|
 *
 * Detects within-group citation concentration — Greenberg's lens
 * effect when X is an amplifier group.
 */
const withinGroupSupportiveShare: TemplateFn = (params, ctx) => {
  const gid = String(params.group ?? "");
  const sup = ctx.edges.filter((e) => roleFor(e, ctx.scope) === "supportive");
  if (sup.length < MIN_SUPPORTIVE_FOR_RATIOS) return { value: null, denominator: sup.length };
  let match = 0;
  for (const e of sup) {
    const a = ctx.profileById.get(e.citingPaperId)?.evidenceClass;
    const b = ctx.profileById.get(e.citedPaperId)?.evidenceClass;
    if (a && b && groupOf(a, ctx) === gid && groupOf(b, ctx) === gid) match++;
  }
  return { value: match / sup.length, denominator: sup.length };
};

/**
 * `supportive-to-group-share`
 * params: { group: string }
 * Value: |supportive edges where cited.group = X| / |supportive edges|
 *
 * Measures reliance on a particular group as the TARGET of supportive
 * citations — e.g., surrogate support reliance when X is the surrogate
 * group.
 */
const supportiveToGroupShare: TemplateFn = (params, ctx) => {
  const gid = String(params.group ?? "");
  const sup = ctx.edges.filter((e) => roleFor(e, ctx.scope) === "supportive");
  if (sup.length < MIN_SUPPORTIVE_FOR_RATIOS) return { value: null, denominator: sup.length };
  let match = 0;
  for (const e of sup) {
    const b = ctx.profileById.get(e.citedPaperId)?.evidenceClass;
    if (b && groupOf(b, ctx) === gid) match++;
  }
  return { value: match / sup.length, denominator: sup.length };
};

/**
 * `cross-group-supportive-share`
 * params: { citingGroup: string, citedGroup: string }
 * Value: |supportive edges where citing.group = A AND cited.group = B| /
 *        |supportive edges|
 *
 * Measures directed flow between two groups — e.g., amplifier→primary
 * attention, or surrogate→amplifier.
 */
const crossGroupSupportiveShare: TemplateFn = (params, ctx) => {
  const citing = String(params.citingGroup ?? "");
  const cited = String(params.citedGroup ?? "");
  const sup = ctx.edges.filter((e) => roleFor(e, ctx.scope) === "supportive");
  if (sup.length < MIN_SUPPORTIVE_FOR_RATIOS) return { value: null, denominator: sup.length };
  let match = 0;
  for (const e of sup) {
    const a = ctx.profileById.get(e.citingPaperId)?.evidenceClass;
    const b = ctx.profileById.get(e.citedPaperId)?.evidenceClass;
    if (a && b && groupOf(a, ctx) === citing && groupOf(b, ctx) === cited) match++;
  }
  return { value: match / sup.length, denominator: sup.length };
};

/**
 * `supportive-in-degree-concentration`
 * params: { k: number }
 * Value: (supportive in-degree of top-k cited papers) /
 *        (total supportive in-degree)
 *
 * Greenberg's authority concentration: small k + large share means a
 * few papers absorb most of the supportive citation mass.
 */
const supportiveInDegreeConcentration: TemplateFn = (params, ctx) => {
  const k = Math.max(1, Number(params.k ?? 5));
  const inDeg = new Map<string, number>();
  for (const e of ctx.edges) {
    if (roleFor(e, ctx.scope) !== "supportive") continue;
    inDeg.set(e.citedPaperId, (inDeg.get(e.citedPaperId) ?? 0) + 1);
  }
  const counts = [...inDeg.values()].sort((a, b) => b - a);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total < MIN_SUPPORTIVE_FOR_CONCENTRATION) return { value: null, denominator: total };
  const top = counts.slice(0, k).reduce((a, b) => a + b, 0);
  return { value: total > 0 ? top / total : null, denominator: total };
};

/**
 * `role-ratio-complement`
 * params: { numerator: role, denominator: role[] }
 * Value: 1 - |edges with role = numerator| / |edges with role in denominator|
 *
 * Used for critique-starvation: 1 - critical / (supportive+critical).
 * High value means the numerator is rare relative to the denominator —
 * e.g., critical citations are rare relative to supportive-or-critical.
 */
const roleRatioComplement: TemplateFn = (params, ctx) => {
  const numRole = String(params.numerator ?? "") as OccurrenceRole;
  const denomRoles = (params.denominator as string[] | undefined) ?? [];
  const counts = countEdgesByRole(ctx);
  const num = counts[numRole] ?? 0;
  let denom = 0;
  for (const r of denomRoles) denom += counts[r as OccurrenceRole] ?? 0;
  if (denom < MIN_STANCE_EDGES_FOR_STARVATION) return { value: null, denominator: denom };
  return { value: 1 - num / denom, denominator: denom };
};

/**
 * `invention-rate`
 * params: { inventionType: string }  (optional; if absent, count any invention)
 * Value: |on-claim edges carrying the invention flag| / |on-claim edges|
 *
 * Where "on-claim edges" = edges whose dominantRole is anything other
 * than unclear (a rough proxy for "the LLM engaged with the citation").
 */
const inventionRate: TemplateFn = (params, ctx) => {
  const target = params.inventionType ? String(params.inventionType) : undefined;
  let denom = 0;
  let hits = 0;
  for (const e of ctx.edges) {
    const r = roleFor(e, ctx.scope);
    if (!r || r === "unclear") continue;
    denom++;
    const set = new Set(e.inventionTypes ?? []);
    if (target ? set.has(target) : set.size > 0) hits++;
  }
  if (denom === 0) return { value: null, denominator: 0 };
  return { value: hits / denom, denominator: denom };
};

// ---------- Registry ----------

export const TEMPLATES: Record<string, TemplateFn> = {
  "within-group-supportive-share": withinGroupSupportiveShare,
  "supportive-to-group-share": supportiveToGroupShare,
  "cross-group-supportive-share": crossGroupSupportiveShare,
  "supportive-in-degree-concentration": supportiveInDegreeConcentration,
  "role-ratio-complement": roleRatioComplement,
  "invention-rate": inventionRate,
};
