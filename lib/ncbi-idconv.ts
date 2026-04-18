// NCBI PMC ID Converter client.
//
// Converts between DOI / PMID / PMCID. Critical for Phase 1.2 where we
// need to resolve OpenAlex hits that lack an `ids.pmcid` field via their
// DOI or PMID — this is how NEJM/JAMA/Lancet papers get pulled into the
// PMC-OA corpus.
//
// API: https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/
// Accepts mixed ids in one query (up to 200). No API key needed but we
// route through the same host gate as the rest of NCBI.

import { httpJson, qs, CONTACT_EMAIL } from "./http.ts";

const BASE = "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/";

export interface IdConvRecord {
  /** Input id as it was queried (doi/pmid/pmcid — what you sent). */
  requested: string;
  /** Resolved identifiers. Fields missing when NCBI couldn't resolve them. */
  doi?: string;
  pmid?: string;
  pmcid?: string;
  /** Error status from NCBI ("invalid id", "ambiguous", etc.). */
  status?: string;
  errmsg?: string;
}

interface RawRecord {
  pmcid?: string;
  pmid?: string;
  doi?: string;
  requested?: string;
  status?: string;
  errmsg?: string;
  live?: string;
}

export type IdType = "doi" | "pmid" | "pmcid";

/** Normalize a raw input id — strip URL prefixes, whitespace, the PMC/PMID labels. */
function normalizeId(raw: string): string {
  const s = raw.trim();
  if (/^https?:\/\/doi\.org\//i.test(s)) return s.replace(/^https?:\/\/doi\.org\//i, "");
  if (/^doi:\s*/i.test(s)) return s.replace(/^doi:\s*/i, "");
  if (/^pmid:\s*/i.test(s)) return s.replace(/^pmid:\s*/i, "");
  return s;
}

/** Infer the id type from shape. */
export function inferIdType(raw: string): IdType | null {
  const s = normalizeId(raw);
  if (/^PMC\d+$/i.test(s)) return "pmcid";
  if (/^\d+$/.test(s)) return "pmid";
  if (/^10\.\d+\//.test(s)) return "doi";
  return null;
}

/**
 * Convert a batch of ids of a single type via the PMC ID converter.
 * NCBI's API requires all ids in one request to be the same type.
 */
export async function idConvertTyped(
  ids: readonly string[],
  idtype: IdType,
): Promise<IdConvRecord[]> {
  if (ids.length === 0) return [];
  const norm = ids.map(normalizeId).filter((s) => s.length > 0);
  const out: IdConvRecord[] = [];
  const CHUNK = 180;                                    // stay under the 200 cap
  for (let i = 0; i < norm.length; i += CHUNK) {
    const slice = norm.slice(i, i + CHUNK);
    const url = `${BASE}?${qs({
      tool: "ClaimCartographer",
      email: CONTACT_EMAIL,
      ids: slice.join(","),
      idtype,
      format: "json",
      versions: "no",
    })}`;
    const resp = (await httpJson(url)) as {
      status?: string;
      records?: RawRecord[];
    };
    for (const r of resp.records ?? []) {
      out.push({
        requested: r.requested ?? "",
        doi: r.doi,
        pmid: r.pmid,
        pmcid: r.pmcid,
        status: r.status,
        errmsg: r.errmsg,
      });
    }
  }
  return out;
}

/**
 * Convert a mixed batch of ids. Groups by inferred type under the hood
 * (NCBI rejects mixed-type queries). Unrecognized ids are silently dropped.
 */
export async function idConvert(
  ids: readonly string[],
): Promise<IdConvRecord[]> {
  const groups = new Map<IdType, string[]>();
  for (const raw of ids) {
    const t = inferIdType(raw);
    if (!t) continue;
    const bucket = groups.get(t) ?? [];
    bucket.push(raw);
    groups.set(t, bucket);
  }
  const out: IdConvRecord[] = [];
  for (const [t, batch] of groups) {
    out.push(...(await idConvertTyped(batch, t)));
  }
  return out;
}

/**
 * Given rows with some combination of (doi, pmid, pmcid), fill in the
 * missing pmcid by calling the ID converter. Input rows are returned
 * unchanged except that `pmcid` may get populated.
 *
 * Skip rows that already have a pmcid, or lack both doi and pmid.
 */
export async function upgradeToPmcids<
  T extends { doi?: string; pmid?: string; pmcid?: string },
>(rows: readonly T[]): Promise<T[]> {
  const dois: string[] = [];
  const pmids: string[] = [];
  for (const row of rows) {
    if (row.pmcid) continue;
    if (row.doi) dois.push(row.doi);
    else if (row.pmid) pmids.push(row.pmid);
  }
  if (dois.length === 0 && pmids.length === 0) return [...rows];

  const results = [
    ...(await idConvertTyped(dois, "doi")),
    ...(await idConvertTyped(pmids, "pmid")),
  ];
  const byDoi = new Map<string, string>();     // normalized doi -> pmcid
  const byPmid = new Map<string, string>();
  for (const r of results) {
    if (!r.pmcid) continue;
    if (r.doi) byDoi.set(r.doi.toLowerCase(), r.pmcid);
    if (r.pmid) byPmid.set(String(r.pmid), r.pmcid);
  }

  return rows.map((row) => {
    if (row.pmcid) return row;
    if (row.doi) {
      const hit = byDoi.get(row.doi.toLowerCase());
      if (hit) return { ...row, pmcid: hit };
    }
    if (row.pmid) {
      const hit = byPmid.get(row.pmid);
      if (hit) return { ...row, pmcid: hit };
    }
    return row;
  });
}
