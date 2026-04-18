// corpus-build: deterministic construction of the paper corpus from
// the authored claim pack.
//
// Input:  claim-pack.json with includeQueries, excludeQueries, years.
// Output: papers.registry.jsonl + papers/<paperId>/... + corpus.json stats
//
// Greenberg-style: every paper matching an includeQuery is pulled in
// (subject to excludeQueries and full-text availability), not a
// sampled top-N. Semantic screening happens later in paper-profile.
//
// Landmark papers enter the corpus by having their own narrow include
// query (`"<DOI>"[AID]` or `"<PMID>"[PMID]`). There is no separate
// anchor mechanism.
//
// Steps:
//   1. For each includeQuery, paginate all hits → union PMCIDs.
//   2. For each excludeQuery, paginate all hits → exclude set.
//   3. Subtract: candidate = union(include) − union(exclude).
//   4. Batch-fetch all candidates; write PaperRegistryRows + full-text
//      bundles.
//   5. Write corpus.json with provenance per paper (which queries
//      matched it).

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import {
  ClaimPackSchema,
  PaperRegistryRowSchema,
  type ClaimPack,
  type PaperRegistryRow,
  type DiscoveryEntry,
  type SearchQuery,
} from "../../contracts/index.ts";
import { esearch, esummary, articleIds, pmcOaFilter } from "../../lib/pubmed.ts";
import { searchWorks, bareOpenAlexId } from "../../lib/openalex.ts";
import { idConvertTyped, upgradeToPmcids } from "../../lib/ncbi-idconv.ts";
import { fetchOne } from "../../lib/fetch-fulltext.ts";
import { writeArtifact } from "../../lib/artifacts.ts";
import { ProgressLog } from "../../orchestrator/progress.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      "run-id": { type: "string" },
      "claim-json": { type: "string" },
      concurrency: { type: "string", default: "6" },
      "safety-cap-per-query": { type: "string", default: "10000" },
      "max-fetch": { type: "string", default: "5000" },         // total fetch ceiling
      "dry-run": { type: "boolean", default: false },            // do search, skip fetch
    },
  });

  const outDir = values["out-dir"];
  const claimPath = values["claim-json"];
  if (!outDir || !claimPath) {
    console.error("usage: --out-dir <dir> --claim-json <path> [--concurrency N] [--max-fetch N] [--dry-run]");
    process.exit(2);
  }
  const runId = values["run-id"] ?? "ad-hoc";
  const conc = Math.max(1, Math.min(8, Number(values.concurrency) || 6));
  const safetyCap = Math.max(100, Number(values["safety-cap-per-query"]) || 10000);
  const maxFetch = Math.max(10, Number(values["max-fetch"]) || 5000);
  const progress = new ProgressLog(join(outDir, "..", "progress.jsonl"));

  await mkdir(outDir, { recursive: true });
  const claim = ClaimPackSchema.parse(JSON.parse(await readFile(claimPath, "utf8"))) as ClaimPack;

  if (claim.includeQueries.length === 0) {
    console.error("[corpus-build] ClaimPack has no includeQueries — the research agent must supply them before this step.");
    process.exit(2);
  }

  await progress.emit({
    runId,
    kind: "task-start",
    taskType: "corpus-build",
    message: `${claim.includeQueries.length} include, ${claim.excludeQueries.length} exclude queries`,
  });

  const [yClaimMin, yClaimMax] = claim.years;
  const ts = new Date().toISOString();

  // ---- 1. Include queries → PMCID union ----
  const includeMatches = new Map<string, Set<number>>(); // pmcid -> set of includeQuery indices
  const includeStats: Array<{ query: SearchQuery; total: number; pmcidCount: number; pages: number }> = [];
  for (let i = 0; i < claim.includeQueries.length; i++) {
    const q = claim.includeQueries[i]!;
    const { pmcids, total, pages } = await runQueryExhaustive({
      q,
      yMin: q.minYear ?? yClaimMin,
      yMax: q.maxYear ?? yClaimMax,
      safetyCap,
    });
    includeStats.push({ query: q, total, pmcidCount: pmcids.length, pages });
    for (const p of pmcids) {
      const bucket = includeMatches.get(p) ?? new Set<number>();
      bucket.add(i);
      includeMatches.set(p, bucket);
    }
    await progress.emit({
      runId, kind: "note", taskType: "corpus-build",
      message: `include[${i}] "${q.query}" (${q.source}) → ${total} total, ${pmcids.length} w/ PMCID, ${pages} pages`,
    });
  }

  // ---- 2. Exclude queries → PMCID set ----
  const excludeSet = new Set<string>();
  const excludeStats: Array<{ query: SearchQuery; total: number; pmcidCount: number; pages: number }> = [];
  for (let i = 0; i < claim.excludeQueries.length; i++) {
    const q = claim.excludeQueries[i]!;
    const { pmcids, total, pages } = await runQueryExhaustive({
      q,
      yMin: q.minYear ?? yClaimMin,
      yMax: q.maxYear ?? yClaimMax,
      safetyCap,
    });
    excludeStats.push({ query: q, total, pmcidCount: pmcids.length, pages });
    for (const p of pmcids) excludeSet.add(p);
    await progress.emit({
      runId, kind: "note", taskType: "corpus-build",
      message: `exclude[${i}] "${q.query}" (${q.source}) → ${total} total, ${pmcids.length} w/ PMCID, ${pages} pages`,
    });
  }

  // ---- 3. Subtract exclude from include ----
  // Final candidate = union(include) − union(exclude). No separate
  // "anchor override" — landmarks enter the corpus via narrow per-paper
  // queries (e.g. `"<DOI>"[AID]`) in includeQueries.
  const candidateFromQueries = new Map<string, Set<number>>();
  let excluded = 0;
  for (const [pmcid, qIdx] of includeMatches) {
    if (excludeSet.has(pmcid)) { excluded++; continue; }
    candidateFromQueries.set(pmcid, qIdx);
  }

  const candidatePmcids = new Set<string>(candidateFromQueries.keys());

  await progress.emit({
    runId, kind: "note", taskType: "corpus-build",
    message: `candidate: ${candidatePmcids.size} papers (${excluded} removed by exclude-queries)`,
  });

  if (values["dry-run"]) {
    const summary = buildCorpusSummary({
      claim, includeStats, excludeStats, excluded,
      candidatePmcids, fetched: [], failed: [], ts, dryRun: true,
    });
    await writeArtifact({
      id: `corpus-build.${claim.id}`,
      kind: "corpus-build",
      markdownPath: join(outDir, "report.md"),
      jsonPath: join(outDir, "corpus.json"),
      markdown: renderReportMd(summary),
      json: summary,
      frontmatter: { task: "corpus-build", status: "ok", inputs: [claimPath], json: "corpus.json" },
    });
    console.log(`[corpus-build] DRY RUN — ${candidatePmcids.size} papers would be fetched`);
    return;
  }

  // ---- 5. Batch-fetch with bounded concurrency ----
  const candidates = [...candidatePmcids].slice(0, maxFetch);
  if (candidates.length < candidatePmcids.size) {
    await progress.emit({
      runId, kind: "note", taskType: "corpus-build",
      message: `WARNING: candidate set ${candidatePmcids.size} exceeds --max-fetch ${maxFetch}; fetching first ${maxFetch} only`,
    });
  }

  const fetched: PaperRegistryRow[] = [];
  const failed: Array<{ pmcid: string; reason: string }> = [];

  let cursor = 0;
  const workers = Array.from({ length: Math.min(conc, candidates.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) break;
      const pmcid = candidates[i]!;
      const paperId = paperIdFor(pmcid);
      const discovery = buildDiscoveryTrace({
        pmcid, ts,
        matchingQueryIdx: candidateFromQueries.get(pmcid) ?? new Set(),
        queries: claim.includeQueries,
      });
      const placeholder: PaperRegistryRow = PaperRegistryRowSchema.parse({
        paperId,
        ids: { pmcid },
        title: "(pending)",
        authors: [],
        year: 0,
        discoveredVia: discovery.map((e) => summarizeEntry(e)).join("; "),
        discoveryTrace: discovery,
      });
      try {
        const updated = await fetchOne(placeholder, outDir);
        if (!updated.title || updated.title === "(pending)") {
          failed.push({ pmcid, reason: "no title extracted from JATS" });
          continue;
        }
        if (!updated.year || updated.year === 0) {
          failed.push({ pmcid, reason: "no year extracted from JATS" });
          continue;
        }
        fetched.push(updated);
        if (fetched.length % 25 === 0) {
          await progress.emit({
            runId, kind: "note", taskType: "corpus-build",
            message: `fetched ${fetched.length}/${candidates.length} (${failed.length} failed)`,
          });
        }
      } catch (e) {
        failed.push({ pmcid, reason: (e as Error).message });
      }
    }
  });
  await Promise.all(workers);

  // ---- 6. Write the registry + summary artifacts ----
  const registryJsonl = join(outDir, "papers.registry.jsonl");
  await writeFile(
    registryJsonl,
    fetched.map((r) => JSON.stringify(r)).join("\n") + (fetched.length ? "\n" : ""),
    "utf8",
  );

  const summary = buildCorpusSummary({
    claim, includeStats, excludeStats, excluded,
    candidatePmcids, fetched, failed, ts, dryRun: false,
  });
  await writeArtifact({
    id: `corpus-build.${claim.id}`,
    kind: "corpus-build",
    markdownPath: join(outDir, "report.md"),
    jsonPath: join(outDir, "corpus.json"),
    markdown: renderReportMd(summary),
    json: summary,
    frontmatter: { task: "corpus-build", status: failed.length > fetched.length / 10 ? "needs-review" : "ok", inputs: [claimPath], json: "corpus.json" },
  });

  await progress.emit({
    runId, kind: "task-success", taskType: "corpus-build",
    message: `${fetched.length} fetched, ${failed.length} failed`,
    data: {
      claimId: claim.id,
      candidateCount: candidatePmcids.size,
      fetched: fetched.length,
      failed: failed.length,
    },
  });

  console.log(`[corpus-build] claim=${claim.id}`);
  console.log(`[corpus-build] candidate set: ${candidatePmcids.size} papers (from ${claim.includeQueries.length} include − ${claim.excludeQueries.length} exclude queries)`);
  console.log(`[corpus-build] fetched ${fetched.length}, failed ${failed.length}`);
  console.log(`[corpus-build] registry: ${registryJsonl}`);
}

// ---------- helpers ----------

async function runQueryExhaustive(args: {
  q: SearchQuery;
  yMin: number;
  yMax: number;
  safetyCap: number;
}): Promise<{ pmcids: string[]; total: number; pages: number }> {
  const { q, yMin, yMax, safetyCap } = args;
  if (q.source === "pubmed") {
    const term = `(${q.query}) AND ${pmcOaFilter()}`;
    const PAGE = 200;
    const pmcids: string[] = [];
    let total = 0;
    let pages = 0;
    let offset = 0;
    for (;;) {
      const search = await esearch({
        db: "pubmed",
        term,
        retmax: PAGE,
        retstart: offset,
        mindate: String(yMin),
        maxdate: String(yMax),
        datetype: "pdat",
        sort: "pub_date",
      });
      total = search.count;
      if (search.idlist.length === 0) break;
      pages++;
      const summaries = await esummary({ db: "pubmed", ids: search.idlist });
      for (const s of summaries) {
        const ids = articleIds(s);
        if (ids.pmcid) pmcids.push(ids.pmcid);
      }
      offset += search.idlist.length;
      if (offset >= total) break;
      if (offset >= safetyCap) break;
    }
    return { pmcids: dedup(pmcids), total, pages };
  } else if (q.source === "openalex") {
    const PAGE = 200;
    const records: Array<{ pmcid?: string; doi?: string; pmid?: string }> = [];
    let cursor: string | undefined = "*";
    let total = 0;
    let pages = 0;
    while (cursor) {
      const page = await searchWorks({
        search: q.query,
        filter: {
          from_publication_date: `${yMin}-01-01`,
          to_publication_date: `${yMax}-12-31`,
          is_oa: true,
          type: "article",
        },
        perPage: PAGE,
        cursor,
        select: ["id", "doi", "ids", "publication_year"],
      }) as { results: Array<any>; meta: { count: number; next_cursor?: string | null } };
      total = page.meta.count;
      if (page.results.length === 0) break;
      pages++;
      for (const w of page.results) {
        records.push({
          doi: w.doi?.replace(/^https?:\/\/doi\.org\//i, ""),
          pmid: w.ids?.pmid?.replace(/^https?:\/\/[^/]+\/pubmed\//i, ""),
          pmcid: w.ids?.pmcid ? (w.ids.pmcid.match(/PMC\d+/i)?.[0] ?? undefined) : undefined,
        });
        if (records.length >= safetyCap) break;
      }
      cursor = page.meta.next_cursor ?? undefined;
      if (!cursor || records.length >= safetyCap) break;
    }
    // Upgrade DOI/PMID-only records to PMCIDs via idconv.
    const upgraded = await upgradeToPmcids(records);
    const pmcids = upgraded.map((r) => r.pmcid).filter((p): p is string => Boolean(p));
    return { pmcids: dedup(pmcids), total, pages };
  } else {
    throw new Error(`unknown source in SearchQuery: ${q.source}`);
  }
}

function buildDiscoveryTrace(args: {
  pmcid: string;
  ts: string;
  matchingQueryIdx: Set<number>;
  queries: readonly SearchQuery[];
}): DiscoveryEntry[] {
  const out: DiscoveryEntry[] = [];
  for (const i of args.matchingQueryIdx) {
    const q = args.queries[i];
    if (!q) continue;
    out.push({
      kind: "query",
      source: q.source,
      query: q.query,
      rationale: q.rationale,
      ts: args.ts,
    });
  }
  if (out.length === 0) out.push({ kind: "manual", note: "corpus-build (no query-match recorded)", ts: args.ts });
  return out;
}

function summarizeEntry(e: DiscoveryEntry): string {
  switch (e.kind) {
    case "query":
      return e.rationale
        ? `${e.source}:${e.query.slice(0, 40)} (${e.rationale.slice(0, 40)})`
        : `${e.source}:${e.query.slice(0, 60)}`;
    case "refs-tally": return `refs-tally×${e.countAtTime}`;
    case "manual": return e.note ? `manual:${e.note.slice(0, 60)}` : "manual";
    case "preprint": return `preprint:${e.preprintId}`;
    case "pdf-url": return "pdf";
  }
}

function paperIdFor(pmcid: string): string {
  return `paper-${pmcid.toLowerCase()}`;
}

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

interface CorpusSummary {
  claimId: string;
  canonicalClaim: string;
  includeStats: Array<{ query: SearchQuery; total: number; pmcidCount: number; pages: number }>;
  excludeStats: Array<{ query: SearchQuery; total: number; pmcidCount: number; pages: number }>;
  excluded: number;
  candidateCount: number;
  fetched: number;
  failed: Array<{ pmcid: string; reason: string }>;
  byYear: Record<string, number>;
  dryRun: boolean;
  ts: string;
}

function buildCorpusSummary(args: {
  claim: ClaimPack;
  includeStats: CorpusSummary["includeStats"];
  excludeStats: CorpusSummary["excludeStats"];
  excluded: number;
  candidatePmcids: Set<string>;
  fetched: PaperRegistryRow[];
  failed: Array<{ pmcid: string; reason: string }>;
  ts: string;
  dryRun: boolean;
}): CorpusSummary {
  const byYear: Record<string, number> = {};
  for (const r of args.fetched) byYear[String(r.year)] = (byYear[String(r.year)] ?? 0) + 1;
  return {
    claimId: args.claim.id,
    canonicalClaim: args.claim.canonicalClaim,
    includeStats: args.includeStats,
    excludeStats: args.excludeStats,
    excluded: args.excluded,
    candidateCount: args.candidatePmcids.size,
    fetched: args.fetched.length,
    failed: args.failed,
    byYear,
    dryRun: args.dryRun,
    ts: args.ts,
  };
}

function renderReportMd(s: CorpusSummary): string {
  const lines: string[] = [];
  lines.push(`# corpus-build report`);
  lines.push("");
  lines.push(`Claim: **${s.canonicalClaim}**`);
  lines.push(`Claim id: \`${s.claimId}\``);
  if (s.dryRun) lines.push(`**DRY RUN** — no papers fetched.`);
  lines.push("");
  lines.push(`## Inclusion queries`);
  lines.push("");
  for (const x of s.includeStats) {
    lines.push(`- (${x.query.source}) \`${x.query.query}\` — ${x.total} total, ${x.pmcidCount} with PMCID, ${x.pages} pages${x.query.rationale ? ` — _${x.query.rationale}_` : ""}`);
  }
  lines.push("");
  lines.push(`## Exclusion queries`);
  lines.push("");
  if (s.excludeStats.length === 0) lines.push(`_(none)_`);
  for (const x of s.excludeStats) {
    lines.push(`- (${x.query.source}) \`${x.query.query}\` — ${x.total} total, ${x.pmcidCount} with PMCID, ${x.pages} pages`);
  }
  lines.push("");
  lines.push(`## Totals`);
  lines.push("");
  lines.push(`- Candidate set size: **${s.candidateCount}** (union of includes − excludes)`);
  lines.push(`- Excluded by exclude-queries: ${s.excluded}`);
  if (!s.dryRun) {
    lines.push(`- Fetched (full text OK): **${s.fetched}**`);
    lines.push(`- Failed to fetch: ${s.failed.length}`);
  }
  lines.push("");
  if (!s.dryRun) {
    lines.push(`## Year distribution`);
    lines.push("");
    for (const [y, n] of Object.entries(s.byYear).sort(([a], [b]) => Number(a) - Number(b))) {
      lines.push(`- ${y}: ${n}`);
    }
    if (s.failed.length > 0) {
      lines.push("");
      lines.push(`## Fetch failures`);
      lines.push("");
      for (const f of s.failed.slice(0, 30)) lines.push(`- ${f.pmcid}: ${f.reason}`);
      if (s.failed.length > 30) lines.push(`- …and ${s.failed.length - 30} more`);
    }
  }
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
