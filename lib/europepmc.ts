// Europe PMC search — covers PMC, PubMed (MED), and preprints (PPR) in one
// unified index. Used to pull *abstract-level* metadata for papers we can't
// fetch full text for (preprints with no XML, paywalled journal articles).

import { httpJson } from "./http.ts";

const BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

export interface EpmcHit {
  /** EuropePMC internal id. Prefixed PPR for preprints, PMC for PMC, etc. */
  id: string;
  /** Source db: PPR (preprint), PMC, MED (PubMed), etc. */
  source: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  /** Space-joined "Last FN, Last FN" or similar. */
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
  abstractText?: string;
  isRetracted?: boolean;
  /** True when EuropePMC has JATS XML full text. */
  hasFullText?: boolean;
  /** Candidate URLs — OA PDFs, publisher links, DOI redirects. */
  fullTextUrls?: Array<{ site: string; url: string; documentStyle: string; availability: string }>;
}

interface RawResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
  abstractText?: string;
  isRetracted?: string;          // EuropePMC returns "Y"/"N"
  hasTextMinedTerms?: string;
  hasXML?: string;
  fullTextUrlList?: {
    fullTextUrl?: Array<{
      availability?: string;
      documentStyle?: string;
      site?: string;
      url?: string;
    }>;
  };
}

/**
 * Search EuropePMC. One call covers PMC, PubMed, and preprints.
 *
 * `query` is a EuropePMC search expression. Useful tags:
 *   DOI:...          DOI: search
 *   EXT_ID:...       PubMed/EuropePMC external id
 *   SRC:PPR          preprints only
 *   SRC:PMC          PMC OA only
 *   TITLE:"..."      title search
 *   Boolean: AND, OR, NOT; grouping with parens
 */
export async function epmcSearch(params: {
  query: string;
  pageSize?: number;
  resultType?: "core" | "lite";
}): Promise<EpmcHit[]> {
  const url = new URL(BASE);
  url.searchParams.set("query", params.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", String(params.pageSize ?? 25));
  url.searchParams.set("resultType", params.resultType ?? "core");
  const data = (await httpJson(url.toString())) as {
    resultList?: { result?: RawResult[] };
  };
  const rows = data.resultList?.result ?? [];
  return rows.map(toHit);
}

/**
 * Look up a single paper by identifier. Returns the first hit — EuropePMC's
 * unified index usually has one record per paper unless there's a preprint+
 * journal pair, in which case the journal version comes first.
 */
export async function epmcLookup(args: {
  doi?: string;
  pmid?: string;
  pmcid?: string;
  preferSource?: "MED" | "PMC" | "PPR" | "any";
}): Promise<EpmcHit | null> {
  const clauses: string[] = [];
  if (args.doi) clauses.push(`DOI:"${args.doi}"`);
  if (args.pmid) clauses.push(`EXT_ID:${args.pmid} AND SRC:MED`);
  if (args.pmcid) clauses.push(`PMCID:${args.pmcid.replace(/^PMC/i, "PMC")}`);
  if (clauses.length === 0) return null;
  const query = clauses.join(" OR ");
  const hits = await epmcSearch({ query, pageSize: 10 });
  if (hits.length === 0) return null;
  const prefer = args.preferSource ?? "any";
  if (prefer !== "any") {
    const filtered = hits.filter((h) => h.source === prefer);
    if (filtered.length > 0) return filtered[0]!;
  }
  return hits[0]!;
}

function toHit(r: RawResult): EpmcHit {
  return {
    id: r.id ?? "",
    source: r.source ?? "",
    pmid: r.pmid,
    pmcid: r.pmcid,
    doi: r.doi,
    title: r.title,
    authorString: r.authorString,
    journalTitle: r.journalTitle,
    pubYear: r.pubYear,
    abstractText: r.abstractText,
    isRetracted: r.isRetracted === "Y",
    hasFullText: r.hasXML === "Y",
    fullTextUrls: r.fullTextUrlList?.fullTextUrl
      ?.map((u) => ({
        site: u.site ?? "",
        url: u.url ?? "",
        documentStyle: u.documentStyle ?? "",
        availability: u.availability ?? "",
      }))
      .filter((u) => u.url),
  };
}
