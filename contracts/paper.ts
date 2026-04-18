// Paper-side contracts .
//
// PaperRegistryRow is the procedurally-populated row we keep per paper —
// IDs, metadata, full-text availability, extraction fidelity. Written by
// `seed_search` / `corpus_expand` / `fetch_fulltext`.
//
// PaperProfile is the subagent-produced judgment on top of a registry row —
// does this paper engage with the focal claim, what kind of evidence is it,
// what is its intrinsic stance.

import { z } from "zod";
import { ArtifactIdSchema, PaperIdsSchema, SubagentProvenanceSchema } from "./common.ts";

/**
 * Evidence class is a kebab-case id that must exist in the resolved
 * claim pack's evidence-class vocabulary (canonical catalog terms +
 * any custom terms the claim added). Tasks validate at the boundary.
 */
export const EvidenceClassSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "evidence class id must be kebab-case");
export type EvidenceClass = z.infer<typeof EvidenceClassSchema>;

/**
 * Intrinsic stance is a domain-invariant epistemic primitive — every
 * claim network has supportive / critical / mixed / unclear papers.
 * Kept as a fixed enum.
 */
export const IntrinsicStanceSchema = z.enum([
  "supportive",
  "critical",
  "mixed",
  "unclear",
]);
export type IntrinsicStance = z.infer<typeof IntrinsicStanceSchema>;

/**
 * Where / how we obtained full text. The list is roughly ordered by fidelity
 *. Downstream tasks consume this to clamp confidence.
 */
export const FullTextSourceSchema = z.enum([
  "pmc-jats",
  "europepmc-xml",
  "biorxiv-xml",
  "pdf-text",           // plaintext extracted from a PDF via pdftotext — no
                        //   structured refs; paper can be a citation target
                        //   but won't contribute outgoing edges
  "abstract-only",
  "none",
]);
export type FullTextSource = z.infer<typeof FullTextSourceSchema>;

export const FullTextStatusSchema = z.object({
  source: FullTextSourceSchema,
  sourceUrl: z.string().optional(),
  xmlPath: z.string().optional(),           // raw JATS/XML we stored
  markdownPath: z.string().optional(),      // LLM-friendly extraction
  referencesPath: z.string().optional(),    // references.json from the JATS <ref-list>
  pdfPath: z.string().optional(),           // rendered PDF (europepmc ?pdf=render)
  pagesDir: z.string().optional(),          // dir of page-NN.png from pdftoppm
  pageCount: z.number().int().nonnegative().optional(),
  figuresDir: z.string().optional(),        // dir of JATS figure graphics
  figureCount: z.number().int().nonnegative().optional(),
  referencesTotal: z.number().int().nonnegative().default(0),
  referencesResolved: z.number().int().nonnegative().default(0),
  sectionsDetected: z.boolean().default(false),
  notes: z.string().default(""),
});
export type FullTextStatus = z.infer<typeof FullTextStatusSchema>;

/**
 * One entry in a paper's discovery trace. Append-only: every time we
 * pull a paper into the corpus we record how and why (query source
 * + query expression, refs-tally, manual add, preprint resolution,
 * direct PDF). Downstream agents get a full history of why a paper
 * is in the corpus, not just a free-form label.
 */
export const DiscoveryEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("query"),
    source: z.enum(["pubmed", "openalex", "europepmc"]),
    query: z.string(),
    /** Optional free-form rationale carried from the query that matched. */
    rationale: z.string().optional(),
    ts: z.string(),
  }),
  z.object({
    kind: z.literal("refs-tally"),
    citedBy: z.array(z.string()),          // paperIds of the citers at time of tally
    countAtTime: z.number().int().nonnegative(),
    ts: z.string(),
  }),
  z.object({
    kind: z.literal("manual"),
    note: z.string().optional(),
    ts: z.string(),
  }),
  z.object({
    kind: z.literal("preprint"),
    preprintId: z.string(),
    ts: z.string(),
  }),
  z.object({
    kind: z.literal("pdf-url"),
    pdfUrl: z.string(),
    ts: z.string(),
  }),
]);
export type DiscoveryEntry = z.infer<typeof DiscoveryEntrySchema>;

export const PaperRegistryRowSchema = z.object({
  paperId: ArtifactIdSchema,
  ids: PaperIdsSchema,
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int(),
  venue: z.string().optional(),
  abstract: z.string().optional(),
  /** Short free-form summary for quick display. */
  discoveredVia: z.string(),
  /** Structured history of how/why this paper entered the corpus. */
  discoveryTrace: z.array(DiscoveryEntrySchema).default([]),
  fullText: FullTextStatusSchema.optional(),
  retracted: z
    .object({
      isRetracted: z.boolean(),
      retractionDate: z.string().optional(),
      retractionReason: z.string().optional(),
    })
    .optional(),
});
export type PaperRegistryRow = z.infer<typeof PaperRegistryRowSchema>;

/** Quoted span inside a paper's full text that bears on the focal claim. */
export const ClaimSpanSchema = z.object({
  section: z.string().optional(),
  text: z.string(),
});
export type ClaimSpan = z.infer<typeof ClaimSpanSchema>;

/** Per-paper judgment produced by the paper-profile subagent. */
export const PaperProfileSchema = z.object({
  paperId: ArtifactIdSchema,
  claimId: ArtifactIdSchema,
  relevant: z.boolean(),
  relevance: z.number().min(0).max(1),        // 0..1 calibrated confidence
  /**
   * Kebab-case id from the resolved claim pack's evidence-class
   * vocabulary (canonical catalog terms + any customs the claim
   * added). Runtime-validated by consuming tasks.
   */
  evidenceClass: EvidenceClassSchema,
  intrinsicStance: IntrinsicStanceSchema,
  claimSpans: z.array(ClaimSpanSchema),
  rationale: z.string(),
  needsReview: z.boolean().default(false),
  provenance: SubagentProvenanceSchema,
});
export type PaperProfile = z.infer<typeof PaperProfileSchema>;
