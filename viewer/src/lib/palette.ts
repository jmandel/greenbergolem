// Taxonomy-driven palette builder for the viewer. Mirrors the one in
// tasks/render/run.ts. Called once per bundle; emits all the
// color/layout-key information downstream components consume so we
// never embed a hardcoded evidence-class id anywhere in the React
// app.

import type { TaxonomyTerm } from "../../../contracts/index.ts";
import type { GraphBundle } from "./types.ts";

export interface TermVis {
  id: string;
  label: string;
  groupId: string;
  groupLabel: string;
  fill: string;            // node fill
  indexInGroup: number;
}

export interface GroupVis {
  id: string;
  label: string;
  shortLabel: string;      // for cramped SVG headers; never longer than ~20 chars
  hue: number;
  baseSat: number;
  baseLight: number;
  termIds: string[];
}

export interface InventionVis {
  id: string;
  label: string;
  groupId: string;
  groupLabel: string;
  color: string;
  symbol: string;
}

export interface Palette {
  evidenceGroups: GroupVis[];
  evidenceTerms: TermVis[];
  evidenceTermById: Map<string, TermVis>;
  inventionGroups: GroupVis[];
  inventionTerms: InventionVis[];
  inventionTermById: Map<string, InventionVis>;
}

// Fixed enum colors — stance (node border) and role (edge color).
// Tuned to Greenberg 2009 fig 1:
//   - supportive edges: black
//   - neutral edges:    green
//   - critical edges:   pale (rare, visually quiet)
//   - diversion (invention-type) edges: blue override — handled at the
//     render site, not here
export const STANCE_COLOR = {
  supportive: "#1f7a1f",
  critical: "#b33a3a",
  mixed: "#6a5acd",
  unclear: "#888888",
} as const;

export const ROLE_COLOR = {
  supportive: "#111111",
  critical: "#c9a0a0",
  neutral: "#3a8a3a",
  mixed: "#1f6bc9",
  unclear: "#b9b9b9",
} as const;

// Diversion gets its own Greenberg-blue edge color, overriding the role
// color when an edge carries the `diversion` invention flag.
export const DIVERSION_EDGE_COLOR = "#1f4fc9";

// Authority papers: yellow fill (Greenberg's visual convention) rather
// than a subtle halo. The halo color below is kept for lens-mode.
export const AUTHORITY_FILL = "#ffdc57";
export const AUTHORITY_HALO = "#ffdc57";

// Semantic hues for common groups. Unknown groups get a deterministic
// hash-based hue. Producer is near-white so stance (border color)
// carries the visual weight, matching Greenberg's "Primary data" being
// uncolored white circles with a dark outline.
const SEMANTIC_GROUP_HUE: Record<string, { hue: number; sat: number; light: number }> = {
  producer: { hue: 0, sat: 0, light: 98 },
  amplifier: { hue: 125, sat: 55, light: 75 },
  surrogate: { hue: 200, sat: 60, light: 80 },
  other: { hue: 180, sat: 25, light: 92 },
  "content-distortion": { hue: 340, sat: 70, light: 55 },
  "source-distortion": { hue: 48, sat: 80, light: 58 },
};

const INVENTION_SYMBOLS = ["△", "◆", "■", "◉", "✕", "◀", "▼", "●"];

// "DATA PRODUCER — primary clinical data" → "Primary data"
// "AMPLIFIER — synthesis of producer evidence" → "Reviews"
// "SURROGATE — mechanistic / in-vitro / animal" → "Models"
// "OTHER" → "Other"
// Order matters: amplifier / surrogate / other are checked BEFORE
// producer because their long labels happen to contain the word
// "producer" (as in "synthesis of producer evidence").
function shortenLabel(label: string): string {
  const lower = label.toLowerCase();
  if (lower.startsWith("amplifier") || lower.includes("review") || lower.includes("synthesis")) return "Reviews";
  if (lower.startsWith("surrogate") || lower.includes("mechanistic") || lower.includes("model") || lower.includes("in-vitro") || lower.includes("animal")) return "Models";
  if (lower === "other" || lower.startsWith("other")) return "Other";
  if (lower.startsWith("data producer") || lower.includes("primary clinical") || lower.includes("primary data")) return "Primary data";
  if (lower.includes("content distortion")) return "Content";
  if (lower.includes("source distortion")) return "Source";
  // Default: take text before em-dash, cap at 18 chars
  const pre = label.split(/[—–]/)[0]!.trim();
  return pre.length > 18 ? pre.slice(0, 17) + "…" : pre || label.slice(0, 18);
}

function hashHue(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) * 16777619;
    h >>>= 0;
  }
  return h % 360;
}
function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}
function darken(h: string, by: number): string {
  const m = h.match(/hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)/);
  if (!m) return h;
  const [, hv, sv, lv] = m;
  return hsl(Number(hv), Number(sv), Math.max(20, Number(lv) - by));
}

function mergeDeclaredAndObserved(
  declared: readonly TaxonomyTerm[],
  observed: Set<string>,
): TaxonomyTerm[] {
  const out: TaxonomyTerm[] = [...declared];
  const known = new Set(declared.map((t) => t.id));
  for (const id of observed) {
    if (!known.has(id)) out.push({ id, label: id, definition: "(not in claim pack)" });
  }
  return out;
}

function buildGrouped(terms: readonly TaxonomyTerm[]): { groups: GroupVis[]; terms: TermVis[] } {
  const byGroup = new Map<string, { label: string; terms: TaxonomyTerm[] }>();
  const order: string[] = [];
  for (const t of terms) {
    const gid = t.group ?? t.id;
    if (!byGroup.has(gid)) {
      byGroup.set(gid, { label: t.groupLabel ?? (t.group ? gid : t.label), terms: [] });
      order.push(gid);
    }
    byGroup.get(gid)!.terms.push(t);
  }

  const groups: GroupVis[] = [];
  const termsOut: TermVis[] = [];
  for (const gid of order) {
    const entry = byGroup.get(gid)!;
    const { hue, sat, light } = SEMANTIC_GROUP_HUE[gid] ?? { hue: hashHue(gid), sat: 60, light: 82 };
    const g: GroupVis = {
      id: gid,
      label: entry.label,
      shortLabel: shortenLabel(entry.label),
      hue,
      baseSat: sat,
      baseLight: light,
      termIds: entry.terms.map((t) => t.id),
    };
    groups.push(g);
    entry.terms.forEach((t, i) => {
      const l = Math.max(30, light - i * 10);
      const s = sat === 0 ? 0 : Math.max(0, sat - i * 5);
      termsOut.push({
        id: t.id,
        label: t.label,
        groupId: gid,
        groupLabel: entry.label,
        fill: hsl(hue, s, l),
        indexInGroup: i,
      });
    });
  }
  return { groups, terms: termsOut };
}

/**
 * Build the full palette from the resolved claim-pack's taxonomies plus
 * whatever ids are observed in the graph (so unknown ids don't crash).
 */
export function buildPalette(
  resolved: { evidenceClass?: readonly TaxonomyTerm[]; inventionTypes?: readonly TaxonomyTerm[] } | null | undefined,
  graph: GraphBundle,
): Palette {
  const observedEvidence = new Set<string>();
  for (const p of graph.papers) observedEvidence.add(p.profile.evidenceClass);
  const observedInventions = new Set<string>();
  for (const e of graph.edges) for (const iv of e.inventionTypes ?? []) observedInventions.add(iv);

  const evidenceMerged = mergeDeclaredAndObserved(resolved?.evidenceClass ?? [], observedEvidence);
  const inventionMerged = mergeDeclaredAndObserved(resolved?.inventionTypes ?? [], observedInventions);

  const { groups: evidenceGroups, terms: evidenceTerms } = buildGrouped(evidenceMerged);
  const { groups: inventionGroups, terms: inventionTermsRaw } = buildGrouped(inventionMerged);

  const inventionTerms: InventionVis[] = inventionTermsRaw.map((t, i) => ({
    id: t.id,
    label: t.label,
    groupId: t.groupId,
    groupLabel: t.groupLabel,
    color: darken(t.fill, 18),
    symbol: INVENTION_SYMBOLS[i % INVENTION_SYMBOLS.length]!,
  }));

  return {
    evidenceGroups,
    evidenceTerms,
    evidenceTermById: new Map(evidenceTerms.map((t) => [t.id, t])),
    inventionGroups,
    inventionTerms,
    inventionTermById: new Map(inventionTerms.map((t) => [t.id, t])),
  };
}
