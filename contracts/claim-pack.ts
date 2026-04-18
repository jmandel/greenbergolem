// ClaimPack — the canonicalized focal claim that every downstream task
// conditions on.
//
// The claim pack written to disk by the research agent is a THIN
// authored spec: claim text, subclaims, queries, catalog selection,
// reviewer notes, plus optional refinements/customs/hints. The pipeline
// calls `resolveClaimPack()` at task startup to elaborate it into a
// ResolvedClaimPack with the canonical catalog merged in and the full
// analysis set generated. Downstream tasks consume the resolved form.

import { z } from "zod";
import { ArtifactIdSchema } from "./common.ts";
import {
  TaxonomyTermSchema,
  type TaxonomyTerm,
} from "./taxonomy.ts";

// ---------- Subclaims + queries ----------

export const SubclaimSchema = z.object({
  id: z.string(),
  text: z.string(),
});
export type Subclaim = z.infer<typeof SubclaimSchema>;

/**
 * A search query the corpus-build step will run to exhaustion.
 * Greenberg-style: every paper that matches is included (subject to
 * excludes and full-text availability), not a sampled top-N.
 *
 * Landmark papers that the topic-level queries might miss are included
 * by adding a narrow per-paper query (`"<DOI>"[AID]`, `"<PMID>"[PMID]`).
 * There is no separate anchor override.
 */
export const SearchQuerySchema = z.object({
  source: z.enum(["pubmed", "openalex"]),
  query: z.string().min(1),
  minYear: z.number().int().optional(),
  maxYear: z.number().int().optional(),
  rationale: z.string().optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

// ---------- Authored refinements ----------

/**
 * Reference to a catalog term the claim pack is using, with optional
 * per-claim refinements. Agents typically write just `{ "id": "rct" }`
 * and let the catalog supply label/definition/group. When a claim's
 * domain-specific decision criteria need different wording than the
 * catalog default, the agent supplies `definitionAddendum` (appended
 * to the catalog's definition, not replacing it). Group overrides are
 * rare; use when a term's functional role genuinely differs for this
 * claim (e.g., a meta-analysis acting as a producer because it
 * includes new pooled subgroup analyses).
 */
export const TermRefinementSchema = z.object({
  id: z.string(),
  definitionAddendum: z.string().optional(),
  groupOverride: z.string().optional(),
  groupLabelOverride: z.string().optional(),
});
export type TermRefinement = z.infer<typeof TermRefinementSchema>;

// ---------- Authored claim pack (what the research agent writes) ----------

export const ClaimPackSchema = z.object({
  id: ArtifactIdSchema,
  canonicalClaim: z.string(),
  aliases: z.array(z.string()).default([]),
  includeQueries: z.array(SearchQuerySchema),
  excludeQueries: z.array(SearchQuerySchema),
  years: z.tuple([z.number().int(), z.number().int()]),
  /** Named catalog to use for evidence-class + invention-type vocabularies. */
  catalog: z.literal("biomed"),
  subclaims: z.array(SubclaimSchema),
  /**
   * Optional per-term refinements on top of catalog defaults. Agents
   * typically write this as `[]` and let catalog defaults carry.
   */
  taxonomyRefinements: z
    .object({
      evidenceClass: z.array(TermRefinementSchema).default([]),
      inventionTypes: z.array(TermRefinementSchema).default([]),
    })
    .default({ evidenceClass: [], inventionTypes: [] }),
  /**
   * Custom terms for domains the catalog doesn't cover (non-biomedical
   * claims). Each term provides full id/label/definition/group. For a
   * typical biomedical claim these arrays are empty.
   */
  customTerms: z
    .object({
      evidenceClass: z.array(TaxonomyTermSchema).default([]),
      inventionTypes: z.array(TaxonomyTermSchema).default([]),
    })
    .default({ evidenceClass: [], inventionTypes: [] }),
  /**
   * Optional prose appended to paper-profile / paper-judge prompts
   * when generic guidance undergeneralizes. Escape hatch for claims
   * with genuinely domain-specific rhetorical patterns. Empty for
   * most claims.
   */
  hints: z
    .object({
      judge: z.string().default(""),
      stance: z.string().default(""),
    })
    .default({ judge: "", stance: "" }),
  reviewerNotes: z.string().optional(),
});
export type ClaimPack = z.infer<typeof ClaimPackSchema>;
