// Thin OpenAlex client scoped to what the Claim Cartographer needs
// . OpenAlex is our citation/metadata spine. It's open, fast,
// and covers biomed well via MeSH-enriched concepts.
//
// Docs: https://api.openalex.org — the `/works` endpoint accepts `filter=`
// and `search=` alongside cursor pagination. Use the `mailto=` param to ride
// in their polite pool (our shared http lib sets the UA instead).

import { httpJson, qs, CONTACT_EMAIL } from "./http.ts";

export interface OpenAlexAuthorship {
  author?: { id?: string; display_name?: string };
  raw_author_name?: string;
}

export interface OpenAlexLocationSource {
  id?: string;
  display_name?: string;
  type?: string;
  is_oa?: boolean;
}

export interface OpenAlexLocation {
  source?: OpenAlexLocationSource;
  landing_page_url?: string;
  pdf_url?: string;
  is_oa?: boolean;
  version?: string;
  license?: string;
}

export interface OpenAlexIds {
  openalex?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  mag?: string;
}

export interface OpenAlexWork {
  id: string;                          // full URL like https://openalex.org/W...
  doi?: string;                        // also a URL like https://doi.org/10.x
  title?: string;
  display_name?: string;
  publication_year?: number;
  publication_date?: string;
  type?: string;
  is_retracted?: boolean;
  is_paratext?: boolean;
  cited_by_count?: number;
  authorships?: OpenAlexAuthorship[];
  primary_location?: OpenAlexLocation;
  best_oa_location?: OpenAlexLocation;
  locations?: OpenAlexLocation[];
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string };
  abstract_inverted_index?: Record<string, number[]>;
  ids?: OpenAlexIds;
  concepts?: Array<{ display_name?: string; score?: number }>;
  referenced_works?: string[];         // OpenAlex IDs
  related_works?: string[];
}

export interface OpenAlexPage<T> {
  meta: { count: number; db_response_time_ms: number; page?: number; per_page: number; next_cursor?: string | null };
  results: T[];
}

export interface WorksQuery {
  search?: string;
  filter?: Record<string, string | number | boolean>;
  perPage?: number;                     // default 50, max 200
  cursor?: string;                      // "*" to start; OpenAlex returns next_cursor
  sort?: string;                        // e.g. "cited_by_count:desc"
  select?: string[];                    // restrict returned fields (cheaper)
}

const BASE = "https://api.openalex.org";

export async function searchWorks(q: WorksQuery): Promise<OpenAlexPage<OpenAlexWork>> {
  const filterStr = q.filter
    ? Object.entries(q.filter).map(([k, v]) => `${k}:${v}`).join(",")
    : undefined;
  const url = `${BASE}/works?${qs({
    search: q.search,
    filter: filterStr,
    "per-page": q.perPage ?? 50,
    cursor: q.cursor,
    sort: q.sort,
    select: q.select?.join(","),
    mailto: CONTACT_EMAIL,
  })}`;
  return await httpJson<OpenAlexPage<OpenAlexWork>>(url);
}

/** Cursor-paginated search that yields pages until exhausted or cap reached. */
export async function* iterateWorks(
  q: WorksQuery,
  maxRecords = 2000,
): AsyncGenerator<OpenAlexWork> {
  let cursor: string | undefined = "*";
  let fetched = 0;
  while (cursor) {
    const page = await searchWorks({ ...q, cursor, perPage: q.perPage ?? 100 });
    for (const w of page.results) {
      yield w;
      fetched++;
      if (fetched >= maxRecords) return;
    }
    cursor = page.meta.next_cursor ?? undefined;
    if (!cursor) return;
  }
}

/** Resolve a DOI to its OpenAlex work record. */
export async function getWorkByDoi(doi: string): Promise<OpenAlexWork> {
  const clean = doi.replace(/^https?:\/\/doi\.org\//i, "");
  return await httpJson<OpenAlexWork>(
    `${BASE}/works/doi:${encodeURIComponent(clean)}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`,
  );
}

/** Resolve an OpenAlex ID (full URL or bare "W..." form). */
export async function getWorkById(id: string): Promise<OpenAlexWork> {
  const bare = id.startsWith("http") ? id.split("/").pop()! : id;
  return await httpJson<OpenAlexWork>(
    `${BASE}/works/${bare}?mailto=${encodeURIComponent(CONTACT_EMAIL)}`,
  );
}

/** Reassemble the human-readable abstract from OpenAlex's inverted index. */
export function abstractFromInverted(inv: Record<string, number[]> | undefined): string | undefined {
  if (!inv) return undefined;
  const positions: Array<[number, string]> = [];
  for (const [word, idxs] of Object.entries(inv)) {
    for (const i of idxs) positions.push([i, word]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(" ");
}

/** Extract a plain "W..." identifier from a full OpenAlex URL. */
export function bareOpenAlexId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.startsWith("http") ? id.split("/").pop() : id;
}
