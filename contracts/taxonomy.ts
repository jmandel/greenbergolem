// Taxonomy: term shape + claim-pack → resolved-spec elaboration.
//
// The pipeline ships canonical catalogs of taxonomy terms (under
// contracts/catalog/). The research agent's claim pack references
// terms by id, optionally refines definitions or group assignments,
// and can add custom terms for non-biomedical domains. At task
// startup `resolveClaimPack()` merges the authored spec with the
// named catalog to produce a ResolvedClaimPack that every downstream
// task consumes.

import { z } from "zod";

/**
 * One term in a taxonomy.
 *
 * `id` is kebab-case and stable — same id across runs denotes the same
 * functional category (e.g. `rct`). `label` and `definition` are
 * human-readable; `group` and `groupLabel` attach the term to a
 * functional cluster (e.g., `producer` / `amplifier` / `surrogate` /
 * `other`) that drives automatic metric generation.
 */
export const TaxonomyTermSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "taxonomy term id must be lowercase kebab-case"),
  label: z.string().min(1),
  definition: z.string().min(1),
  examples: z.array(z.string()).optional(),
  group: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "taxonomy group id must be lowercase kebab-case")
    .optional(),
  groupLabel: z.string().min(1).optional(),
});
export type TaxonomyTerm = z.infer<typeof TaxonomyTermSchema>;

/**
 * Resolved analysis: what the pipeline will actually compute. Generated
 * deterministically from the resolved taxonomy (see `generateAnalyses`
 * below). Agents don't author these; they're entirely pipeline-owned.
 */
export const AnalysisSpecSchema = z.object({
  id: z.string(),
  template: z.string(),
  params: z.record(z.string(), z.any()),
  label: z.string(),
  scope: z.string().optional(),           // optional subclaim id
});
export type AnalysisSpec = z.infer<typeof AnalysisSpecSchema>;

/**
 * Fully elaborated claim pack: catalog defaults merged with authored
 * refinements, with the complete analysis set generated. Downstream
 * tasks read from this, never from the authored pack directly.
 */
export interface ResolvedClaimPack {
  id: string;
  canonicalClaim: string;
  aliases: string[];
  years: [number, number];
  subclaims: Array<{ id: string; text: string }>;
  catalog: string;
  evidenceClass: TaxonomyTerm[];
  inventionTypes: TaxonomyTerm[];
  analyses: AnalysisSpec[];
  hints: { judge: string; stance: string };
  reviewerNotes?: string;
}

/**
 * Throws if `termId` isn't a valid id in `terms`. Used at task
 * boundaries where an LLM-produced string is validated against the
 * run's resolved taxonomy.
 */
export function assertTermValid(
  terms: readonly TaxonomyTerm[],
  termId: string,
  dimension: string,
): void {
  if (!terms.some((t) => t.id === termId)) {
    const known = terms.map((t) => t.id).join(", ");
    throw new Error(
      `invalid ${dimension} term "${termId}" — expected one of: ${known}`,
    );
  }
}

/**
 * Fold a list of terms into a prompt-friendly markdown block, grouped
 * under their `groupLabel` headings when any terms carry a group.
 */
export function renderTermsMd(terms: readonly TaxonomyTerm[]): string {
  const lines: string[] = [];
  const grouped = terms.some((t) => t.group);
  if (!grouped) {
    for (const t of terms) lines.push(...renderTermMd(t, 0));
    return lines.join("\n");
  }
  const byGroup = new Map<string, { label: string; terms: TaxonomyTerm[] }>();
  const order: string[] = [];
  for (const t of terms) {
    const g = t.group ?? "ungrouped";
    if (!byGroup.has(g)) {
      byGroup.set(g, { label: t.groupLabel ?? g, terms: [] });
      order.push(g);
    }
    byGroup.get(g)!.terms.push(t);
  }
  for (const g of order) {
    const entry = byGroup.get(g)!;
    lines.push(`- _group:_ **${entry.label}** (\`${g}\`)`);
    for (const t of entry.terms) lines.push(...renderTermMd(t, 1));
  }
  return lines.join("\n");
}

function renderTermMd(t: TaxonomyTerm, indent: number): string[] {
  const pad = "  ".repeat(indent);
  const out = [`${pad}- **${t.id}** (${t.label}) — ${t.definition}`];
  if (t.examples?.length) {
    for (const ex of t.examples.slice(0, 3)) out.push(`${pad}  - e.g. ${ex}`);
  }
  return out;
}

/**
 * Compatibility helper: render both taxonomies of a resolved pack as
 * one prompt-friendly markdown block. Used by paper-profile and
 * paper-judge prompt builders.
 */
export function renderTaxonomyMd(resolved: {
  evidenceClass: readonly TaxonomyTerm[];
  inventionTypes: readonly TaxonomyTerm[];
}): string {
  const lines: string[] = [];
  lines.push("## Evidence class terms");
  lines.push(renderTermsMd(resolved.evidenceClass));
  if (resolved.inventionTypes.length > 0) {
    lines.push("");
    lines.push("## Invention sub-types");
    lines.push(renderTermsMd(resolved.inventionTypes));
  }
  return lines.join("\n");
}
