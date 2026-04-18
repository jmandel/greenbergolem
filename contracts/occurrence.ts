// Citation-occurrence contracts .
//
// "Occurrence-first" is the core move: we don't label paper→paper edges
// directly — we label every individual citation site, then aggregate.

import { z } from "zod";
import { ArtifactIdSchema, SubagentProvenanceSchema } from "./common.ts";

/** Raw extracted citation occurrence — deterministic output of JATS parse. */
export const CitationOccurrenceRecordSchema = z.object({
  occurrenceId: ArtifactIdSchema,
  citingPaperId: ArtifactIdSchema,
  citedPaperId: ArtifactIdSchema,
  section: z.string().optional(),           // "introduction" | "discussion" | ...
  // 0-indexed paragraph within section, if detected.
  paragraphIndex: z.number().int().nonnegative().optional(),
  // The single sentence containing the citation marker.
  sentence: z.string(),
  // The full paragraph (one level of context up from sentence).
  paragraph: z.string(),
  // Wider context: paragraph-before + paragraph + paragraph-after, when
  // available. Lets the classifier see rhetorical framing.
  wideContext: z.string().optional(),
  // Other paper IDs in the same citation group (e.g., "[12,14,17]").
  groupedCitations: z.array(ArtifactIdSchema),
  // How the citation marker was resolved to the cited paper.
  resolutionMethod: z.enum([
    "jats-id-ref",
    "crossref-lookup",
    "fuzzy-title-doi",
    "unresolved",
  ]),
});
export type CitationOccurrenceRecord = z.infer<typeof CitationOccurrenceRecordSchema>;

// ---------- Judgment pipeline ----------

export const OccurrenceRelevanceSchema = z.enum([
  "direct",            // directly discusses the focal claim
  "subclaim",          // discusses a listed subclaim
  "not-about-claim",   // background / unrelated
  "unclear",
]);
export type OccurrenceRelevance = z.infer<typeof OccurrenceRelevanceSchema>;

/**
 * Role captures the *epistemic stance* of the citation toward the claim —
 * domain-invariant across claim networks. Greenberg's "diversion" was a
 * sub-type of citation distortion, orthogonal to stance; we model
 * distortions separately in `OccurrenceInventionTypeSchema`.
 */
export const OccurrenceRoleSchema = z.enum([
  "supportive",
  "critical",
  "neutral",
  "mixed",
  "unclear",
]);
export type OccurrenceRole = z.infer<typeof OccurrenceRoleSchema>;

/**
 * Citation-distortion tag. Kebab-case id pointing into the resolved
 * claim pack's `inventionTypes` vocabulary (canonical catalog terms
 * plus any customs the claim added). Optional — most citations are
 * not distorted.
 */
export const OccurrenceInventionTypeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "invention type id must be kebab-case");
export type OccurrenceInventionTypeId = z.infer<typeof OccurrenceInventionTypeIdSchema>;

/** Per-occurrence verdict produced by paper-judge. */
export const OccurrenceJudgmentSchema = z.object({
  occurrenceId: ArtifactIdSchema,
  claimId: ArtifactIdSchema,
  role: OccurrenceRoleSchema,
  inventionType: OccurrenceInventionTypeIdSchema.optional(),
  relevance: OccurrenceRelevanceSchema,
  confidence: z.number().min(0).max(1),
  citingEvidence: z.array(z.string()),
  citedEvidence: z.array(z.string()),
  rationale: z.string(),
  needsReview: z.boolean(),
  /**
   * Which subclaims in `ClaimPack.subclaims` this citation engages.
   * Optional — if paper-judge didn't ask for it and subclaim-label
   * hasn't been run, this is absent and downstream stages treat the
   * judgment as subclaim-agnostic. An empty array means "on-claim but
   * not about any listed subclaim."
   */
  subclaimIds: z.array(z.string()).optional(),
});
export type OccurrenceJudgment = z.infer<typeof OccurrenceJudgmentSchema>;

/**
 * Overlay record produced by the subclaim-label post-hoc task. One per
 * occurrence. Merged into OccurrenceJudgment at edge-aggregate time.
 */
export const SubclaimLabelSchema = z.object({
  occurrenceId: ArtifactIdSchema,
  subclaimIds: z.array(z.string()),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type SubclaimLabel = z.infer<typeof SubclaimLabelSchema>;
