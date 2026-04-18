// paper-profile: fan out one subagent call per paper that produces a
// PaperProfile . Runs in parallel, bounded by a shared
// SubagentSemaphore. Cached: if a paper's profile.json already exists
// and the content hash of its body.md matches, the paper is skipped.

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  ClaimPackSchema,
  PaperRegistryRowSchema,
  PaperProfileSchema,
  assertTermValid,
  type ClaimPack,
  type PaperRegistryRow,
  type PaperProfile,
  type ResolvedClaimPack,
} from "../../contracts/index.ts";
import { resolveClaimPack } from "../../contracts/resolve.ts";
import { runSubagentTask } from "../../lib/subagent-runner.ts";
import { SubagentSemaphore } from "../../lib/subagent.ts";
import { writeArtifact } from "../../lib/artifacts.ts";
import { ProgressLog } from "../../orchestrator/progress.ts";

const TASK_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPT_VERSION = "paper-profile.v1";
const CONTRACT_VERSION = "paper-profile.contract.v1";

// No arbitrary body-length truncation. The subagent gets the full
// parsed body.md inline; if a paper is enormous, the agent sees that
// and can decide to grep selectively rather than us pre-filtering.

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      "run-id": { type: "string" },
      "claim-json": { type: "string" },
      "registry-jsonl": { type: "string" },
      "papers-dir": { type: "string" },
      "concurrency": { type: "string", default: "8" },
      "model": { type: "string", default: "claude-opus-4.7" },
      "cli": { type: "string", default: "copilot" },
      "limit": { type: "string" },       // optional: cap papers (for quick iterations)
    },
  });

  const outDir = values["out-dir"];
  const claimPath = values["claim-json"];
  const registryPath = values["registry-jsonl"];
  const papersDir = values["papers-dir"];
  if (!outDir || !claimPath || !registryPath || !papersDir) {
    console.error("usage: --out-dir <dir> --claim-json <path> --registry-jsonl <path> --papers-dir <dir> [--concurrency N]");
    process.exit(2);
  }
  const runId = values["run-id"] ?? "ad-hoc";
  const conc = Math.max(1, Math.min(16, Number(values.concurrency) || 8));
  const cap = values.limit ? Math.max(1, Number(values.limit)) : Infinity;

  const progress = new ProgressLog(join(outDir, "..", "progress.jsonl"));

  const claim = ClaimPackSchema.parse(JSON.parse(await readFile(claimPath, "utf8"))) as ClaimPack;
  const resolved = resolveClaimPack(claim);
  const rows = (await readJsonl(registryPath))
    .map((r) => PaperRegistryRowSchema.parse(r))
    .filter((r) => r.fullText?.sectionsDetected)
    .slice(0, cap);

  await progress.emit({
    runId,
    kind: "task-start",
    taskType: "paper-profile",
    message: `${rows.length} papers, cli=${values.cli} model=${values.model} conc=${conc}`,
  });

  const claimMd = renderClaimMd(resolved);
  const taxonomyMd = renderEvidenceTaxonomyMd(resolved);
  const validEvidenceClassIds = resolved.evidenceClass.map((t) => t.id);
  const contractMd = await readFile(join(TASK_DIR, "CONTRACT.md"), "utf8");
  const promptTpl = await readFile(join(TASK_DIR, "prompt.md"), "utf8");

  const semaphore = new SubagentSemaphore(conc);
  const profiles: PaperProfile[] = [];
  let done = 0;
  let cached = 0;
  let failed = 0;

  await Promise.all(
    rows.map((row) =>
      (async () => {
        const paperOutDir = join(outDir, "papers", row.paperId);
        const profileJsonPath = join(paperOutDir, "profile.json");
        const cacheKeyPath = join(paperOutDir, ".cache-key");
        const bodyPath = join(papersDir, row.paperId, "body.md");
        const body = await readFile(bodyPath, "utf8");
        const cacheKey = cacheHash(claim.id, body);

        // Cache check — avoid re-spending on papers whose body + claim didn't change.
        try {
          const stored = await readFile(cacheKeyPath, "utf8");
          if (stored.trim() === cacheKey) {
            await access(profileJsonPath);
            const cachedProfile = PaperProfileSchema.parse(JSON.parse(await readFile(profileJsonPath, "utf8")));
            profiles.push(cachedProfile);
            cached++;
            done++;
            await progress.emit({
              runId,
              kind: "task-cached",
              taskType: "paper-profile",
              message: `${row.paperId} cached (${done}/${rows.length})`,
            });
            return;
          }
        } catch {
          // no cache, carry on
        }

        const paperMd = renderPaperMd(row, body);
        const workspace = join(paperOutDir, "workspace");
        const inputs = [
          { name: "CLAIM.md", content: claimMd },
          { name: "TAXONOMIES.md", content: taxonomyMd },
          { name: "PAPER.md", content: paperMd },
          { name: "CONTRACT.md", content: contractMd },
          {
            name: "INPUT.md",
            content: [
              "# Paper profiling",
              "",
              `Paper ID: \`${row.paperId}\``,
              `Claim ID: \`${claim.id}\``,
              "",
              "Read CLAIM.md, TAXONOMIES.md, PAPER.md, and CONTRACT.md, then write report.md.",
              "",
              "The `evidenceClass` field in your JSON output MUST be one of the kebab-case ids listed in TAXONOMIES.md. Any other value is a contract violation.",
              "",
              "Use the paperId and claimId above as the \"paperId\" and \"claimId\" fields of the final JSON block.",
            ].join("\n"),
          },
        ];

        try {
          const result = await runSubagentTask({
            taskType: "paper-profile",
            workspaceDir: workspace,
            files: inputs,
            prompt: promptTpl,
            outputFilename: "report.md",
            schema: PaperProfileSchema.omit({ provenance: true }).extend({
              // The subagent should not need to supply provenance; we attach it below.
            }).partial({ needsReview: true }),
            cli: values.cli as "copilot",
            model: values.model,
            timeoutMs: 8 * 60 * 1000,
            availableTools: ["bash", "view", "create", "edit", "report_intent", "task_complete"],
            maxAutopilotContinues: 6,
            progress,
            runId,
            semaphore,
            promptVersion: PROMPT_VERSION,
            contractVersion: CONTRACT_VERSION,
          });

          // Validate the subagent's evidenceClass against the resolved
          // taxonomy. If it's out-of-taxonomy, fail LOUD — this catches
          // prompt drift or claim-pack+profile divergence rather than
          // silently writing an orphan term that breaks downstream.
          const rawClass = String((result.json as any).evidenceClass ?? "");
          if (!validEvidenceClassIds.includes(rawClass)) {
            throw new Error(
              `${row.paperId}: evidenceClass "${rawClass}" not in allowed set [${validEvidenceClassIds.join(", ")}]`,
            );
          }

          const profile: PaperProfile = PaperProfileSchema.parse({
            paperId: row.paperId,
            claimId: claim.id,
            relevant: (result.json as any).relevant ?? false,
            relevance: (result.json as any).relevance ?? 0,
            evidenceClass: rawClass,
            intrinsicStance: (result.json as any).intrinsicStance,
            claimSpans: (result.json as any).claimSpans ?? [],
            rationale: (result.json as any).rationale ?? "",
            needsReview: (result.json as any).needsReview ?? false,
            provenance: {
              agent: "copilot",
              model: values.model!,
              promptVersion: PROMPT_VERSION,
              contractVersion: CONTRACT_VERSION,
              invocationId: result.subagent.invocationId,
              timestamp: new Date().toISOString(),
              latencyMs: result.subagent.latencyMs,
            },
          });

          await mkdir(paperOutDir, { recursive: true });
          await writeFile(profileJsonPath, JSON.stringify(profile, null, 2) + "\n", "utf8");
          await writeFile(join(paperOutDir, "report.md"), result.reportMarkdown, "utf8");
          await writeFile(cacheKeyPath, cacheKey + "\n", "utf8");

          profiles.push(profile);
          done++;
          await progress.emit({
            runId,
            kind: "note",
            taskType: "paper-profile",
            message: `${row.paperId} relevant=${profile.relevant} class=${profile.evidenceClass} stance=${profile.intrinsicStance} (${done}/${rows.length})`,
          });
        } catch (e) {
          failed++;
          done++;
          await progress.emit({
            runId,
            kind: "task-failure",
            taskType: "paper-profile",
            message: `${row.paperId}: ${(e as Error).message}`,
          });
          console.error(`[paper-profile] ${row.paperId} FAILED: ${(e as Error).message}`);
        }
      })(),
    ),
  );

  // Aggregate artifact
  const jsonlPath = join(outDir, "profiles.jsonl");
  await writeJsonl(jsonlPath, profiles);
  const stats = summarize(profiles);
  const report = [
    `# paper-profile report`,
    ``,
    `Claim: **${claim.canonicalClaim}**  `,
    `Papers profiled: **${profiles.length}**  `,
    `From cache: **${cached}**  `,
    `Failed: **${failed}**`,
    ``,
    `## Evidence class`,
    ``,
    ...Object.entries(stats.byClass).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Intrinsic stance`,
    ``,
    ...Object.entries(stats.byStance).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Relevance`,
    ``,
    `- relevant: ${stats.relevant}`,
    `- irrelevant: ${stats.irrelevant}`,
    `- needs-review: ${stats.needsReview}`,
    ``,
    "```json",
    JSON.stringify({ total: profiles.length, cached, failed, stats }, null, 2),
    "```",
    ``,
  ].join("\n");

  await writeArtifact({
    id: `paper-profile.${claim.id}`,
    kind: "paper-profile",
    markdownPath: join(outDir, "report.md"),
    jsonPath: join(outDir, "profiles.json"),
    markdown: report,
    json: { claimId: claim.id, profiles },
    frontmatter: {
      task: "paper-profile",
      status: failed > 0 ? "needs-review" : "ok",
      inputs: [claimPath, registryPath],
      json: "profiles.json",
    },
  });

  await progress.emit({
    runId,
    kind: "task-success",
    taskType: "paper-profile",
    message: `${profiles.length} profiles`,
    data: { cached, failed, stats },
  });

  console.log(`[paper-profile] ${profiles.length} profiles (cached=${cached} failed=${failed})`);
}

function renderClaimMd(claim: ResolvedClaimPack): string {
  return [
    `# Focal claim`,
    ``,
    `**Canonical:** ${claim.canonicalClaim}`,
    ``,
    `**Claim ID:** \`${claim.id}\``,
    `**Year window:** ${claim.years[0]}–${claim.years[1]}`,
    ``,
    claim.aliases.length
      ? ["## Aliases", "", ...claim.aliases.map((a) => `- ${a}`), ""].join("\n")
      : "",
    claim.subclaims.length
      ? [
          "## Subclaims",
          "",
          ...claim.subclaims.map((s) => `- \`${s.id}\`: ${s.text}`),
          "",
        ].join("\n")
      : "",
    claim.hints.stance
      ? ["## Stance hints (claim-specific guidance)", "", claim.hints.stance, ""].join("\n")
      : "",
    claim.reviewerNotes ? ["## Reviewer notes", "", claim.reviewerNotes, ""].join("\n") : "",
  ].filter(Boolean).join("\n");
}

function renderEvidenceTaxonomyMd(resolved: ResolvedClaimPack): string {
  const lines: string[] = [];
  lines.push("# Taxonomies for this run");
  lines.push("");
  lines.push("## Evidence class");
  lines.push("");
  lines.push("Pick exactly one of these kebab-case ids for `evidenceClass`. The definition is the criterion you apply:");
  lines.push("");
  for (const t of resolved.evidenceClass) {
    lines.push(`- \`${t.id}\` — **${t.label}**: ${t.definition}`);
    if (t.examples?.length) {
      for (const ex of t.examples.slice(0, 3)) lines.push(`  - e.g. ${ex}`);
    }
  }
  if (resolved.inventionTypes.length) {
    lines.push("");
    lines.push("## Invention sub-types (context only — not used at this step)");
    lines.push("");
    for (const t of resolved.inventionTypes) {
      lines.push(`- \`${t.id}\`: ${t.definition}`);
    }
  }
  return lines.join("\n");
}

function renderPaperMd(row: PaperRegistryRow, body: string): string {
  return [
    `# Paper`,
    ``,
    `**Title:** ${row.title}`,
    `**Year:** ${row.year}`,
    `**Venue:** ${row.venue ?? "—"}`,
    `**Authors:** ${row.authors.slice(0, 10).join(", ")}${row.authors.length > 10 ? " …" : ""}`,
    `**IDs:** DOI=${row.ids.doi ?? "—"} PMID=${row.ids.pmid ?? "—"} PMCID=${row.ids.pmcid ?? "—"}`,
    ``,
    row.abstract ? ["## Abstract", "", row.abstract, ""].join("\n") : "",
    `## Body`,
    ``,
    body,
  ].filter(Boolean).join("\n");
}

function cacheHash(claimId: string, body: string): string {
  return createHash("sha256").update(claimId).update("\n").update(body).digest("hex");
}

function summarize(profiles: PaperProfile[]) {
  const byClass: Record<string, number> = {};
  const byStance: Record<string, number> = {};
  let relevant = 0;
  let irrelevant = 0;
  let needsReview = 0;
  for (const p of profiles) {
    byClass[p.evidenceClass] = (byClass[p.evidenceClass] ?? 0) + 1;
    byStance[p.intrinsicStance] = (byStance[p.intrinsicStance] ?? 0) + 1;
    if (p.relevant) relevant++; else irrelevant++;
    if (p.needsReview) needsReview++;
  }
  return { byClass, byStance, relevant, irrelevant, needsReview };
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
