// PubMed Central full-text access.
//
// We use three endpoints:
//   - Europe PMC REST:     https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML
//     — handy: accepts PMC IDs directly, returns JATS, no auth.
//   - NCBI PMC OA Web Svc: https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC...
//     — official OA distribution endpoint; returns a tarball URL pointer.
//   - NCBI E-Utilities efetch&db=pmc&rettype=full (via lib/pubmed.ts)
//     — works for most OA articles but not always full JATS.
//
// Order of preference for the pilot: Europe PMC → efetch → OA Web Service
// tarball (we don't implement tarball extraction yet; it's the fallback).
//
// We never screen-scrape PMC HTML. That violates NCBI's retrieval policy.

import { httpGet, httpText } from "./http.ts";
import { efetchXml } from "./pubmed.ts";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface JatsFetch {
  xml: string;
  source: "europepmc" | "ncbi-efetch";
  url: string;
}

/** Download the rendered PDF for a PMC article. Returns null if unavailable. */
export async function fetchPmcPdf(pmcid: string): Promise<Uint8Array | null> {
  const clean = pmcid.startsWith("PMC") ? pmcid : `PMC${pmcid}`;
  const url = `https://europepmc.org/articles/${clean}?pdf=render`;
  try {
    const resp = await httpGet(url, { timeoutMs: 60_000, retries: 2 });
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("pdf")) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Download a single JATS figure image. NCBI's "instance" endpoint serves the
 * author-supplied bytes (same as PMC's UI). Europe PMC's /articles/.../bin/
 * path 301-redirects to an image-rejecting endpoint, so we hit NCBI directly.
 * Returns { storedName } on success, null otherwise.
 */
export async function fetchPmcFigureImage(
  pmcid: string,
  basename: string,
  destDir: string,
): Promise<{ storedName: string } | null> {
  const numeric = pmcid.replace(/^PMC/i, "");
  // Probe basename + common extensions in case the JATS href lacks one.
  const hasExt = /\.[a-zA-Z0-9]{1,4}$/.test(basename);
  const candidates = hasExt
    ? [basename]
    : [basename, `${basename}.jpg`, `${basename}.png`, `${basename}.gif`];

  for (const candidate of candidates) {
    const url = `https://www.ncbi.nlm.nih.gov/pmc/articles/instance/${numeric}/bin/${candidate}`;
    try {
      const resp = await httpGet(url, { timeoutMs: 30_000, retries: 1 });
      const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
      if (!ct.startsWith("image/")) continue;
      const ext = hasExt
        ? ""
        : ct.includes("png")
          ? ".png"
          : ct.includes("gif")
            ? ".gif"
            : ".jpg";
      const storedName = basename + ext;
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, storedName), new Uint8Array(await resp.arrayBuffer()));
      return { storedName };
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function fetchJats(pmcid: string): Promise<JatsFetch | null> {
  const clean = pmcid.startsWith("PMC") ? pmcid : `PMC${pmcid}`;
  const numeric = clean.replace(/^PMC/, "");
  // Europe PMC first: direct JATS, simple endpoint.
  const epmcUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/${clean}/fullTextXML`;
  try {
    const xml = await httpText(epmcUrl, { timeoutMs: 45_000 });
    if (xml && xml.includes("<article") && xml.length > 500) {
      return { xml, source: "europepmc", url: epmcUrl };
    }
  } catch {
    // fall through
  }
  // NCBI efetch fallback.
  try {
    const xml = await efetchXml({ db: "pmc", ids: [numeric] });
    if (xml && xml.includes("<article") && xml.length > 500) {
      return {
        xml,
        source: "ncbi-efetch",
        url: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${numeric}`,
      };
    }
  } catch {
    // fall through
  }
  return null;
}
