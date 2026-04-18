// Re-export the Zod-derived types the viewer needs. We intentionally import
// from contracts/ rather than redefining so schema drift can't sneak in.

export type {
  GraphBundle,
  GraphNode,
  EdgeBundle,
  AnalysisResult,
  PaperProfile,
  CitationOccurrenceRecord,
  OccurrenceJudgment,
  OccurrenceRole,
  OccurrenceRelevance,
  EvidenceClass,
  IntrinsicStance,
  ClaimPack,
  TaxonomyTerm,
  ResolvedClaimPack,
} from "../../../contracts/index.ts";

// Viewer-side composite bundle produced by viewer/scripts/build-data.ts.
// Includes the RESOLVED claim pack so the viewer has taxonomy groups
// and invention types without doing its own resolution.
export interface RunBundle {
  runId: string;
  claim: import("../../../contracts/index.ts").ClaimPack;
  resolved: import("../../../contracts/index.ts").ResolvedClaimPack;
  graph: import("../../../contracts/index.ts").GraphBundle;
  occurrences: import("../../../contracts/index.ts").CitationOccurrenceRecord[];
  judgments: Array<
    import("../../../contracts/index.ts").OccurrenceJudgment & {
      citingPaperId?: string;
      citedPaperId?: string;
      section?: string;
      sentence?: string;
      paragraph?: string;
      groupedCitations?: string[];
    }
  >;
  generatedAt: string;
}

export interface RunSummary {
  id: string;
  claimId: string;
  canonicalClaim: string;
  papers: number;
  edges: number;
  generatedAt: string;
  bundlePath: string;
}
