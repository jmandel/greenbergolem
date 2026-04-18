// PDF-based fetcher for papers EuropePMC/NCBI don't serve as JATS.
// Covers the preprint and paywalled-with-OA-PDF cases where we have
// a URL to a PDF but no structured XML.
//
// Pipeline:
//   1. Resolve an OA PDF URL (via EuropePMC's fullTextUrls, or accept
//      one directly from the caller).
//   2. Download the PDF.
//   3. Run `pdftotext -layout -nopgbrk` for the body.
//   4. Run `pdftoppm -r 100 -png` for page rasters (same format PMC path uses).
//   5. Try to split out a "References" section heuristically; emit a
//      minimal references.json. No rid-keyed structure — references
//      are unresolved pointers, so occurrence-extract will find zero
//      citation markers from this paper. But the paper can still BE
//      cited, and its body.md is readable by paper-profile.
//
// The honest limitation: pdftotext reading order is imperfect on
// two-column layouts, and reference parsing is heuristic. If GROBID
// is eventually added, this is where it plugs in.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PaperRegistryRow, FullTextStatus } from "../contracts/index.ts";
import { epmcLookup, type EpmcHit } from "./europepmc.ts";
import { httpGet } from "./http.ts";

export interface PdfFetchResult {
  row: PaperRegistryRow;
  /** Absolute URL of the PDF we downloaded. */
  pdfUrl: string;
  /** The EuropePMC record we resolved from, if any. */
  source?: EpmcHit;
  /** Crude split: how many reference entries we could identify. */
  referencesParsed: number;
}

export async function fetchPdfPaper(args: {
  row: PaperRegistryRow;
  outDir: string;              // <manifestDir>
  /** Override: supply a direct PDF URL to skip EuropePMC lookup. */
  pdfUrl?: string;
}): Promise<PdfFetchResult> {
  const { row, outDir } = args;
  const paperDir = join(outDir, "papers", row.paperId);
  await mkdir(paperDir, { recursive: true });

  // 1. Find a PDF URL.
  let hit: EpmcHit | undefined;
  let pdfUrl = args.pdfUrl;
  if (!pdfUrl) {
    const r = await epmcLookup({
      doi: row.ids.doi,
      pmid: row.ids.pmid,
      pmcid: row.ids.pmcid,
    });
    if (!r) throw new Error(`EuropePMC lookup found no record for ${row.paperId}`);
    hit = r;
    // Prefer Europe_PMC's own host — they serve OA PDFs without Cloudflare
    // gating. Fall back to Unpaywall, then the raw preprint server, then
    // anything labelled OA/Free.
    const pdfCandidates = (r.fullTextUrls ?? [])
      .filter((u) => u.documentStyle === "pdf" && (u.availability === "Open access" || u.availability === "Free"));
    const ranked = pdfCandidates.slice().sort((a, b) => hostRank(a.site) - hostRank(b.site));
    if (ranked.length === 0) {
      throw new Error(
        `EuropePMC has no OA PDF URL for ${row.paperId} (source=${r.source}). ` +
        `Available: ${(r.fullTextUrls ?? []).map((u) => `${u.site}:${u.documentStyle}:${u.availability}`).join(", ") || "none"}`,
      );
    }
    pdfUrl = ranked[0]!.url;
  }

  // 2. Download.
  const resp = await httpGet(pdfUrl, { timeoutMs: 120_000, retries: 2 });
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("pdf")) {
    throw new Error(`${pdfUrl} did not return a PDF (content-type=${ct})`);
  }
  const pdfBytes = new Uint8Array(await resp.arrayBuffer());
  if (pdfBytes.byteLength < 1024) {
    throw new Error(`PDF from ${pdfUrl} is suspiciously small (${pdfBytes.byteLength} bytes)`);
  }
  const pdfPath = join(paperDir, "paper.pdf");
  await writeFile(pdfPath, pdfBytes);

  // 3. Extract text in reading order. Do NOT pass -layout: that
  // preserves the physical 2-column page layout verbatim, which
  // produces side-by-side left/right text blocks instead of linear
  // reading order — disastrous for LLM consumption of academic
  // papers, which are overwhelmingly 2-column. Default mode uses
  // pdftotext's reading-order heuristic which is much better for
  // standard journal layouts.
  const textProc = Bun.spawn(["pdftotext", "-nopgbrk", pdfPath, "-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const textOut = await new Response(textProc.stdout).text();
  const code = await textProc.exited;
  if (code !== 0 || textOut.trim().length < 200) {
    throw new Error(`pdftotext failed on ${row.paperId} (exit ${code}, ${textOut.length} chars)`);
  }

  // Split body vs references.
  const { body, referencesBlock, refCount } = splitBodyAndRefs(textOut);

  // Prefer EuropePMC's title over the placeholder "(pending)".
  const displayTitle = (hit?.title && hit.title.trim())
    || (row.title && row.title !== "(pending)" ? row.title : "(title unknown)");
  const bodyMd = [
    `# ${displayTitle}`,
    "",
    ...(hit?.authorString ? [`**Authors:** ${hit.authorString}`, ""] : []),
    ...(hit?.journalTitle ? [`**Venue:** ${hit.journalTitle}  `, ""] : []),
    ...(hit?.pubYear ? [`**Year:** ${hit.pubYear}  `, ""] : []),
    ...(hit?.doi ? [`**DOI:** ${hit.doi}  `, ""] : []),
    ...(hit?.abstractText ? ["## Abstract", "", hit.abstractText, ""] : []),
    "## Body (extracted from PDF)",
    "",
    "> **Note:** this body was extracted from a PDF via `pdftotext`",
    "> in reading-order mode. Text is linearized column-by-column.",
    "> Structured citation markers are NOT available — occurrence-extract",
    "> will find zero outgoing citations from this paper. It can still",
    "> be cited by other papers in the corpus.",
    "",
    body,
  ].join("\n");
  await writeFile(join(paperDir, "body.md"), bodyMd, "utf8");

  // 4. Write a minimal references.json — empty rid-keyed entries, plus
  //    the raw text block as a sidecar for forensic use.
  await writeFile(join(paperDir, "references.json"), JSON.stringify([], null, 2) + "\n", "utf8");
  if (referencesBlock) {
    await writeFile(join(paperDir, "references.raw.txt"), referencesBlock, "utf8");
  }

  // 5. Sections.json — one section "Body" for paper-profile to iterate.
  await writeFile(
    join(paperDir, "sections.json"),
    JSON.stringify(
      [{ id: "body", label: "body", title: "Body", paragraphs: [{ index: 0, text: body, citations: [] }] }],
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // 6. Rasterize pages (same format as the PMC path).
  let pagesInfo: { dir: string; count: number } | undefined;
  try {
    const pagesDir = join(paperDir, "pages");
    await mkdir(pagesDir, { recursive: true });
    const rasterProc = Bun.spawn(["pdftoppm", "-r", "100", "-png", pdfPath, join(pagesDir, "page")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const rc = await rasterProc.exited;
    if (rc === 0) {
      const entries = await Array.fromAsync(new Bun.Glob("page-*.png").scan({ cwd: pagesDir }));
      if (entries.length > 0) pagesInfo = { dir: pagesDir, count: entries.length };
    }
  } catch {
    // best-effort
  }

  const fullText: FullTextStatus = {
    source: "pdf-text",
    sourceUrl: pdfUrl,
    pdfPath,
    markdownPath: join(paperDir, "body.md"),
    referencesPath: join(paperDir, "references.json"),
    ...(pagesInfo ? { pagesDir: pagesInfo.dir, pageCount: pagesInfo.count } : {}),
    referencesTotal: refCount,         // heuristic count, NOT structured
    referencesResolved: 0,              // pdftotext gives us zero structured rids
    sectionsDetected: true,
    notes: `pdftotext body (${body.length} chars), heuristic ${refCount} references (not rid-keyed — paper contributes no outgoing edges)`,
  };

  const updated: PaperRegistryRow = {
    ...row,
    // Fill in metadata from the EuropePMC record when the input row
    // didn't carry it.
    title: row.title && row.title !== "(pending)" ? row.title : (hit?.title ?? row.title),
    year: row.year && row.year > 0 ? row.year : (hit?.pubYear ? Number(hit.pubYear) : row.year),
    authors: row.authors.length > 0 ? row.authors : (hit?.authorString ? [hit.authorString] : []),
    venue: row.venue ?? hit?.journalTitle,
    abstract: row.abstract ?? hit?.abstractText,
    retracted: row.retracted ?? (hit?.isRetracted ? { isRetracted: true } : undefined),
    fullText,
  };

  await writeFile(join(paperDir, "paper.json"), JSON.stringify(updated, null, 2) + "\n", "utf8");

  return { row: updated, pdfUrl, source: hit, referencesParsed: refCount };
}

/** Rank PDF host preference — lower is better. */
function hostRank(site: string): number {
  const s = site.toLowerCase();
  if (s === "europe_pmc" || s === "europepmc") return 0;   // their own host, no bot gating
  if (s === "unpaywall") return 1;                          // redirects to publisher, often OK
  if (s === "doi") return 2;                                // DOI redirect, middling
  if (s.includes("medrxiv") || s.includes("biorxiv")) return 10;  // Cloudflare-gated
  return 5;
}

/**
 * Heuristic body/references split. pdftotext output typically has a
 * "References" heading near the end (possibly "Bibliography", "Literature
 * Cited"). We split on the last occurrence and then crude-count reference
 * entries by year-pattern markers.
 */
function splitBodyAndRefs(text: string): { body: string; referencesBlock?: string; refCount: number } {
  // Match a standalone References heading. Prefer the LAST one (earlier
  // occurrences may be "Supplementary references" or in-text mentions).
  const re = /^\s*(?:[0-9]+\.?\s+)?(references|bibliography|literature cited)\s*$/gim;
  let lastIndex = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) lastIndex = m.index;
  if (lastIndex < 0 || lastIndex < text.length * 0.3) {
    // Didn't find a references section in a plausible location.
    return { body: text.trim(), refCount: 0 };
  }
  const body = text.slice(0, lastIndex).trim();
  const refBlock = text.slice(lastIndex).trim();
  // Crude count: number of lines starting with a bracketed number or a
  // year in parentheses — cheap heuristic for number-of-entries.
  const entryMarkers =
    refBlock.match(/^\s*(?:\[\d+\]|\d+\.)\s+\S/gm)?.length
    ?? refBlock.match(/\(19|20\d{2}\)/g)?.length
    ?? 0;
  return { body, referencesBlock: refBlock, refCount: entryMarkers };
}
