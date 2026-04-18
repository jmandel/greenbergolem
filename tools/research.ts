// Agent-callable research tools.
//
// Invoked from the research subagent via bash. Each subcommand emits JSON
// on stdout (for the agent to parse) and human-readable messages on stderr
// (so the agent can see progress). All commands are idempotent where
// possible.
//
// Usage:
//   bun tools/research.ts <subcommand> [flags]
//
// Subcommands:
//   search         PubMed / OpenAlex keyword search
//   fetch          Download one paper's full text (JATS + refs + body.md)
//   read           Dump a staged paper's abstract / body / refs
//   refs-tally     Count external cited IDs across the manifest's corpus
//   resolve        DOI/PMID → PMCID via NCBI ID converter
//   corpus add     Add papers to the manifest by PMCID
//   corpus remove  Remove a paper from the manifest
//   corpus list    Dump current corpus (summary or full JSON)
//   claim set      Update claim-pack fields (canonical, subclaims, ...)
//   claim get      Dump the claim pack JSON
//   status         Brief summary of the manifest's current state
//
// The manifest is kept as two files under the research out-dir:
//   claim-pack.json            — ClaimPack (canonical, subclaims, queries, taxonomies)
//   papers.registry.jsonl      — one PaperRegistryRow per line
// Plus papers/<paperId>/...    — fetched full-text bundles

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

import {
  ClaimPackSchema,
  PaperRegistryRowSchema,
  type ClaimPack,
  type PaperRegistryRow,
  type DiscoveryEntry,
} from "../contracts/index.ts";
import { esearch, esummary, articleIds, pmcOaFilter } from "../lib/pubmed.ts";
import { searchWorks, abstractFromInverted, bareOpenAlexId } from "../lib/openalex.ts";
import { idConvert, idConvertTyped, upgradeToPmcids } from "../lib/ncbi-idconv.ts";
import { fetchOne } from "../lib/fetch-fulltext.ts";
import { fetchPdfPaper } from "../lib/fetch-pdf.ts";
import { epmcLookup, epmcSearch, type EpmcHit } from "../lib/europepmc.ts";

// ---------- manifest I/O ----------

interface Manifest {
  claimPath: string;
  registryPath: string;
  papersDir: string;
  claim: ClaimPack;
  corpus: PaperRegistryRow[];
}

async function loadManifest(manifestDir: string): Promise<Manifest> {
  const claimPath = join(manifestDir, "claim-pack.json");
  const registryPath = join(manifestDir, "papers.registry.jsonl");
  const papersDir = join(manifestDir, "papers");
  let claim: ClaimPack;
  try {
    claim = ClaimPackSchema.parse(JSON.parse(await readFile(claimPath, "utf8")));
  } catch (e) {
    throw new Error(`manifest claim-pack.json not found or invalid at ${claimPath}: ${(e as Error).message}`);
  }
  let corpus: PaperRegistryRow[] = [];
  try {
    const text = await readFile(registryPath, "utf8");
    corpus = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => PaperRegistryRowSchema.parse(JSON.parse(l)));
  } catch {
    corpus = [];
  }
  return { claimPath, registryPath, papersDir, claim, corpus };
}

async function saveManifest(m: Manifest): Promise<void> {
  await mkdir(dirname(m.claimPath), { recursive: true });
  await writeFile(m.claimPath, JSON.stringify(m.claim, null, 2) + "\n", "utf8");
  const body = m.corpus.map((r) => JSON.stringify(r)).join("\n") + (m.corpus.length ? "\n" : "");
  await writeFile(m.registryPath, body, "utf8");
}

function paperIdFor(pmcid: string): string {
  return `paper-${pmcid.toLowerCase()}`;
}

function now(): string {
  return new Date().toISOString();
}

/** Append a discovery entry to an existing row, keeping discoveredVia in
 *  sync as a short summary. */
function appendTrace(row: PaperRegistryRow, entry: DiscoveryEntry): PaperRegistryRow {
  const trace = [...(row.discoveryTrace ?? []), entry];
  const summary = traceSummary(trace);
  return { ...row, discoveryTrace: trace, discoveredVia: summary };
}

/** Coerce a free-form `--discovered-via` string into a structured entry.
 *  The agent passes things like `"pubmed-search"`, `"refs-tally"`,
 *  `"manual"`. We parse the prefix to pick a `kind`. */
function parseDiscoveredVia(raw: string): DiscoveryEntry {
  const t = now();
  const lower = raw.toLowerCase();
  if (lower.includes("refs-tally") || lower.startsWith("tally")) {
    return { kind: "refs-tally", citedBy: [], countAtTime: 0, ts: t };
  }
  if (lower.startsWith("pubmed")) {
    const q = raw.replace(/^pubmed[-:\s]*/i, "").trim();
    return { kind: "query", source: "pubmed", query: q || "(unspecified)", ts: t };
  }
  if (lower.startsWith("openalex")) {
    const q = raw.replace(/^openalex[-:\s]*/i, "").trim();
    return { kind: "query", source: "openalex", query: q || "(unspecified)", ts: t };
  }
  if (lower.startsWith("preprint")) {
    const id = raw.replace(/^preprint[:\s]*/i, "").trim();
    return { kind: "preprint", preprintId: id, ts: t };
  }
  return { kind: "manual", note: raw, ts: t };
}

function traceSummary(trace: readonly DiscoveryEntry[]): string {
  return trace
    .map((e) => {
      switch (e.kind) {
        case "query": return `${e.source}:${e.query.slice(0, 60)}`;
        case "refs-tally": return `refs-tally×${e.countAtTime}`;
        case "manual": return e.note ? `manual:${e.note.slice(0, 60)}` : "manual";
        case "preprint": return `preprint:${e.preprintId}`;
        case "pdf-url": return `pdf`;
      }
    })
    .join("; ");
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function logErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

// ---------- subcommand: search ----------

async function cmdSearch(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string", default: "pubmed" },
      query: { type: "string" },
      limit: { type: "string", default: "50" },
      offset: { type: "string", default: "0" },
      sort: { type: "string", default: "relevance" },
      "min-year": { type: "string" },
      "max-year": { type: "string" },
      "date-type": { type: "string", default: "pdat" },     // pdat | edat
      // Default false: show the agent EVERYTHING the query returns,
      // including non-OA/no-PMCID papers. The agent can still opt into
      // filtering at search time (--pmc-oa-only) but the decision is
      // now explicit, and papers without full text are visible so the
      // agent can record them as abstract-only or flag the gap.
      "pmc-oa-only": { type: "boolean", default: false },
      // OpenAlex-specific: additional filter k=v,k=v passed straight through.
      filter: { type: "string" },
    },
  });
  const query = values.query;
  if (!query) throw new Error("--query is required");
  const limit = Math.max(1, Math.min(200, Number(values.limit) || 50));
  const offset = Math.max(0, Number(values.offset) || 0);
  const yMin = values["min-year"] ? Number(values["min-year"]) : undefined;
  const yMax = values["max-year"] ? Number(values["max-year"]) : undefined;

  if (values.source === "pubmed") {
    const term = values["pmc-oa-only"] ? `(${query}) AND ${pmcOaFilter()}` : query;
    const search = await esearch({
      db: "pubmed",
      term,
      retmax: limit,
      retstart: offset,
      mindate: yMin !== undefined ? String(yMin) : undefined,
      maxdate: yMax !== undefined ? String(yMax) : undefined,
      datetype: values["date-type"] as "pdat" | "edat",
      sort: values.sort as "relevance" | "pub_date" | "most_recent",
    });
    const summaries = search.idlist.length > 0 ? await esummary({ db: "pubmed", ids: search.idlist }) : [];
    const hits = summaries.map((s) => {
      const ids = articleIds(s);
      return {
        pmid: ids.pmid ?? s.uid,
        pmcid: ids.pmcid,
        doi: ids.doi,
        title: (s.title ?? "").replace(/\s+/g, " ").trim(),
        year: s.pubdate ? parseInt(s.pubdate.slice(0, 4), 10) : undefined,
        venue: s.source,
        authors: (s.authors ?? []).map((a) => a.name),
        pubtype: s.pubtype,
      };
    });
    logErr(`[search pubmed] "${query}" → ${search.count} total, returning ${hits.length}`);
    emit({ source: "pubmed", query, total: search.count, returned: hits.length, hits });
  } else if (values.source === "openalex") {
    // OpenAlex filter DSL is rich: concepts.id=..., is_retracted=true,
    // authorships.author.orcid=..., primary_location.source.id=...
    // See https://docs.openalex.org/api-entities/works/filter-works
    const extra: Record<string, string | boolean> = {};
    if (values.filter) {
      for (const kv of values.filter.split(",")) {
        const [k, ...rest] = kv.split("=");
        if (!k || rest.length === 0) continue;
        const v = rest.join("=");
        if (v === "true") extra[k.trim()] = true;
        else if (v === "false") extra[k.trim()] = false;
        else extra[k.trim()] = v;
      }
    }
    const page = await searchWorks({
      search: query,
      filter: {
        ...(yMin !== undefined ? { from_publication_date: `${yMin}-01-01` } : {}),
        ...(yMax !== undefined ? { to_publication_date: `${yMax}-12-31` } : {}),
        is_oa: true,
        type: "article",
        ...extra,
      },
      perPage: limit,
      sort: "cited_by_count:desc",
      select: ["id", "doi", "title", "publication_year", "type", "is_retracted",
               "authorships", "ids", "abstract_inverted_index", "primary_location",
               "best_oa_location", "cited_by_count"],
    });
    const hits = page.results.map((w) => ({
      openAlexId: bareOpenAlexId(w.id),
      doi: w.doi?.replace(/^https?:\/\/doi\.org\//i, ""),
      pmid: w.ids?.pmid?.replace(/^https?:\/\/[^/]+\/pubmed\//i, ""),
      pmcid: w.ids?.pmcid ? (w.ids.pmcid.match(/PMC\d+/i)?.[0] ?? undefined) : undefined,
      title: (w.title ?? w.display_name ?? "").replace(/\s+/g, " ").trim(),
      year: w.publication_year,
      venue: w.primary_location?.source?.display_name,
      citedByCount: w.cited_by_count,
      retracted: w.is_retracted ?? false,
      abstract: abstractFromInverted(w.abstract_inverted_index),
    }));
    logErr(`[search openalex] "${query}" → ${page.meta.count} total, returning ${hits.length}`);
    emit({ source: "openalex", query, total: page.meta.count, returned: hits.length, hits });
  } else {
    throw new Error(`unknown source: ${values.source}`);
  }
}

// ---------- subcommand: search-all ----------

/**
 * Paginate through every hit of a query, no `--limit` — for the "freeze
 * the query and exhaust it" phase. Primary use: the corpus-build task.
 * The exploration agent can also call this with `--safety-cap N` to see
 * how many papers a candidate query would return before committing.
 */
async function cmdSearchAll(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string", default: "pubmed" },
      query: { type: "string" },
      "min-year": { type: "string" },
      "max-year": { type: "string" },
      "pmc-oa-only": { type: "boolean", default: true },
      "safety-cap": { type: "string", default: "10000" },    // hard stop
      as: { type: "string", default: "pmcids" },              // pmcids | metadata
    },
  });
  const query = values.query;
  if (!query) throw new Error("--query is required");
  const yMin = values["min-year"] ? Number(values["min-year"]) : undefined;
  const yMax = values["max-year"] ? Number(values["max-year"]) : undefined;
  const safetyCap = Math.max(100, Number(values["safety-cap"]) || 10000);

  if (values.source === "pubmed") {
    const term = values["pmc-oa-only"] ? `(${query}) AND ${pmcOaFilter()}` : query;
    const PAGE = 200;          // PubMed max retmax per call
    const pmcids: string[] = [];
    const metadata: Array<{ pmid: string; pmcid?: string; doi?: string; title: string; year?: number; venue?: string }> = [];
    let total = 0;
    let offset = 0;
    let pages = 0;
    for (;;) {
      const search = await esearch({
        db: "pubmed",
        term,
        retmax: PAGE,
        retstart: offset,
        mindate: yMin !== undefined ? String(yMin) : undefined,
        maxdate: yMax !== undefined ? String(yMax) : undefined,
        datetype: "pdat",
        sort: "pub_date",      // stable for pagination
      });
      total = search.count;
      if (search.idlist.length === 0) break;
      pages++;
      const summaries = await esummary({ db: "pubmed", ids: search.idlist });
      for (const s of summaries) {
        const ids = articleIds(s);
        if (ids.pmcid) pmcids.push(ids.pmcid);
        if (values.as === "metadata") {
          metadata.push({
            pmid: ids.pmid ?? s.uid,
            pmcid: ids.pmcid,
            doi: ids.doi,
            title: (s.title ?? "").replace(/\s+/g, " ").trim(),
            year: s.pubdate ? parseInt(s.pubdate.slice(0, 4), 10) : undefined,
            venue: s.source,
          });
        }
      }
      offset += search.idlist.length;
      if (offset >= total) break;
      if (offset >= safetyCap) {
        logErr(`[search-all] safety cap reached (${safetyCap}) — stopping pagination at ${offset}/${total}`);
        break;
      }
    }
    logErr(`[search-all pubmed] "${query}" → ${total} total, collected ${pmcids.length} PMCIDs (${pages} pages)`);
    if (values.as === "metadata") emit({ source: "pubmed", query, total, returned: metadata.length, pages, metadata });
    else emit({ source: "pubmed", query, total, pages, pmcidCount: pmcids.length, pmcids });
  } else if (values.source === "openalex") {
    const PAGE = 200;
    const all: Array<{ pmcid?: string; doi?: string; pmid?: string; title: string; year?: number; citedByCount?: number; isRetracted?: boolean }> = [];
    let cursor: string | undefined = "*";
    let total = 0;
    let pages = 0;
    while (cursor) {
      const page = await searchWorks({
        search: query,
        filter: {
          ...(yMin !== undefined ? { from_publication_date: `${yMin}-01-01` } : {}),
          ...(yMax !== undefined ? { to_publication_date: `${yMax}-12-31` } : {}),
          is_oa: true,
          type: "article",
        },
        perPage: PAGE,
        cursor,
        select: ["id", "doi", "title", "publication_year", "is_retracted", "ids", "cited_by_count", "primary_location"],
      }) as { results: Array<any>; meta: { count: number; next_cursor?: string | null } };
      total = page.meta.count;
      if (page.results.length === 0) break;
      pages++;
      for (const w of page.results) {
        all.push({
          doi: w.doi?.replace(/^https?:\/\/doi\.org\//i, ""),
          pmid: w.ids?.pmid?.replace(/^https?:\/\/[^/]+\/pubmed\//i, ""),
          pmcid: w.ids?.pmcid ? (w.ids.pmcid.match(/PMC\d+/i)?.[0] ?? undefined) : undefined,
          title: (w.title ?? w.display_name ?? "").replace(/\s+/g, " ").trim(),
          year: w.publication_year,
          citedByCount: w.cited_by_count,
          isRetracted: w.is_retracted ?? false,
        });
        if (all.length >= safetyCap) break;
      }
      cursor = page.meta.next_cursor ?? undefined;
      if (!cursor || all.length >= safetyCap) break;
    }
    const pmcids = all.filter((h) => h.pmcid).map((h) => h.pmcid!);
    logErr(`[search-all openalex] "${query}" → ${total} total, collected ${all.length} records (${pmcids.length} w/ PMCID, ${pages} pages)`);
    if (values.as === "metadata") emit({ source: "openalex", query, total, returned: all.length, pages, metadata: all });
    else emit({ source: "openalex", query, total, pages, pmcidCount: pmcids.length, pmcids });
  } else {
    throw new Error(`unknown source: ${values.source}`);
  }
}

// ---------- subcommand: resolve ----------

async function cmdResolve(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      doi: { type: "string" },
      pmid: { type: "string" },
      pmcid: { type: "string" },
      "doi-list": { type: "string" },   // comma-separated
      "pmid-list": { type: "string" },
    },
  });
  const inputs: string[] = [];
  if (values.doi) inputs.push(values.doi);
  if (values.pmid) inputs.push(values.pmid);
  if (values.pmcid) inputs.push(values.pmcid);
  if (values["doi-list"]) inputs.push(...values["doi-list"].split(",").map((s) => s.trim()).filter(Boolean));
  if (values["pmid-list"]) inputs.push(...values["pmid-list"].split(",").map((s) => s.trim()).filter(Boolean));
  if (inputs.length === 0) throw new Error("pass --doi / --pmid / --pmcid / --doi-list / --pmid-list");
  const results = await idConvert(inputs);
  logErr(`[resolve] ${inputs.length} inputs → ${results.length} results`);
  emit({ results });
}

// ---------- subcommand: fetch ----------

async function cmdFetch(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      pmcid: { type: "string" },
      doi: { type: "string" },
      pmid: { type: "string" },
      // Batch mode: comma-separated lists. Mix freely.
      pmcids: { type: "string" },
      dois: { type: "string" },
      pmids: { type: "string" },
      manifest: { type: "string" },
      title: { type: "string", default: "" },
      "discovered-via": { type: "string", default: "manual" },
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");

  // Detect batch mode: any of --pmcids/--dois/--pmids supplied, or more
  // than one of the singular flags. Single-paper mode preserves the old
  // loud-fail contract.
  const batchInputs: Array<{ pmcid?: string; doi?: string; pmid?: string }> = [];
  if (values.pmcids) for (const s of splitList(values.pmcids)) batchInputs.push({ pmcid: s });
  if (values.dois) for (const s of splitList(values.dois)) batchInputs.push({ doi: s });
  if (values.pmids) for (const s of splitList(values.pmids)) batchInputs.push({ pmid: s });
  const singularCount = [values.pmcid, values.doi, values.pmid].filter(Boolean).length;
  const isBatch = batchInputs.length > 0 || singularCount > 1;
  if (isBatch) {
    if (values.pmcid) batchInputs.push({ pmcid: values.pmcid });
    if (values.doi) batchInputs.push({ doi: values.doi });
    if (values.pmid) batchInputs.push({ pmid: values.pmid });
    return cmdFetchBatch({
      manifest: values.manifest,
      inputs: batchInputs,
      // Concurrency is a policy knob set by the CLI, not the agent.
      // 4 is conservative for EuropePMC + NCBI combined; raise when
      // we have proper per-host rate limiters.
      concurrency: 4,
      discoveredVia: values["discovered-via"]!,
    });
  }

  const m = await loadManifest(values.manifest);

  let pmcid = values.pmcid;
  if (!pmcid && (values.doi || values.pmid)) {
    const results = await idConvertTyped(
      [values.doi ?? values.pmid!],
      values.doi ? "doi" : "pmid",
    );
    pmcid = results[0]?.pmcid;
    if (!pmcid) throw new Error(`no PMCID resolved for ${values.doi ?? values.pmid}`);
  }
  if (!pmcid) throw new Error("pass --pmcid or --doi or --pmid (or --pmcids / --dois / --pmids for batch)");
  if (!/^PMC\d+$/i.test(pmcid)) throw new Error(`invalid pmcid "${pmcid}"`);

  const paperId = paperIdFor(pmcid);
  // Build a minimal placeholder row so fetchOne can populate it from JATS.
  // Seed a discovery-trace entry from the --discovered-via argument: the
  // agent typically passes a query label ("pubmed-search") or a refs-tally
  // reason.
  const initialEntry = parseDiscoveredVia(values["discovered-via"] ?? "manual");
  const placeholder: PaperRegistryRow = PaperRegistryRowSchema.parse({
    paperId,
    ids: {
      pmcid,
      doi: values.doi,
      pmid: values.pmid,
    },
    title: values.title || "(pending)",
    authors: [],
    year: 0,
    discoveredVia: traceSummary([initialEntry]),
    discoveryTrace: [initialEntry],
  });

  logErr(`[fetch] ${pmcid} → ${m.papersDir}/${paperId}/`);
  const updated = await fetchOne(placeholder, m.papersDir.replace(/\/papers$/, ""));
  // fetchOne writes under <outDir>/papers/<paperId>/; we passed outDir as
  // the manifest dir, so papers ends up at <manifestDir>/papers/.

  // Verify metadata was populated from the JATS. If the fetch succeeded
  // at the network level but we couldn't extract title/year, that's a
  // real problem — either the JATS is malformed or our parser missed a
  // variant. Surface it rather than silently carrying a placeholder.
  if (!updated.title || updated.title === "(pending)") {
    throw new Error(`fetched ${pmcid} but could not extract a title from JATS — inspect papers/${paperId}/raw.xml`);
  }
  if (!updated.year || updated.year === 0) {
    throw new Error(`fetched ${pmcid} but could not extract a publication year from JATS — inspect papers/${paperId}/raw.xml`);
  }
  const enriched: PaperRegistryRow = updated;

  // Upsert into the manifest corpus. Re-fetches APPEND to the trace so
  // we don't lose prior discovery history if the same paper is pulled a
  // second time (e.g. first via query, later confirmed via refs-tally).
  const existingIdx = m.corpus.findIndex((r) => r.paperId === paperId);
  if (existingIdx >= 0) {
    const existing = m.corpus[existingIdx]!;
    const merged: PaperRegistryRow = {
      ...existing,
      ...enriched,
      discoveryTrace: existing.discoveryTrace ?? [],
    };
    m.corpus[existingIdx] = appendTrace(merged, initialEntry);
  } else {
    m.corpus.push(enriched);
  }
  await saveManifest(m);

  emit({
    paperId,
    pmcid,
    title: enriched.title,
    year: enriched.year,
    hasFullText: Boolean(enriched.fullText?.sectionsDetected),
    source: enriched.fullText?.source,
    refCount: enriched.fullText?.referencesTotal ?? 0,
    added: existingIdx < 0,
  });
}

function splitList(csv: string): string[] {
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

interface BatchTask {
  input: { pmcid?: string; doi?: string; pmid?: string };
  /** Final paperId — populated after id resolution. */
  paperId?: string;
  /** Final pmcid after idconv. */
  pmcid?: string;
  /** Outcome: "ok" | "skipped" | error message. */
  status: "pending" | "ok" | "skipped" | "error";
  reason?: string;
  durationMs?: number;
  addedToCorpus?: boolean;
}

/**
 * Batch variant of fetch. Resolves any DOI/PMID to PMCID via a single
 * batched idconv call, then fetches in parallel with bounded concurrency.
 * Writes the manifest ONCE at the end to avoid races. Per-paper failures
 * are recorded and returned in the summary — the batch does not abort
 * on a single-paper error.
 */
async function cmdFetchBatch(opts: {
  manifest: string;
  inputs: Array<{ pmcid?: string; doi?: string; pmid?: string }>;
  concurrency: number;
  discoveredVia: string;
}): Promise<void> {
  const m = await loadManifest(opts.manifest);
  const t0 = Date.now();

  // 1. Resolve DOIs/PMIDs → PMCIDs in one batched idconv pass.
  const dois = opts.inputs.map((i) => i.doi).filter((s): s is string => Boolean(s));
  const pmids = opts.inputs.map((i) => i.pmid).filter((s): s is string => Boolean(s));
  const doiToPmcid = new Map<string, string>();
  const pmidToPmcid = new Map<string, string>();
  if (dois.length > 0) {
    const r = await idConvertTyped(dois, "doi");
    for (const x of r) if (x.doi && x.pmcid) doiToPmcid.set(x.doi.toLowerCase(), x.pmcid);
  }
  if (pmids.length > 0) {
    const r = await idConvertTyped(pmids, "pmid");
    for (const x of r) if (x.pmid && x.pmcid) pmidToPmcid.set(String(x.pmid), x.pmcid);
  }

  // 2. Build tasks, skipping invalids and already-in-corpus.
  const tasks: BatchTask[] = opts.inputs.map((input) => {
    let pmcid = input.pmcid;
    if (!pmcid && input.doi) pmcid = doiToPmcid.get(input.doi.toLowerCase());
    if (!pmcid && input.pmid) pmcid = pmidToPmcid.get(input.pmid);
    if (!pmcid || !/^PMC\d+$/i.test(pmcid)) {
      return { input, status: "error", reason: "no PMCID resolved" };
    }
    const paperId = paperIdFor(pmcid);
    return { input, paperId, pmcid, status: "pending" };
  });
  const existingIds = new Set(m.corpus.map((r) => r.paperId));
  for (const t of tasks) {
    if (t.paperId && existingIds.has(t.paperId)) {
      t.status = "skipped";
      t.reason = "already in corpus";
    }
  }

  // 3. Run with bounded concurrency. Each worker clones a placeholder row,
  // calls fetchOne, upserts into a LOCAL map of results. We merge into
  // the manifest after all workers finish.
  const resultsByPaperId = new Map<string, PaperRegistryRow>();
  const outDir = m.papersDir.replace(/\/papers$/, "");
  const initialEntry = parseDiscoveredVia(opts.discoveredVia);

  const pendingTasks = tasks.filter((t) => t.status === "pending");
  let cursor = 0;
  const workerCount = Math.min(opts.concurrency, pendingTasks.length);
  const workers = Array.from({ length: Math.max(1, workerCount) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= pendingTasks.length) break;
      const t = pendingTasks[i]!;
      const startedAt = Date.now();
      try {
        const placeholder: PaperRegistryRow = PaperRegistryRowSchema.parse({
          paperId: t.paperId!,
          ids: { pmcid: t.pmcid!, doi: t.input.doi, pmid: t.input.pmid },
          title: "(pending)",
          authors: [],
          year: 0,
          discoveredVia: traceSummary([initialEntry]),
          discoveryTrace: [initialEntry],
        });
        const updated = await fetchOne(placeholder, outDir);
        if (!updated.title || updated.title === "(pending)") {
          t.status = "error";
          t.reason = "no title extracted from JATS";
        } else if (!updated.year || updated.year === 0) {
          t.status = "error";
          t.reason = "no year extracted from JATS";
        } else {
          resultsByPaperId.set(t.paperId!, updated);
          t.status = "ok";
          t.addedToCorpus = true;
        }
      } catch (e) {
        t.status = "error";
        t.reason = (e as Error).message;
      } finally {
        t.durationMs = Date.now() - startedAt;
        logErr(`[fetch ${t.pmcid ?? t.input.doi ?? t.input.pmid}] ${t.status}${t.reason ? ": " + t.reason : ""} (${t.durationMs}ms)`);
      }
    }
  });
  await Promise.all(workers);

  // 4. Merge results into the manifest. Reload from disk FIRST so we
  // don't clobber concurrent writes by other processes (e.g. a
  // separate agent fetching into the same manifest). Safe fallback
  // for the common single-writer case, essential if another writer
  // is active.
  const mLatest = await loadManifest(opts.manifest);
  for (const [paperId, row] of resultsByPaperId) {
    const idx = mLatest.corpus.findIndex((r) => r.paperId === paperId);
    if (idx >= 0) mLatest.corpus[idx] = { ...mLatest.corpus[idx]!, ...row };
    else mLatest.corpus.push(row);
  }
  await saveManifest(mLatest);
  m.corpus = mLatest.corpus;       // so the summary's corpusSize reflects the merged state

  const totalMs = Date.now() - t0;
  const ok = tasks.filter((t) => t.status === "ok").length;
  const skipped = tasks.filter((t) => t.status === "skipped").length;
  const errors = tasks.filter((t) => t.status === "error").length;
  logErr(`[fetch batch] ${ok} ok, ${skipped} skipped (already present), ${errors} errors — ${totalMs}ms wall`);
  emit({
    mode: "batch",
    concurrency: opts.concurrency,
    requested: tasks.length,
    ok,
    skipped,
    errors,
    totalMs,
    corpusSize: m.corpus.length,
    tasks: tasks.map((t) => ({
      input: t.input,
      paperId: t.paperId,
      pmcid: t.pmcid,
      status: t.status,
      reason: t.reason,
      durationMs: t.durationMs,
    })),
  });
}

// ---------- subcommand: fetch-pdf ----------

async function cmdFetchPdf(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      doi: { type: "string" },
      pmid: { type: "string" },
      pmcid: { type: "string" },
      "preprint-id": { type: "string" },      // e.g. PPR150909
      "pdf-url": { type: "string" },           // direct override, bypasses EuropePMC lookup
      "discovered-via": { type: "string", default: "manual-pdf" },
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);

  // If we have ONLY a preprint id, look it up via EuropePMC first so we
  // can populate at least a DOI before constructing the registry row —
  // PaperIdsSchema requires one of doi/pmid/pmcid/openAlex.
  let resolvedDoi = values.doi;
  let resolvedPmid = values.pmid;
  if (!values.doi && !values.pmid && !values.pmcid && values["preprint-id"]) {
    const ppr = values["preprint-id"].toUpperCase().startsWith("PPR")
      ? values["preprint-id"].toUpperCase()
      : `PPR${values["preprint-id"]}`;
    const hits = await epmcSearch({
      query: `EXT_ID:${ppr} AND SRC:PPR`,
      pageSize: 1,
    });
    if (hits.length > 0) {
      resolvedDoi = hits[0]!.doi ?? resolvedDoi;
      resolvedPmid = hits[0]!.pmid ?? resolvedPmid;
    }
  }
  if (!values.pmcid && !resolvedDoi && !resolvedPmid) {
    throw new Error("pass --pmcid, --doi, --pmid, or a --preprint-id that resolves to a DOI");
  }

  // Derive a stable paperId. Preference: pmcid > preprint-id > doi > pmid.
  const idKey =
    values.pmcid?.toLowerCase() ??
    values["preprint-id"]?.toLowerCase() ??
    (resolvedDoi ? `doi-${resolvedDoi.toLowerCase().replace(/[^a-z0-9]/g, "-")}` : undefined) ??
    (resolvedPmid ? `pmid-${resolvedPmid}` : undefined);
  if (!idKey) throw new Error("unable to derive a paperId");
  const paperId = `paper-${idKey}`;

  // Build a structured discovery trace for the PDF path. If a preprint
  // id was supplied, it gets its own entry alongside the user's reason.
  const pdfTrace: DiscoveryEntry[] = [parseDiscoveredVia(values["discovered-via"]!)];
  if (values["preprint-id"]) {
    pdfTrace.push({ kind: "preprint", preprintId: values["preprint-id"], ts: now() });
  }
  const placeholder: PaperRegistryRow = PaperRegistryRowSchema.parse({
    paperId,
    ids: {
      pmcid: values.pmcid,
      doi: resolvedDoi,
      pmid: resolvedPmid,
    },
    title: "(pending)",
    authors: [],
    year: 0,
    discoveredVia: traceSummary(pdfTrace),
    discoveryTrace: pdfTrace,
  });

  logErr(`[fetch-pdf] ${paperId} → ${m.papersDir}/${paperId}/`);
  const result = await fetchPdfPaper({
    row: placeholder,
    outDir: m.papersDir.replace(/\/papers$/, ""),
    pdfUrl: values["pdf-url"],
  });

  if (!result.row.title || result.row.title === "(pending)") {
    throw new Error(`fetched PDF for ${paperId} but no title resolved — check EuropePMC metadata`);
  }
  if (!result.row.year || result.row.year === 0) {
    logErr(`[fetch-pdf] warning: no year resolved for ${paperId}`);
  }

  // Append a pdf-url trace entry so we can audit where the bytes came from.
  const rowWithPdfTrace = appendTrace(result.row, {
    kind: "pdf-url",
    pdfUrl: result.pdfUrl,
    ts: now(),
  });

  // Upsert into the manifest corpus.
  const existingIdx = m.corpus.findIndex((r) => r.paperId === paperId);
  if (existingIdx >= 0) {
    const existing = m.corpus[existingIdx]!;
    m.corpus[existingIdx] = {
      ...existing,
      ...rowWithPdfTrace,
      discoveryTrace: [
        ...(existing.discoveryTrace ?? []),
        ...rowWithPdfTrace.discoveryTrace!,
      ],
    };
  } else {
    m.corpus.push(rowWithPdfTrace);
  }
  await saveManifest(m);

  emit({
    paperId,
    title: result.row.title,
    year: result.row.year,
    pdfUrl: result.pdfUrl,
    source: result.source?.source,
    hasFullText: true,
    sourceKind: "pdf-text",
    referencesParsed: result.referencesParsed,
    warning: "no structured references — this paper won't contribute outgoing edges",
    added: existingIdx < 0,
  });
}

// ---------- subcommand: resolve-preprint ----------

async function cmdResolvePreprint(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      doi: { type: "string" },
      pmid: { type: "string" },
      title: { type: "string" },
    },
  });
  const clauses: string[] = [];
  if (values.doi) clauses.push(`DOI:"${values.doi}"`);
  if (values.pmid) clauses.push(`EXT_ID:${values.pmid}`);
  if (values.title) clauses.push(`TITLE:"${values.title}"`);
  if (clauses.length === 0) throw new Error("pass --doi, --pmid, or --title");
  const query = `(${clauses.join(" OR ")}) AND SRC:PPR`;
  const hits = await epmcSearch({ query, pageSize: 5, resultType: "core" });
  if (hits.length === 0) {
    emit({ found: 0, hits: [] });
    return;
  }
  const payload = hits.map((h) => ({
    preprintId: h.id,
    source: h.source,
    doi: h.doi,
    title: h.title,
    year: h.pubYear,
    journal: h.journalTitle,
    hasFullText: h.hasFullText ?? false,
    pdfUrl: h.fullTextUrls?.find((u) => u.documentStyle === "pdf" && (u.availability === "Open access" || u.availability === "Free"))?.url,
    abstract: h.abstractText,
  }));
  emit({ found: hits.length, hits: payload });
}

// ---------- subcommand: read ----------

async function cmdRead(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      "paper-id": { type: "string" },
      pmcid: { type: "string" },
      what: { type: "string", default: "abstract" },   // abstract | body | refs | sections | all
      "max-chars": { type: "string", default: "4000" },
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);
  const paperId = values["paper-id"] ?? (values.pmcid ? paperIdFor(values.pmcid) : undefined);
  if (!paperId) throw new Error("pass --paper-id or --pmcid");
  const paperDir = join(m.papersDir, paperId);
  const maxChars = Math.max(200, Number(values["max-chars"]) || 4000);
  const out: Record<string, unknown> = { paperId };
  const row = m.corpus.find((r) => r.paperId === paperId);
  if (row) {
    out.title = row.title;
    out.year = row.year;
    out.ids = row.ids;
    out.discoveredVia = row.discoveredVia;
  }
  const want = values.what.split(",").map((s) => s.trim());
  if (want.includes("abstract") || want.includes("all")) {
    out.abstract = row?.abstract ?? "(not fetched)";
  }
  if (want.includes("body") || want.includes("all")) {
    try {
      const body = await readFile(join(paperDir, "body.md"), "utf8");
      out.body = body.length > maxChars ? body.slice(0, maxChars) + "\n\n[… truncated; raise --max-chars to see more …]" : body;
    } catch {
      out.body = "(not fetched)";
    }
  }
  if (want.includes("refs") || want.includes("all")) {
    try {
      const refs = JSON.parse(await readFile(join(paperDir, "references.json"), "utf8"));
      out.refCount = refs.length;
      out.refs = refs;
    } catch {
      out.refs = [];
      out.refCount = 0;
    }
  }
  if (want.includes("sections") || want.includes("all")) {
    try {
      const secs = JSON.parse(await readFile(join(paperDir, "sections.json"), "utf8"));
      out.sectionTitles = secs.map((s: { title?: string }) => s.title ?? "(untitled)");
    } catch {
      out.sectionTitles = [];
    }
  }
  emit(out);
}

// ---------- subcommand: refs-tally ----------

async function cmdRefsTally(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      "min-count": { type: "string", default: "3" },
      "exclude-in-corpus": { type: "boolean", default: true },
      limit: { type: "string", default: "30" },
      "id-type": { type: "string", default: "any" },    // pmcid | doi | pmid | any
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);
  const minCount = Math.max(1, Number(values["min-count"]) || 3);
  const limit = Math.max(1, Number(values.limit) || 30);
  const idMode = values["id-type"];

  // Track counts against the FIRST identifier present per reference, so a
  // single cited paper isn't double-counted under both pmcid and doi.
  // Prefer pmcid (fetchable) over doi over pmid for disambiguation.
  const corpusPmcids = new Set(m.corpus.map((r) => r.ids.pmcid).filter(Boolean) as string[]);
  const corpusDois = new Set(m.corpus.map((r) => r.ids.doi?.toLowerCase()).filter(Boolean) as string[]);
  const corpusPmids = new Set(m.corpus.map((r) => r.ids.pmid).filter(Boolean) as string[]);

  type Bucket = {
    kind: "pmcid" | "doi" | "pmid";
    key: string;
    count: number;
    citers: Set<string>;
    sample: { pmcid?: string; doi?: string; pmid?: string; title?: string };
  };
  const counts = new Map<string, Bucket>();
  let scanned = 0;
  let withRefs = 0;
  for (const row of m.corpus) {
    scanned++;
    const refsPath = join(m.papersDir, row.paperId, "references.json");
    let refs: Array<{ pmcid?: string; doi?: string; pmid?: string; title?: string }>;
    try {
      refs = JSON.parse(await readFile(refsPath, "utf8"));
    } catch {
      continue;
    }
    withRefs++;
    for (const r of refs) {
      let kind: "pmcid" | "doi" | "pmid" | undefined;
      let key: string | undefined;
      if (r.pmcid && (idMode === "any" || idMode === "pmcid")) { kind = "pmcid"; key = r.pmcid; }
      else if (r.doi && (idMode === "any" || idMode === "doi")) { kind = "doi"; key = r.doi.toLowerCase(); }
      else if (r.pmid && (idMode === "any" || idMode === "pmid")) { kind = "pmid"; key = r.pmid; }
      if (!kind || !key) continue;

      if (values["exclude-in-corpus"]) {
        if (kind === "pmcid" && corpusPmcids.has(key)) continue;
        if (kind === "doi" && corpusDois.has(key)) continue;
        if (kind === "pmid" && corpusPmids.has(key)) continue;
      }
      const mapKey = `${kind}:${key}`;
      const bucket = counts.get(mapKey) ?? {
        kind, key,
        count: 0, citers: new Set<string>(), sample: {},
      };
      bucket.count++;
      bucket.citers.add(row.paperId);
      if (!bucket.sample.title && r.title) bucket.sample.title = r.title;
      if (!bucket.sample.pmcid && r.pmcid) bucket.sample.pmcid = r.pmcid;
      if (!bucket.sample.doi && r.doi) bucket.sample.doi = r.doi;
      if (!bucket.sample.pmid && r.pmid) bucket.sample.pmid = r.pmid;
      counts.set(mapKey, bucket);
    }
  }
  const rows = [...counts.values()]
    .filter((v) => v.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((v) => ({
      idKind: v.kind,
      idKey: v.key,
      citations: v.count,
      fetchable: Boolean(v.sample.pmcid),
      citerSample: [...v.citers].slice(0, 5),
      ...v.sample,
    }));
  const kindHist: Record<string, number> = {};
  for (const v of counts.values()) kindHist[v.kind] = (kindHist[v.kind] ?? 0) + 1;
  logErr(`[refs-tally] scanned ${scanned} corpus papers (${withRefs} with refs) — returning ${rows.length} external refs with ≥${minCount} internal citers (kinds: ${JSON.stringify(kindHist)})`);
  emit({ scanned, withRefs, totalExternalCandidates: counts.size, kindHist, threshold: minCount, returned: rows.length, rows });
}

// ---------- subcommand: corpus ----------

async function cmdCorpus(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "list") return cmdCorpusList(rest);
  if (sub === "add") return cmdCorpusAdd(rest);
  if (sub === "remove") return cmdCorpusRemove(rest);
  if (sub === "retract") return cmdCorpusRetract(rest);
  throw new Error(`unknown corpus subcommand: ${sub}. use: list | add | remove | retract`);
}

async function cmdCorpusList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      format: { type: "string", default: "summary" },
      "only-retracted": { type: "boolean", default: false },
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);
  let rows = m.corpus;
  if (values["only-retracted"]) rows = rows.filter((r) => r.retracted?.isRetracted);
  if (values.format === "summary") {
    const summary = {
      total: m.corpus.length,
      retracted: m.corpus.filter((r) => r.retracted?.isRetracted).length,
      withFullText: m.corpus.filter((r) => r.fullText?.sectionsDetected).length,
      byYear: m.corpus.reduce((acc, r) => {
        const k = String(r.year);
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      rows: rows.map((r) => ({
        paperId: r.paperId,
        pmcid: r.ids.pmcid,
        title: r.title.slice(0, 100),
        year: r.year,
        retracted: r.retracted?.isRetracted ?? false,
        hasFullText: Boolean(r.fullText?.sectionsDetected),
        via: r.discoveredVia,
      })),
    };
    emit(summary);
  } else {
    emit({ rows });
  }
}

async function cmdCorpusAdd(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      pmcid: { type: "string" },
      pmcids: { type: "string" },
      title: { type: "string", default: "(pending)" },
      year: { type: "string", default: "0" },
      "discovered-via": { type: "string", default: "manual" },
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);
  const list = values.pmcids
    ? values.pmcids.split(",").map((s) => s.trim()).filter(Boolean)
    : values.pmcid ? [values.pmcid] : [];
  if (list.length === 0) throw new Error("pass --pmcid or --pmcids");
  let added = 0;
  let existed = 0;
  for (const pmcid of list) {
    if (!/^PMC\d+$/i.test(pmcid)) { logErr(`[corpus add] skipping invalid ${pmcid}`); continue; }
    const paperId = paperIdFor(pmcid);
    if (m.corpus.some((r) => r.paperId === paperId)) {
      existed++;
      continue;
    }
    const entry = parseDiscoveredVia(values["discovered-via"]!);
    m.corpus.push(PaperRegistryRowSchema.parse({
      paperId,
      ids: { pmcid },
      title: values.title,
      authors: [],
      year: Number(values.year) || 0,
      discoveredVia: traceSummary([entry]),
      discoveryTrace: [entry],
    }));
    added++;
  }
  await saveManifest(m);
  logErr(`[corpus add] ${added} added, ${existed} already present`);
  emit({ added, existed, corpusSize: m.corpus.length });
}

async function cmdCorpusRemove(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      "paper-id": { type: "string" },
      pmcid: { type: "string" },
      reason: { type: "string", default: "" },
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);
  const paperId = values["paper-id"] ?? (values.pmcid ? paperIdFor(values.pmcid) : undefined);
  if (!paperId) throw new Error("pass --paper-id or --pmcid");
  const before = m.corpus.length;
  m.corpus = m.corpus.filter((r) => r.paperId !== paperId);
  await saveManifest(m);
  const removed = before - m.corpus.length;
  logErr(`[corpus remove] ${removed} removed (reason: ${values.reason})`);
  emit({ removed, corpusSize: m.corpus.length });
}

async function cmdCorpusRetract(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      "paper-id": { type: "string" },
      pmcid: { type: "string" },
      date: { type: "string" },
      reason: { type: "string", default: "" },
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);
  const paperId = values["paper-id"] ?? (values.pmcid ? paperIdFor(values.pmcid) : undefined);
  if (!paperId) throw new Error("pass --paper-id or --pmcid");
  const idx = m.corpus.findIndex((r) => r.paperId === paperId);
  if (idx < 0) throw new Error(`paper ${paperId} not in corpus`);
  const r = m.corpus[idx]!;
  m.corpus[idx] = {
    ...r,
    retracted: {
      isRetracted: true,
      retractionDate: values.date,
      retractionReason: values.reason,
    },
  };
  await saveManifest(m);
  emit({ paperId, retracted: true });
}

// ---------- subcommand: claim ----------

async function cmdClaim(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "get") return cmdClaimGet(rest);
  if (sub === "set") return cmdClaimSet(rest);
  throw new Error(`unknown claim subcommand: ${sub}. use: get | set`);
}

async function cmdClaimGet(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { manifest: { type: "string" } },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);
  emit(m.claim);
}

async function cmdClaimSet(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      "from-file": { type: "string" },          // write a full ClaimPack JSON
      canonical: { type: "string" },
      "add-alias": { type: "string" },
      "add-subclaim": { type: "string" },        // "sc1:Text of subclaim"
      "reviewer-notes": { type: "string" },
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);
  if (values["from-file"]) {
    const raw = JSON.parse(await readFile(values["from-file"], "utf8"));
    m.claim = ClaimPackSchema.parse(raw);
  } else {
    if (values.canonical) m.claim = { ...m.claim, canonicalClaim: values.canonical };
    if (values["reviewer-notes"]) m.claim = { ...m.claim, reviewerNotes: values["reviewer-notes"] };
    if (values["add-alias"]) m.claim = { ...m.claim, aliases: [...m.claim.aliases, values["add-alias"]] };
    if (values["add-subclaim"]) {
      const parts = values["add-subclaim"].split(":");
      if (parts.length < 2) throw new Error('subclaim format: "sc1:text"');
      const [id, ...text] = parts;
      m.claim = {
        ...m.claim,
        subclaims: [...m.claim.subclaims, { id: id!, text: text.join(":") }],
      };
    }
  }
  await saveManifest(m);
  emit(m.claim);
}

// Taxonomy is managed via the claim pack's `taxonomyRefinements` and
// `customTerms` fields, written directly into the manifest's claim
// pack JSON. The old `taxonomies set/get` subcommands were retired
// because the new authored-spec model expects the agent to pick from
// the canonical catalog and refine inline, not build a vocabulary
// from scratch.

// ---------- subcommand: status ----------

async function cmdStatus(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { manifest: { type: "string" } },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  const m = await loadManifest(values.manifest);
  const byYear = m.corpus.reduce((acc, r) => {
    const k = String(r.year);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  emit({
    claim: {
      id: m.claim.id,
      canonicalClaim: m.claim.canonicalClaim,
      subclaims: m.claim.subclaims.length,
      aliases: m.claim.aliases.length,
      includeQueries: m.claim.includeQueries.length,
      excludeQueries: m.claim.excludeQueries.length,
      hasTaxonomies: Boolean(m.claim.taxonomies),
    },
    corpus: {
      total: m.corpus.length,
      retracted: m.corpus.filter((r) => r.retracted?.isRetracted).length,
      withFullText: m.corpus.filter((r) => r.fullText?.sectionsDetected).length,
      byYear,
    },
  });
}

// ---------- subcommand: init ----------

async function cmdInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string" },
      "claim-id": { type: "string" },
      canonical: { type: "string" },
      "years": { type: "string", default: "2020-2024" },
    },
  });
  if (!values.manifest) throw new Error("--manifest <dir> required");
  if (!values["claim-id"]) throw new Error("--claim-id required (e.g. claim-hcq-covid-outcomes)");
  if (!values.canonical) throw new Error("--canonical required");
  const [y0, y1] = values["years"]!.split("-").map((s) => Number(s));
  const claim: ClaimPack = ClaimPackSchema.parse({
    id: values["claim-id"],
    canonicalClaim: values.canonical,
    aliases: [],
    includeQueries: [],
    excludeQueries: [],
    years: [y0 || 2020, y1 || 2024],
    domain: "biomed",
    subclaims: [],
  });
  const m: Manifest = {
    claimPath: join(values.manifest, "claim-pack.json"),
    registryPath: join(values.manifest, "papers.registry.jsonl"),
    papersDir: join(values.manifest, "papers"),
    claim,
    corpus: [],
  };
  await saveManifest(m);
  await mkdir(m.papersDir, { recursive: true });
  logErr(`[init] manifest created at ${values.manifest}`);
  emit({ manifest: values.manifest, claim: m.claim });
}

// ---------- main ----------

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === "--help" || sub === "-h") {
    logErr(`research tool — subcommands:
  init           initialize a new manifest
  status         summarize manifest state
  search         pubmed/openalex keyword search (sampled, --limit N)
  search-all     pubmed/openalex paginated to exhaustion (returns all PMCIDs)
  resolve        doi/pmid → pmcid via idconv
  resolve-preprint  find a preprint (EuropePMC SRC:PPR) by doi/pmid/title
  fetch          download one paper's JATS full text and add to corpus
  fetch-pdf      download a paper's PDF (preprints / paywalled-with-OA-PDF)
                 and extract text via pdftotext; no structured refs
  read           dump a staged paper's abstract / body / refs
  refs-tally     external PMCIDs frequently cited by corpus papers
  corpus <add|remove|retract|list>
  claim  <get|set>
  taxonomies set --from-file <json>

All commands accept --manifest <dir>. Most emit JSON on stdout.`);
    return;
  }
  switch (sub) {
    case "init": return cmdInit(rest);
    case "status": return cmdStatus(rest);
    case "search": return cmdSearch(rest);
    case "search-all": return cmdSearchAll(rest);
    case "resolve": return cmdResolve(rest);
    case "fetch": return cmdFetch(rest);
    case "fetch-pdf": return cmdFetchPdf(rest);
    case "resolve-preprint": return cmdResolvePreprint(rest);
    case "read": return cmdRead(rest);
    case "refs-tally": return cmdRefsTally(rest);
    case "corpus": return cmdCorpus(rest);
    case "claim": return cmdClaim(rest);
    default: throw new Error(`unknown subcommand: ${sub}`);
  }
}

main().catch((e) => {
  logErr(`error: ${(e as Error).message}`);
  process.exit(1);
});
