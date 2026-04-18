// Thin NCBI E-Utilities client (esearch / esummary / elink / efetch).
//
// NCBI's terms of service restrict systematic automated retrieval to their
// supported services — E-Utilities, OAI-PMH, PMC OA Web Service (see
// lib/pmc.ts). Rate: <=3 req/s without an API key, <=10 with one. The shared
// http lib enforces the gate per host.
//
// Docs: https://www.ncbi.nlm.nih.gov/books/NBK25501/

import { httpJson, httpText, qs, CONTACT_EMAIL } from "./http.ts";

const BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

function commonParams(): Record<string, string> {
  const p: Record<string, string> = {
    tool: "ClaimCartographer",
    email: CONTACT_EMAIL,
  };
  if (process.env.NCBI_API_KEY) p.api_key = process.env.NCBI_API_KEY;
  return p;
}

export interface ESearchResult {
  count: number;
  retmax: number;
  retstart: number;
  idlist: string[];
  querytranslation?: string;
  webenv?: string;
  querykey?: string;
}

export async function esearch(params: {
  db: "pubmed" | "pmc";
  term: string;
  retmax?: number;
  retstart?: number;
  mindate?: string;                     // YYYY or YYYY/MM/DD
  maxdate?: string;
  datetype?: "pdat" | "edat";
  sort?: "relevance" | "pub_date" | "first_author" | "most_recent";
  useHistory?: boolean;
}): Promise<ESearchResult> {
  const url = `${BASE}/esearch.fcgi?${qs({
    ...commonParams(),
    db: params.db,
    term: params.term,
    retmode: "json",
    retmax: params.retmax ?? 100,
    retstart: params.retstart ?? 0,
    mindate: params.mindate,
    maxdate: params.maxdate,
    datetype: params.datetype ?? (params.mindate || params.maxdate ? "pdat" : undefined),
    sort: params.sort,
    usehistory: params.useHistory ? "y" : undefined,
  })}`;
  const data = (await httpJson(url)) as {
    esearchresult: {
      count: string;
      retmax: string;
      retstart: string;
      idlist: string[];
      querytranslation?: string;
      webenv?: string;
      querykey?: string;
    };
  };
  const r = data.esearchresult;
  return {
    count: Number(r.count),
    retmax: Number(r.retmax),
    retstart: Number(r.retstart),
    idlist: r.idlist,
    querytranslation: r.querytranslation,
    webenv: r.webenv,
    querykey: r.querykey,
  };
}

export interface PubMedSummary {
  uid: string;
  title?: string;
  authors?: Array<{ name: string; authtype?: string }>;
  pubdate?: string;
  epubdate?: string;
  source?: string;                      // journal abbr
  elocationid?: string;
  articleids?: Array<{ idtype: string; value: string }>;
  pubtype?: string[];
}

export async function esummary(params: {
  db: "pubmed" | "pmc";
  ids: string[];
}): Promise<PubMedSummary[]> {
  if (params.ids.length === 0) return [];
  const url = `${BASE}/esummary.fcgi?${qs({
    ...commonParams(),
    db: params.db,
    id: params.ids.join(","),
    retmode: "json",
  })}`;
  const data = (await httpJson(url)) as { result?: Record<string, unknown> };
  if (!data.result) return [];
  const uids = (data.result as { uids?: string[] }).uids ?? [];
  const out: PubMedSummary[] = [];
  for (const uid of uids) {
    const row = data.result[uid] as PubMedSummary | undefined;
    if (row) out.push({ ...row, uid });
  }
  return out;
}

export async function efetchXml(params: {
  db: "pubmed" | "pmc";
  ids: string[];
  rettype?: string;
}): Promise<string> {
  const url = `${BASE}/efetch.fcgi?${qs({
    ...commonParams(),
    db: params.db,
    id: params.ids.join(","),
    retmode: "xml",
    rettype: params.rettype,
  })}`;
  return await httpText(url);
}

/** Helper: pull DOI/PMCID out of the articleids array. */
export function articleIds(rec: PubMedSummary): { doi?: string; pmcid?: string; pmid?: string } {
  const out: { doi?: string; pmcid?: string; pmid?: string } = { pmid: rec.uid };
  for (const id of rec.articleids ?? []) {
    const v = id.value?.trim();
    if (!v) continue;
    if (id.idtype === "doi") out.doi = v;
    else if (id.idtype === "pmc") out.pmcid = v.startsWith("PMC") ? v : `PMC${v}`;
    else if (id.idtype === "pubmed") out.pmid = v;
  }
  return out;
}

/** Build the canonical PMC-OA PubMed filter as PubMed documents. */
export function pmcOaFilter(): string {
  // "pubmed pmc open access"[filter] is the stable PMC Open Access filter.
  return `"pubmed pmc open access"[filter]`;
}
