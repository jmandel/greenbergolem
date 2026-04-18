// Resolve: elaborate a thin authored ClaimPack into a fat
// ResolvedClaimPack that downstream tasks consume.
//
// The agent writes claim text, subclaims, queries, catalog reference,
// and maybe a handful of term refinements or custom terms. The
// resolver:
//   1. Looks up the named catalog (e.g. "biomed").
//   2. For each catalog term, applies any authored refinement in
//      `taxonomyRefinements` (definition addendum, group override).
//   3. Appends any custom terms from `customTerms`.
//   4. Validates that every refinement refers to an id that exists in
//      the catalog.
//   5. Generates the analysis set deterministically from the resolved
//      taxonomy groups (authority/critique-starvation always;
//      within-group-echo per amplifier group;
//      supportive-to-group-share per surrogate group; invention-rate
//      per invention type).
// The research agent never sees the resolved form; downstream tasks
// never see the authored form.

import type { ClaimPack, TermRefinement } from "./claim-pack.ts";
import type { ResolvedClaimPack, AnalysisSpec, TaxonomyTerm } from "./taxonomy.ts";
import { CATALOGS } from "./catalog/biomed.ts";

export function resolveClaimPack(pack: ClaimPack): ResolvedClaimPack {
  const catalog = CATALOGS[pack.catalog];
  if (!catalog) {
    throw new Error(
      `Unknown catalog "${pack.catalog}" — known catalogs: ${Object.keys(CATALOGS).join(", ")}`,
    );
  }

  const evidenceClass = resolveTerms(
    catalog.evidenceClass,
    pack.taxonomyRefinements.evidenceClass,
    pack.customTerms.evidenceClass,
    "evidenceClass",
  );
  const inventionTypes = resolveTerms(
    catalog.inventionTypes,
    pack.taxonomyRefinements.inventionTypes,
    pack.customTerms.inventionTypes,
    "inventionTypes",
  );

  const analyses = generateAnalyses(evidenceClass, inventionTypes);

  return {
    id: pack.id,
    canonicalClaim: pack.canonicalClaim,
    aliases: pack.aliases,
    years: pack.years,
    subclaims: pack.subclaims,
    catalog: pack.catalog,
    evidenceClass,
    inventionTypes,
    analyses,
    hints: pack.hints,
    reviewerNotes: pack.reviewerNotes,
  };
}

function resolveTerms(
  catalogTerms: readonly TaxonomyTerm[],
  refinements: readonly TermRefinement[],
  customTerms: readonly TaxonomyTerm[],
  dimension: string,
): TaxonomyTerm[] {
  const refineById = new Map(refinements.map((r) => [r.id, r]));
  const catalogIds = new Set(catalogTerms.map((t) => t.id));
  // Validate refinements point at real catalog ids (custom additions
  // go through `customTerms`, not refinements).
  for (const r of refinements) {
    if (!catalogIds.has(r.id)) {
      throw new Error(
        `${dimension} refinement references unknown catalog id "${r.id}" — use customTerms for non-catalog additions.`,
      );
    }
  }
  const resolved: TaxonomyTerm[] = catalogTerms.map((t) => {
    const r = refineById.get(t.id);
    if (!r) return t;
    return {
      ...t,
      definition: r.definitionAddendum
        ? t.definition + "\n\nClaim-specific: " + r.definitionAddendum
        : t.definition,
      group: r.groupOverride ?? t.group,
      groupLabel: r.groupLabelOverride ?? t.groupLabel,
    };
  });
  // Append custom terms after catalog terms so catalog takes
  // precedence if someone tries to declare a duplicate id.
  const knownIds = new Set(resolved.map((t) => t.id));
  for (const c of customTerms) {
    if (knownIds.has(c.id)) {
      throw new Error(
        `custom ${dimension} term "${c.id}" duplicates a catalog id; remove it or use a different id.`,
      );
    }
    resolved.push(c);
    knownIds.add(c.id);
  }
  return resolved;
}

/**
 * Deterministic analysis generation from a resolved taxonomy.
 *
 * Emitted analyses:
 *   - authority-top5         (always)
 *   - critique-starvation    (always)
 *   - within-group-supportive-share    per amplifier group
 *   - supportive-to-group-share        per surrogate group
 *   - invention-rate         per declared invention type
 *
 * Labels are generated from group labels / term labels; no string is
 * hardcoded against a specific claim.
 */
function generateAnalyses(
  evidenceClass: readonly TaxonomyTerm[],
  inventionTypes: readonly TaxonomyTerm[],
): AnalysisSpec[] {
  const out: AnalysisSpec[] = [];

  out.push({
    id: "authority-top5",
    template: "supportive-in-degree-concentration",
    params: { k: 5 },
    label: "Top-5 authority concentration",
  });

  out.push({
    id: "critique-starvation",
    template: "role-ratio-complement",
    params: { numerator: "critical", denominator: ["supportive", "critical"] },
    label: "Critique starvation",
  });

  // Collect groups by functional role. A single group can carry terms
  // with heterogeneous group ids — we use the group id as the key.
  const groupsByRole = new Map<string, { id: string; label: string }>();
  for (const t of evidenceClass) {
    if (!t.group) continue;
    if (!groupsByRole.has(t.group)) {
      groupsByRole.set(t.group, { id: t.group, label: t.groupLabel ?? t.group });
    }
  }

  for (const [gid, g] of groupsByRole) {
    if (isAmplifierGroup(gid)) {
      out.push({
        id: `echo-${gid}`,
        template: "within-group-supportive-share",
        params: { group: gid },
        label: `Echo within ${g.label}`,
      });
    }
    if (isSurrogateGroup(gid)) {
      out.push({
        id: `reliance-${gid}`,
        template: "supportive-to-group-share",
        params: { group: gid },
        label: `Supportive cites to ${g.label}`,
      });
    }
  }

  for (const iv of inventionTypes) {
    out.push({
      id: `invention-${iv.id}`,
      template: "invention-rate",
      params: { inventionType: iv.id },
      label: `${iv.label} rate`,
    });
  }

  return out;
}

function isAmplifierGroup(g: string): boolean {
  return g === "amplifier";
}
function isSurrogateGroup(g: string): boolean {
  return g === "surrogate";
}
