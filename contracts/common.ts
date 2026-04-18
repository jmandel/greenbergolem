// Shared primitives for the Claim Cartographer task contracts .
// Zod is the single source of truth; TypeScript types are derived via z.infer.

import { z } from "zod";

export const ArtifactIdSchema = z.string().min(1);
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

/** Identifier set we carry per paper. At minimum one of these must be populated. */
export const PaperIdsSchema = z
  .object({
    doi: z.string().optional(),
    pmid: z.string().optional(),
    pmcid: z.string().optional(),
    openAlex: z.string().optional(),
  })
  .refine(
    (v) => Boolean(v.doi || v.pmid || v.pmcid || v.openAlex),
    { message: "at least one of doi/pmid/pmcid/openAlex is required" },
  );
export type PaperIds = z.infer<typeof PaperIdsSchema>;

/** Provenance for anything an LLM produced (subagent call metadata). */
export const SubagentProvenanceSchema = z.object({
  agent: z.string(),                 // "copilot" | "claude" | ...
  model: z.string(),                 // concrete model identifier
  promptVersion: z.string(),         // version tag on the prompt template
  contractVersion: z.string(),       // version tag on CONTRACT.md
  invocationId: z.string(),
  timestamp: z.string(),             // ISO-8601
  latencyMs: z.number().optional(),
  premiumRequests: z.number().optional(),
});
export type SubagentProvenance = z.infer<typeof SubagentProvenanceSchema>;
