// Zod schemas are the single source of truth for artifact shapes .
// TypeScript types below are derived via z.infer so the compiler and the
// runtime validator never disagree.

import { z } from "zod";

// ---------- 5.1 Shared primitives ----------

export const ArtifactIdSchema = z.string().min(1);
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const ArtifactRefSchema = z.object({
  id: ArtifactIdSchema,
  kind: z.string(),
  markdownPath: z.string(),
  jsonPath: z.string().optional(),
  contentHash: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const LLMProvenanceSchema = z.object({
  agent: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  contractVersion: z.string(),
  timestamp: z.string(),
  costUsd: z.number().optional(),
  latencyMs: z.number().optional(),
  cwdSnapshot: z.string().optional(),
});
export type LLMProvenance = z.infer<typeof LLMProvenanceSchema>;

// Judgment<T> — every LLM-produced structured field carries confidence +
// justification. Because Zod generics don't compose neatly, we expose a
// factory that builds a schema for any value shape.
export const makeJudgmentSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.object({
    value: valueSchema,
    confidence: z.number().min(0).max(1),
    justification: z.string(),
    evidenceSpan: z.string().optional(),
    provenance: LLMProvenanceSchema,
  });

export type Judgment<T> = {
  value: T;
  confidence: number;
  justification: string;
  evidenceSpan?: string;
  provenance: LLMProvenance;
};

// ---------- 5.2 ClaimDescriptor ----------

export const ClaimDirectionSchema = z.enum(["positive", "negative", "neutral"]);

export const ClaimDescriptorSchema = z.object({
  id: ArtifactIdSchema,
  canonical: z.string(),
  userOriginal: z.string(),
  paraphrases: z.array(z.string()),
  entities: z.object({
    subject: z.string(),
    object: z.string(),
    relation: z.string(),
    direction: ClaimDirectionSchema,
  }),
  searchKeywords: z.array(z.string()),
  dateRange: z.tuple([z.number(), z.number()]),
  domain: z.string(),
  seedPaperDoi: z.string().optional(),
  provenance: LLMProvenanceSchema,
});
export type ClaimDescriptor = z.infer<typeof ClaimDescriptorSchema>;

// ---------- 5.3 PaperRecord + FullTextRecord ----------

export const FullTextSourceSchema = z.enum([
  "pmc-jats",
  "europepmc-xml",
  "pmc-oa-pdf",
  "biorxiv-xml",
  "arxiv-latex",
  "publisher-tdm",
  "grobid-pdf",
  "ocr-pdf",
  "abstract-only",
  "none",
]);
export type FullTextSource = z.infer<typeof FullTextSourceSchema>;

export const LossinessLevelSchema = z.enum(["none", "low", "medium", "high"]);
export type LossinessLevel = z.infer<typeof LossinessLevelSchema>;

export const FullTextRecordSchema = z.object({
  source: FullTextSourceSchema,
  sourceUrl: z.string().optional(),
  markdownPath: z.string().optional(),
  rawPath: z.string().optional(),
  lossiness: z.object({
    level: LossinessLevelSchema,
    referencesResolved: z.number().int().nonnegative(),
    referencesTotal: z.number().int().nonnegative(),
    sectionsDetected: z.boolean(),
    paragraphsDetected: z.boolean(),
    figureCaptionsCaptured: z.boolean(),
    ocrUsed: z.boolean(),
    notes: z.string(),
  }),
});
export type FullTextRecord = z.infer<typeof FullTextRecordSchema>;

export const PaperRecordSchema = z.object({
  id: ArtifactIdSchema,
  displayNumber: z.number().int().positive().optional(),
  doi: z.string().optional(),
  openAlexId: z.string().optional(),
  semanticScholarId: z.string().optional(),
  pubmedId: z.string().optional(),
  pmcId: z.string().optional(),
  preprintDoi: z.string().optional(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int(),
  venue: z.string().optional(),
  abstract: z.string().optional(),
  fullText: FullTextRecordSchema.optional(),
  retracted: z
    .object({
      isRetracted: z.boolean(),
      retractionDate: z.string().optional(),
      retractionReason: z.string().optional(),
      source: z.string(),
    })
    .optional(),
});
export type PaperRecord = z.infer<typeof PaperRecordSchema>;

// ---------- 5.4 RelevanceAssessment ----------

export const RelevanceAssessmentSchema = z.object({
  id: ArtifactIdSchema,
  paperId: ArtifactIdSchema,
  claimId: ArtifactIdSchema,
  relevant: z.boolean(),
  engagementSpans: z.array(
    z.object({
      location: z.string(),
      text: z.string(),
      roleHint: z.string(),
    }),
  ),
  judgment: makeJudgmentSchema(z.boolean()),
});
export type RelevanceAssessment = z.infer<typeof RelevanceAssessmentSchema>;

// ---------- 5.5 NodeCategory + CategorizedNode ----------

export const NodeCategorySchema = z.enum([
  "primary-data-supportive",
  "primary-data-critical",
  "review",
  "animal-cell-model",
  "other",
]);
export type NodeCategory = z.infer<typeof NodeCategorySchema>;

export const IntrinsicStanceSchema = z.enum(["supportive", "critical", "neutral"]);
export type IntrinsicStance = z.infer<typeof IntrinsicStanceSchema>;

export const CategorizedNodeSchema = z.object({
  id: ArtifactIdSchema,
  paperId: ArtifactIdSchema,
  category: makeJudgmentSchema(NodeCategorySchema),
  intrinsicStance: makeJudgmentSchema(IntrinsicStanceSchema).optional(),
});
export type CategorizedNode = z.infer<typeof CategorizedNodeSchema>;

// ---------- 5.6 CitationContext ----------

export const ResolutionMethodSchema = z.enum([
  "jats-id-ref",
  "crossref-lookup",
  "grobid-match",
  "fuzzy-title-doi",
  "unresolved",
]);
export type ResolutionMethod = z.infer<typeof ResolutionMethodSchema>;

export const CitationContextSchema = z.object({
  id: ArtifactIdSchema,
  citingPaperId: ArtifactIdSchema,
  citedPaperId: ArtifactIdSchema,
  location: z.object({
    section: z.string().nullable(),
    paragraph: z.number().int().nullable(),
    sentence: z.number().int().nullable(),
  }),
  surroundingText: z.object({
    sentence: z.string(),
    paragraph: z.string(),
    wideContext: z.string(),
  }),
  groupedWith: z.array(ArtifactIdSchema),
  sourceLossiness: z.object({
    inheritedLevel: LossinessLevelSchema,
    markerResolved: z.boolean(),
    resolutionMethod: ResolutionMethodSchema,
    surroundingTextFidelity: z.enum(["verbatim", "reconstructed", "approximate"]),
  }),
  ambiguous: z.boolean(),
});
export type CitationContext = z.infer<typeof CitationContextSchema>;

// ---------- 5.7 StanceLabel + ClassifiedEdge ----------

export const StanceLabelSchema = z.enum(["supportive", "neutral", "critical", "diversion"]);
export type StanceLabel = z.infer<typeof StanceLabelSchema>;

const StanceJudgmentSchema = makeJudgmentSchema(StanceLabelSchema);

export const ClassifiedEdgeSchema = z.object({
  id: ArtifactIdSchema,
  citingPaperId: ArtifactIdSchema,
  citedPaperId: ArtifactIdSchema,
  claimId: ArtifactIdSchema,
  contextId: ArtifactIdSchema,
  stance: StanceJudgmentSchema,
  crossCheck: z.object({
    first: StanceJudgmentSchema,
    second: StanceJudgmentSchema,
    agreed: z.boolean(),
    arbitration: StanceJudgmentSchema.optional(),
  }),
});
export type ClassifiedEdge = z.infer<typeof ClassifiedEdgeSchema>;

// ---------- 5.8 AuthorityAssessment ----------

export const AuthorityAssessmentSchema = z.object({
  id: ArtifactIdSchema,
  paperId: ArtifactIdSchema,
  isAuthority: z.boolean(),
  authorityScore: z.number().min(0).max(1),
  features: z.object({
    supportiveInDegree: z.number().int().nonnegative(),
    totalInDegree: z.number().int().nonnegative(),
    pageRank: z.number(),
    betweennessCentrality: z.number(),
    citationSurvivalDecades: z.number(),
  }),
  formulaVersion: z.string(),
});
export type AuthorityAssessment = z.infer<typeof AuthorityAssessmentSchema>;

// ---------- 5.9 GraphArtifact ----------

export const GraphArtifactSchema = z.object({
  id: ArtifactIdSchema,
  claimId: ArtifactIdSchema,
  nodes: z.array(
    z.object({
      node: CategorizedNodeSchema,
      paper: PaperRecordSchema,
      authority: AuthorityAssessmentSchema,
    }),
  ),
  edges: z.array(ClassifiedEdgeSchema),
  orphanPapers: z.array(ArtifactIdSchema),
  layout: z.object({
    yearRange: z.tuple([z.number(), z.number()]),
    columns: z.array(
      z.object({
        id: NodeCategorySchema,
        label: z.string(),
        order: z.number().int(),
      }),
    ),
  }),
  stats: z.object({
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    edgeCountByStance: z.record(StanceLabelSchema, z.number().int().nonnegative()),
    authorityNodeCount: z.number().int().nonnegative(),
  }),
  provenance: z.object({
    runId: z.string(),
    taskCount: z.number().int().nonnegative(),
    totalCostUsd: z.number(),
    totalWallClockSec: z.number(),
  }),
});
export type GraphArtifact = z.infer<typeof GraphArtifactSchema>;

// ---------- 5.10 Task contracts ----------

export const TaskStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped-cached",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskInvocationSchema = z.object({
  invocationId: z.string(),
  taskType: z.string(),
  inputs: z.array(ArtifactRefSchema),
  outputs: z.array(ArtifactRefSchema),
  status: TaskStatusSchema,
  attempts: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  errorSummary: z.string().optional(),
});
export type TaskInvocation = z.infer<typeof TaskInvocationSchema>;

export const WorkflowSchema = z.object({
  id: z.string(),
  claimId: ArtifactIdSchema,
  invocations: z.array(TaskInvocationSchema),
  dependencies: z.array(z.object({ from: z.string(), to: z.string() })),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
});
export type Workflow = z.infer<typeof WorkflowSchema>;
