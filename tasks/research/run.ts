// research: the exploration subagent task.
//
// Replaces claim-pack + seed-search + taxonomy-bootstrap with a single
// agentic step. The subagent runs an iterative loop of search → fetch →
// read → refs-tally until it has a complete corpus manifest. The
// manifest (claim-pack.json + papers.registry.jsonl + papers/) is
// written in place by the tools, not by schema validation of this
// task's return value.

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { ClaimPackSchema, PaperRegistryRowSchema, type PaperRegistryRow } from "../../contracts/index.ts";
import { runSubagentTask } from "../../lib/subagent-runner.ts";
import { writeArtifact } from "../../lib/artifacts.ts";
import { ProgressLog } from "../../orchestrator/progress.ts";

const TASK_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPT_VERSION = "research.v1";
const CONTRACT_VERSION = "research.contract.v1";

// The subagent's final report.md ends with a small JSON summary — we
// parse it just for sanity stats. The real output is the updated
// ClaimPack spec (includeQueries, excludeQueries, taxonomies) on disk.
// The downstream corpus-build task executes that spec to produce the
// actual paper corpus.
const SummarySchema = z.object({
  claimId: z.string(),
  includeQueryCount: z.number().int().nonnegative(),
  excludeQueryCount: z.number().int().nonnegative().default(0),
  estimatedCorpusSize: z.number().int().nonnegative().default(0),
  taxonomyEvidenceClasses: z.array(z.string()).default([]),
  taxonomyInventionTypes: z.array(z.string()).default([]),
  coverageConcerns: z.array(z.string()).default([]),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      "run-id": { type: "string" },
      input: { type: "string" },                   // raw user claim
      "input-file": { type: "string" },
      "claim-id": { type: "string" },
      "years": { type: "string", default: "2020-2024" },
      cli: { type: "string", default: "copilot" },
      model: { type: "string", default: "claude-opus-4.7" },
    },
  });

  const outDir = values["out-dir"];
  if (!outDir) {
    console.error("usage: --out-dir <dir> --input '<claim>' [--claim-id <id>] [--years YYYY-YYYY]");
    process.exit(2);
  }
  const userClaim = values.input
    ?? (values["input-file"] ? await readFile(values["input-file"], "utf8") : "");
  if (!userClaim.trim()) {
    console.error("missing --input or --input-file");
    process.exit(2);
  }

  const [y0, y1] = values.years!.split("-").map(Number);
  const years: [number, number] = [y0 || 2020, y1 || 2024];
  const claimId = values["claim-id"] ?? suggestClaimId(userClaim);
  const runId = values["run-id"] ?? "ad-hoc";

  const progress = new ProgressLog(join(outDir, "..", "progress.jsonl"));

  // Initialize the manifest so the subagent's tool calls immediately work.
  const manifestDir = outDir;
  const repoRoot = resolve(TASK_DIR, "..", "..");
  await mkdir(manifestDir, { recursive: true });
  await initManifest({ manifestDir, claimId, canonicalClaim: userClaim.trim(), years });

  await progress.emit({
    runId,
    kind: "task-start",
    taskType: "research",
    message: `manifest=${manifestDir} claim=${claimId}`,
  });

  const promptTpl = await readFile(join(TASK_DIR, "prompt.md"), "utf8");
  const toolsDoc = await readFile(join(TASK_DIR, "TOOLS.md"), "utf8");
  const playbook = await readFile(join(TASK_DIR, "PLAYBOOK.md"), "utf8");
  const outputDoc = await readFile(join(TASK_DIR, "OUTPUT.md"), "utf8");

  const inputMd = [
    "# Research task",
    "",
    `**User-supplied claim:** ${userClaim.trim()}`,
    "",
    `**Manifest directory (set as $MANIFEST):** \`${manifestDir}\``,
    `**Repo root (for tools path):** \`${repoRoot}\``,
    `**Year window:** ${years[0]}–${years[1]}`,
    `**Suggested claim id:** \`${claimId}\` (override with \`claim set\` if needed)`,
    "",
    `Always set \`MANIFEST=${manifestDir}\` in your shell and reference it.`,
    "",
    `First probe: \`bun tools/research.ts status --manifest ${manifestDir}\`.`,
    "",
    "When you are ready to hand off, write `report.md` per OUTPUT.md.",
  ].join("\n");

  // Bundle critical docs into stdin with filename labels. The same
  // files are also staged on disk for re-reference via `view`.
  const stdinPrompt = [
    promptTpl,
    "",
    "---",
    "",
    "The files below are embedded here **and** also staged on disk",
    "under the same filenames. You have already read them through",
    "this message; the disk copies exist for re-reference only.",
    "",
    "## INPUT.md",
    "",
    inputMd,
    "",
    "## PLAYBOOK.md",
    "",
    playbook,
    "",
    "## OUTPUT.md",
    "",
    outputDoc,
    "",
    "## TOOLS.md",
    "",
    toolsDoc,
  ].join("\n");

  const workspace = join(outDir, "workspace");
  const { json, reportMarkdown, reportPath, subagent } = await runSubagentTask({
    taskType: "research",
    workspaceDir: workspace,
    files: [
      { name: "INPUT.md", content: inputMd },
      { name: "TOOLS.md", content: toolsDoc },
      { name: "PLAYBOOK.md", content: playbook },
      { name: "OUTPUT.md", content: outputDoc },
    ],
    prompt: stdinPrompt,
    outputFilename: "report.md",
    schema: SummarySchema,
    cli: values.cli as "copilot" | "claude",
    model: values.model,
    timeoutMs: 60 * 60 * 1000,
    availableTools: ["bash", "view", "create", "edit", "report_intent", "task_complete"],
    maxAutopilotContinues: 40,
    promptVersion: PROMPT_VERSION,
    contractVersion: CONTRACT_VERSION,
    progress,
    runId,
  });

  // The manifest is the real output; copy the agent's report into the task dir.
  await writeArtifact({
    id: `research.${claimId}`,
    kind: "research",
    markdownPath: join(outDir, "report.md"),
    jsonPath: join(outDir, "summary.json"),
    markdown: reportMarkdown,
    json,
    frontmatter: {
      task: "research",
      status: "ok",
      inputs: [manifestDir],
      json: "summary.json",
    },
  });

  // Sanity checks against the manifest on disk.
  const corpusRows = await readCorpus(join(manifestDir, "papers.registry.jsonl"));
  const withFullText = corpusRows.filter((r) => r.fullText?.sectionsDetected).length;
  await progress.emit({
    runId,
    kind: "task-success",
    taskType: "research",
    message: `spec: ${json.includeQueryCount} include + ${json.excludeQueryCount} exclude queries, estimated ${json.estimatedCorpusSize} papers`,
    data: {
      claimId: json.claimId,
      includeQueryCount: json.includeQueryCount,
      excludeQueryCount: json.excludeQueryCount,
      estimatedCorpusSize: json.estimatedCorpusSize,
      taxonomyEvidenceClasses: json.taxonomyEvidenceClasses,
      scratchCorpusFetched: corpusRows.length,
      latencyMs: subagent.latencyMs,
    },
  });

  console.log(`[research] claim=${json.claimId}`);
  console.log(`[research] spec: ${json.includeQueryCount} include / ${json.excludeQueryCount} exclude queries`);
  console.log(`[research] evidence-class terms: ${(json.taxonomyEvidenceClasses ?? []).join(", ") || "(defaults from catalog)"}`);
  console.log(`[research] estimated corpus size: ${json.estimatedCorpusSize}`);
  console.log(`[research] scratch corpus (exploration sample, discarded by corpus-build): ${corpusRows.length} papers`);
  console.log(`[research] report: ${reportPath}`);
  console.log(`[research] manifest at: ${manifestDir}`);
  console.log(`[research] next: corpus-build against ${manifestDir}/claim-pack.json`);
}

function suggestClaimId(userClaim: string): string {
  const slug = userClaim
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 4)
    .join("-");
  return slug ? `claim-${slug}` : "claim-untitled";
}

const STOPWORDS = new Set([
  "the","and","for","with","from","that","this","are","been","has","have","had",
  "was","were","will","would","could","should","may","might","does","can","any",
  "all","some","such","than","then","there","these","those","into","onto","upon",
  "which","when","where","while","whether","whose","who","what","why","how",
]);

async function initManifest(args: {
  manifestDir: string;
  claimId: string;
  canonicalClaim: string;
  years: [number, number];
}): Promise<void> {
  const claimPath = join(args.manifestDir, "claim-pack.json");
  try {
    await stat(claimPath);
    // Already exists — leave it alone (resume).
    return;
  } catch {
    // Not yet initialized.
  }
  const pack = ClaimPackSchema.parse({
    id: args.claimId,
    canonicalClaim: args.canonicalClaim,
    aliases: [],
    includeQueries: [],
    excludeQueries: [],
    years: args.years,
    catalog: "biomed",
    subclaims: [],
  });
  await writeFile(claimPath, JSON.stringify(pack, null, 2) + "\n", "utf8");
  await writeFile(join(args.manifestDir, "papers.registry.jsonl"), "", "utf8");
  await mkdir(join(args.manifestDir, "papers"), { recursive: true });
}

async function readCorpus(path: string): Promise<PaperRegistryRow[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => PaperRegistryRowSchema.parse(JSON.parse(l)));
  } catch {
    return [];
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
