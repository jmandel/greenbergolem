// JATS (PMC full-text XML) parser focused on what the occurrence-extraction
// task needs:
//
//   - section + paragraph structure (for `section` and `paragraphIndex`)
//   - inline citation markers (<xref ref-type="bibr" rid="...">) with
//     (a) the cited reference's local id and (b) the surrounding sentence,
//     paragraph, and wide context
//   - the <ref-list> mapping from rid -> {pub-id values, title, year}
//
// We use fast-xml-parser in preserveOrder mode so child order survives. Each
// node is `{ <tagName>: [<children>], ":@": { @_attr: "..." } }`. Leaf text
// is `{"#text": "..."}`.

import { XMLParser } from "fast-xml-parser";

const parserOpts = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
} as const;

// --- tiny tree helpers for preserveOrder shape -------------------------------

type Node = Record<string, unknown>;

function tagOf(n: Node): string | null {
  for (const k of Object.keys(n)) if (k !== ":@") return k;
  return null;
}

function childrenOf(n: Node): Node[] {
  const t = tagOf(n);
  if (!t) return [];
  const v = n[t];
  return Array.isArray(v) ? (v as Node[]) : [];
}

function attrs(n: Node): Record<string, string> {
  const a = n[":@"] as Record<string, string> | undefined;
  return a ?? {};
}

function firstChildWith(n: Node, tag: string): Node | undefined {
  return childrenOf(n).find((c) => tag in c);
}

function descendants(n: Node, tag: string): Node[] {
  const out: Node[] = [];
  const walk = (k: Node) => {
    for (const c of childrenOf(k)) {
      if (tag in c) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
}

function textOf(n: Node | undefined): string {
  if (!n) return "";
  if ("#text" in n) return String(n["#text"]);
  const t = tagOf(n);
  if (!t) return "";
  const kids = n[t];
  if (typeof kids === "string") return kids;
  if (!Array.isArray(kids)) return "";
  let s = "";
  for (const c of kids as Node[]) s += textOf(c);
  return s;
}

// --- public types ------------------------------------------------------------

export interface JatsReference {
  rid: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  title?: string;
  rawCitation?: string;
  year?: number;
  authors?: string[];
}

export interface JatsInlineCitation {
  rid: string;
  charOffset: number;                  // position inside paragraph.text
  groupedWith: string[];
}

export interface JatsFigure {
  id?: string;                         // <fig id="...">
  label?: string;                      // "Figure 1"
  caption?: string;                    // caption text
  graphicHref?: string;                // <graphic xlink:href="...">
}

export interface JatsParagraph {
  index: number;
  text: string;
  citations: JatsInlineCitation[];
}

export interface JatsSection {
  id: string;
  title?: string;
  label: string;                       // normalized (introduction/methods/...)
  paragraphs: JatsParagraph[];
}

export interface JatsDoc {
  pmcid?: string;
  pmid?: string;
  doi?: string;
  title?: string;
  abstract?: string;
  /** Publication year parsed from <pub-date>. Prefers epub > ppub > collection. */
  year?: number;
  sections: JatsSection[];
  references: JatsReference[];
  referenceByRid: Record<string, JatsReference>;
  figures: JatsFigure[];
}

// --- parser ------------------------------------------------------------------

export function parseJats(xml: string): JatsDoc {
  const parser = new XMLParser(parserOpts);
  const tree = parser.parse(xml) as Node[];
  const article = (tree ?? []).find((n) => "article" in n);
  if (!article) return emptyDoc();

  const front = firstChildWith(article, "front");
  const body = firstChildWith(article, "body");
  const back = firstChildWith(article, "back");

  const articleMeta = front ? firstChildWith(front, "article-meta") : undefined;
  const ids = articleMeta ? extractArticleIds(articleMeta) : {};
  const year = articleMeta ? extractPubYear(articleMeta) : undefined;
  const titleNode = articleMeta
    ? firstChildWith(firstChildWith(articleMeta, "title-group") ?? {}, "article-title")
    : undefined;
  const abstractNode = articleMeta ? firstChildWith(articleMeta, "abstract") : undefined;

  // ref-list can live under <back>, directly under <article>, or even under
  // <body>. Collect from all descendants of the article node, deduping by rid.
  const references = extractReferencesAnywhere(article);
  const referenceByRid: Record<string, JatsReference> = {};
  for (const r of references) referenceByRid[r.rid] = r;

  const sections = body ? extractSections(body) : [];
  const figures = extractFigures(article);

  return {
    ...ids,
    year,
    title: titleNode ? textOf(titleNode).trim() : undefined,
    abstract: abstractNode ? abstractText(abstractNode) : undefined,
    sections,
    references,
    referenceByRid,
    figures,
  };
}

/** Find the best publication year. Prefer epub → ppub → collection. */
function extractPubYear(articleMeta: Node): number | undefined {
  let epub: number | undefined;
  let ppub: number | undefined;
  let other: number | undefined;
  for (const c of childrenOf(articleMeta)) {
    if (!("pub-date" in c)) continue;
    const type = attrs(c)["@_pub-type"] ?? attrs(c)["@_date-type"] ?? "";
    let year: number | undefined;
    for (const sub of childrenOf(c)) {
      if ("year" in sub) {
        const y = Number(textOf(sub).trim());
        if (Number.isFinite(y) && y > 1900 && y < 2200) year = y;
      }
    }
    if (!year) continue;
    if (type === "epub") epub = year;
    else if (type === "ppub") ppub = year;
    else if (!other) other = year;
  }
  return epub ?? ppub ?? other;
}

function emptyDoc(): JatsDoc {
  return { sections: [], references: [], referenceByRid: {}, figures: [] };
}

function extractFigures(article: Node): JatsFigure[] {
  const figs = descendants(article, "fig");
  const out: JatsFigure[] = [];
  for (const f of figs) {
    const id = attrs(f)["@_id"];
    let label: string | undefined;
    let caption: string | undefined;
    let graphicHref: string | undefined;
    for (const c of childrenOf(f)) {
      if ("label" in c) label = textOf(c).replace(/\s+/g, " ").trim();
      else if ("caption" in c) caption = textOf(c).replace(/\s+/g, " ").trim();
      else if ("graphic" in c) {
        const a = attrs(c);
        graphicHref = a["@_xlink:href"] ?? a["@_href"];
      }
    }
    if (!graphicHref) {
      // Sometimes <graphic> sits inside an <alternatives> wrapper.
      const grs = descendants(f, "graphic");
      if (grs.length > 0) {
        const a = attrs(grs[0]!);
        graphicHref = a["@_xlink:href"] ?? a["@_href"];
      }
    }
    out.push({ id, label, caption, graphicHref });
  }
  return out;
}

function abstractText(abstractNode: Node): string {
  const paras: string[] = [];
  for (const c of childrenOf(abstractNode)) {
    if ("p" in c) paras.push(textOf(c).replace(/\s+/g, " ").trim());
    if ("sec" in c) {
      for (const sc of childrenOf(c)) {
        if ("p" in sc) paras.push(textOf(sc).replace(/\s+/g, " ").trim());
      }
    }
  }
  return paras.join("\n\n");
}

function extractArticleIds(articleMeta: Node): { doi?: string; pmid?: string; pmcid?: string } {
  const out: { doi?: string; pmid?: string; pmcid?: string } = {};
  for (const c of childrenOf(articleMeta)) {
    if (!("article-id" in c)) continue;
    const t = attrs(c)["@_pub-id-type"];
    const v = textOf(c).trim();
    if (!v) continue;
    if (t === "doi") out.doi = v;
    else if (t === "pmid") out.pmid = v;
    else if (t === "pmcid" || t === "pmc") out.pmcid = v.startsWith("PMC") ? v : `PMC${v}`;
  }
  return out;
}

function extractReferencesAnywhere(article: Node): JatsReference[] {
  const out: JatsReference[] = [];
  const seenRids = new Set<string>();
  const refLists = descendants(article, "ref-list");
  for (const rl of refLists) {
    for (const c of childrenOf(rl)) {
      if (!("ref" in c)) continue;
      const rid = attrs(c)["@_id"];
      if (!rid || seenRids.has(rid)) continue;
      const ref = parseRefEntry(c, rid);
      if (ref) {
        out.push(ref);
        seenRids.add(rid);
      }
    }
  }
  return out;
}

function parseRefEntry(refNode: Node, rid: string): JatsReference | null {
  const ref: JatsReference = { rid };
  const authors: string[] = [];
  const citation = childrenOf(refNode).find(
    (c) => "element-citation" in c || "mixed-citation" in c || "citation" in c,
  );
  const scan = (node: Node) => {
    for (const c of childrenOf(node)) {
      if ("pub-id" in c) {
        const t = attrs(c)["@_pub-id-type"];
        const v = textOf(c).trim();
        if (!v) continue;
        if (t === "doi") ref.doi = ref.doi ?? v;
        else if (t === "pmid") ref.pmid = ref.pmid ?? v;
        else if (t === "pmcid" || t === "pmc") {
          ref.pmcid = ref.pmcid ?? (v.startsWith("PMC") ? v : `PMC${v}`);
        }
      } else if ("ext-link" in c) {
        // Many publishers encode DOIs/PMIDs as <ext-link ext-link-type="doi"
        // xlink:href="..."> rather than <pub-id>. Respect both.
        const a = attrs(c);
        const type = a["@_ext-link-type"];
        const href = a["@_xlink:href"] ?? textOf(c).trim();
        if (!href) continue;
        if (type === "doi") ref.doi = ref.doi ?? href.replace(/^https?:\/\/doi\.org\//i, "");
        else if (type === "pmid") ref.pmid = ref.pmid ?? href.replace(/[^\d]/g, "");
        else if (type === "pmcid" || type === "pmc") {
          const v = href.trim();
          ref.pmcid = ref.pmcid ?? (v.startsWith("PMC") ? v : `PMC${v}`);
        } else if (type === "uri" || type === "url") {
          // Sometimes URIs encode DOIs.
          const m = href.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
          if (m && !ref.doi) ref.doi = m[0];
        }
      } else if ("article-title" in c) {
        if (!ref.title) ref.title = textOf(c).replace(/\s+/g, " ").trim();
      } else if ("year" in c) {
        const y = Number(textOf(c).trim());
        if (Number.isFinite(y) && !ref.year) ref.year = y;
      } else if ("surname" in c) {
        authors.push(textOf(c).trim());
      } else if ("string-name" in c) {
        authors.push(textOf(c).replace(/\s+/g, " ").trim());
      } else {
        scan(c);
      }
    }
  };
  if (citation) scan(citation);
  // Even when citation is structured, walk siblings too — some JATS variants
  // emit <ext-link> as a sibling of <element-citation>.
  scan(refNode);
  // If there's no structured citation, fall back to textual body of <ref>.
  if (!citation) {
    const raw = textOf(refNode).replace(/\s+/g, " ").trim();
    ref.rawCitation = raw;
    // Best-effort DOI sniff.
    const doiMatch = raw.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
    if (doiMatch) ref.doi = doiMatch[0];
    // Best-effort year sniff.
    const yearMatch = raw.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) ref.year = Number(yearMatch[0]);
  } else {
    ref.rawCitation = textOf(citation).replace(/\s+/g, " ").trim();
  }
  if (authors.length > 0) ref.authors = authors;
  return ref;
}

function extractSections(body: Node): JatsSection[] {
  const out: JatsSection[] = [];

  // Body may have direct <p> children (unsectioned body text) — treat as "body".
  const directPs = childrenOf(body).filter((c) => "p" in c);
  if (directPs.length > 0) {
    out.push({
      id: "body",
      label: "body",
      paragraphs: directPs.map((p, i) => extractParagraph(p, i)),
    });
  }

  // Walk sections recursively so deep sub-sections contribute their paragraphs.
  const walk = (node: Node) => {
    for (const c of childrenOf(node)) {
      if ("sec" in c) {
        const id = attrs(c)["@_id"] ?? `s${out.length}`;
        const titleNode = firstChildWith(c, "title");
        const title = titleNode ? textOf(titleNode).replace(/\s+/g, " ").trim() : undefined;
        const secType = attrs(c)["@_sec-type"];
        const label = normalizeSectionLabel(title, secType);
        const paragraphs: JatsParagraph[] = [];
        for (const k of childrenOf(c)) {
          if ("p" in k) paragraphs.push(extractParagraph(k, paragraphs.length));
        }
        if (paragraphs.length > 0) {
          out.push({ id, label, title, paragraphs });
        }
        walk(c);
      }
    }
  };
  walk(body);
  return out;
}

function extractParagraph(pNode: Node, index: number): JatsParagraph {
  const citations: JatsInlineCitation[] = [];
  let text = "";

  const walk = (n: Node) => {
    if ("#text" in n) {
      text += String(n["#text"]);
      return;
    }
    const t = tagOf(n);
    if (!t) return;
    if (t === "xref") {
      const a = attrs(n);
      if (a["@_ref-type"] === "bibr" && a["@_rid"]) {
        const rids = a["@_rid"].split(/\s+/).filter(Boolean);
        for (const rid of rids) {
          citations.push({
            rid,
            charOffset: text.length,
            groupedWith: rids.filter((x) => x !== rid),
          });
        }
      }
      // Still emit the visible marker text so sentence flow stays intact.
      for (const c of childrenOf(n)) walk(c);
      return;
    }
    for (const c of childrenOf(n)) walk(c);
  };
  walk(pNode);

  text = text.replace(/[ \t]+\n/g, "\n").replace(/\s{2,}/g, " ").trim();
  return { index, text, citations };
}

const SECTION_MAP: Array<[RegExp, string]> = [
  [/intro|background/i, "introduction"],
  [/method|material|procedure/i, "methods"],
  [/result|finding/i, "results"],
  [/discuss/i, "discussion"],
  [/conclud|conclusion/i, "conclusion"],
  [/limit/i, "limitations"],
  [/abstract/i, "abstract"],
  [/related work/i, "related-work"],
];

function normalizeSectionLabel(title: string | undefined, secType: string | undefined): string {
  const raw = secType ?? title ?? "";
  // Strip leading JATS-style numeric section numbering (e.g. "3.2.2. Efficacy of…")
  // so the keyword map below can match. Without this, JATS titles like
  // "3.2.2. efficacy of chloroquine/hydroxychloroquine" fall through to the
  // truncated-title fallback.
  const stripped = raw.replace(/^\s*\d+(?:\.\d+)*\.?\s*/, "").trim();
  for (const [re, label] of SECTION_MAP) {
    if (re.test(stripped)) return label;
  }
  return stripped ? stripped.toLowerCase().slice(0, 40) : "section";
}

/**
 * Split paragraph text into the sentence that contains `charOffset`.
 * Simple splitter: periods/exclaims/questions followed by whitespace + a
 * capital or digit. Good enough on JATS-derived paragraphs; we also keep
 * the full paragraph alongside for the classifier to use.
 */
export function sentenceAround(text: string, charOffset: number): string {
  const bounds: number[] = [0];
  const re = /[.!?]\s+(?=[A-Z0-9(\[])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) bounds.push(m.index + 1);
  bounds.push(text.length);
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i]!;
    const b = bounds[i + 1]!;
    if (charOffset >= a && charOffset <= b) return text.slice(a, b).trim();
  }
  return text.trim();
}

export function jatsToMarkdown(doc: JatsDoc): string {
  const parts: string[] = [];
  if (doc.title) parts.push(`# ${doc.title}`);
  if (doc.abstract) {
    parts.push("## Abstract");
    parts.push(doc.abstract);
  }
  for (const sec of doc.sections) {
    parts.push(`## ${sec.title ?? sec.label}`);
    for (const p of sec.paragraphs) {
      parts.push(p.text);
    }
  }
  if (doc.figures.length > 0) {
    parts.push("## Figures");
    for (const f of doc.figures) {
      const alt = f.label ?? "Figure";
      if (f.graphicHref) {
        parts.push(`![${alt}](figures/${figureBasename(f.graphicHref)})`);
      } else {
        parts.push(`> **${alt}.**`);
      }
      if (f.caption) parts.push(`> ${f.caption}`);
    }
  }
  return parts.join("\n\n");
}

/** Normalize a JATS graphic href to a filesystem-safe basename. */
export function figureBasename(href: string): string {
  return href.replace(/^.*\//, "").replace(/[^A-Za-z0-9._-]/g, "_");
}
