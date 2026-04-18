// render: dynamic, taxonomy-aware figure + viewer + casebook.
//
// Everything that used to be hardcoded to a specific evidence-class or
// invention-type list is now derived from the run's claim-pack taxonomy:
//
//   X = evidence-class GROUP lane (producer / amplifier / surrogate /
//       other for the HCQ run; whatever the research agent authored
//       for other claims).
//   Y = publication year (oldest at bottom).
//   Node fill  = evidence-class term color (group hue, within-group shade).
//   Node border = intrinsic stance (fixed enum).
//   Node halo  = authority flag.
//   Edge color = citation role (fixed enum).
//   Edge badge = invention-type flags, if any, colored per taxonomy.
//
// The HTML viewer embeds the SVG + a filter sidebar derived from the
// same palette, so users can hide/show by any taxonomy axis.

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import {
  GraphBundleSchema,
  type GraphBundle,
  type GraphNode,
  type EdgeBundle,
  type OccurrenceJudgment,
  type OccurrenceRole,
  type IntrinsicStance,
} from "../../contracts/index.ts";
import type { TaxonomyTerm, ResolvedClaimPack } from "../../contracts/taxonomy.ts";
import { resolveClaimPack } from "../../contracts/resolve.ts";
import { ClaimPackSchema } from "../../contracts/claim-pack.ts";
import { ProgressLog } from "../../orchestrator/progress.ts";

// ---------- Fixed-enum palettes ----------
// Stance and role are epistemic primitives (supportive / critical / ...)
// and not claim-adaptive, so their colors can stay hardcoded.

const STANCE_BORDER: Record<IntrinsicStance, string> = {
  supportive: "#1f7a1f",
  critical: "#b33a3a",
  mixed: "#6a5acd",
  unclear: "#888888",
};

const ROLE_COLOR: Record<OccurrenceRole, string> = {
  supportive: "#111111",
  neutral: "#7fbf7f",
  critical: "#d64545",
  mixed: "#1f6bc9",
  unclear: "#bbbbbb",
};

// ---------- Palette construction (taxonomy-driven) ----------

interface TermVis {
  id: string;
  label: string;
  groupId: string;
  groupLabel: string;
  fill: string;       // node fill / legend swatch / lane stripe
  // Zero-based index within the group's term list; used to vary
  // lightness so siblings are distinguishable.
  indexInGroup: number;
}

interface GroupVis {
  id: string;
  label: string;
  hue: number;        // 0-360
  baseSat: number;    // 0-100
  baseLight: number;  // 0-100 — the lightest shade in the ramp
  termIds: string[];  // ordered by claim-pack
}

interface InventionVis {
  id: string;
  label: string;
  groupId: string;
  groupLabel: string;
  color: string;      // edge badge fill
  symbol: string;     // short glyph: △, ◆, ■, ◉, ✕, …
}

interface Palette {
  // Evidence class
  evidenceGroups: GroupVis[];
  evidenceTerms: TermVis[];
  evidenceTermById: Map<string, TermVis>;
  // Invention types (may be empty)
  inventionGroups: GroupVis[];
  inventionTerms: InventionVis[];
  inventionTermById: Map<string, InventionVis>;
  // Fixed-enum copies for convenience in the viewer JS payload.
  stanceBorder: Record<IntrinsicStance, string>;
  roleColor: Record<OccurrenceRole, string>;
}

// Ordered list of hues we prefer for the first few groups.
// Tuned so the common producer/amplifier/surrogate/other split gets
// orange / green / blue / gray respectively; extra groups fall back
// to a deterministic hue hash.
const SEMANTIC_GROUP_HUE: Record<string, { hue: number; sat: number; light: number }> = {
  producer: { hue: 28, sat: 82, light: 85 },
  amplifier: { hue: 135, sat: 50, light: 86 },
  surrogate: { hue: 205, sat: 72, light: 86 },
  other: { hue: 0, sat: 0, light: 90 },
  "content-distortion": { hue: 340, sat: 70, light: 55 },
  "source-distortion": { hue: 48, sat: 80, light: 58 },
};

function hashHue(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) * 16777619;
    h >>>= 0;
  }
  return h % 360;
}

function hslCss(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

const INVENTION_SYMBOLS = ["△", "◆", "■", "◉", "✕", "◀", "▼", "●"];

/**
 * Build a palette from the resolved claim pack and whatever terms are
 * actually observed in the graph (so an unused taxonomy term still
 * gets a color, but observed-but-undefined terms also don't blow up).
 */
function buildPalette(
  taxonomies: { evidenceClass?: readonly TaxonomyTerm[]; inventionTypes?: readonly TaxonomyTerm[] } | undefined,
  graph: GraphBundle,
): Palette {
  // Collect observed ids from the graph so we can synthesize entries
  // for any term that appears in data but wasn't declared in the
  // claim-pack (defensive: the visualizer should never crash on an
  // unknown id).
  const observedEvidence = new Set<string>();
  for (const p of graph.papers) observedEvidence.add(p.profile.evidenceClass);
  const observedInventions = new Set<string>();
  for (const e of graph.edges) for (const iv of e.inventionTypes ?? []) observedInventions.add(iv);

  const declaredEvidence = taxonomies?.evidenceClass ?? [];
  const declaredInventions = taxonomies?.inventionTypes ?? [];

  const evidenceMerged = mergeDeclaredAndObserved(declaredEvidence, observedEvidence);
  const inventionMerged = mergeDeclaredAndObserved(declaredInventions, observedInventions);

  const { groups: evidenceGroups, terms: evidenceTerms } = buildGroupedTerms(evidenceMerged);
  const { groups: inventionGroupsRaw, terms: inventionTermsRaw } = buildGroupedTerms(inventionMerged);

  // Inventions get distinct glyphs + darker colors; we reuse the
  // grouped-term builder but turn each TermVis into an InventionVis.
  const inventionTerms: InventionVis[] = inventionTermsRaw.map((t, i) => ({
    id: t.id,
    label: t.label,
    groupId: t.groupId,
    groupLabel: t.groupLabel,
    // Darken inventions slightly so they read as edge decoration not
    // node fill.
    color: darken(t.fill, 18),
    symbol: INVENTION_SYMBOLS[i % INVENTION_SYMBOLS.length]!,
  }));

  return {
    evidenceGroups,
    evidenceTerms,
    evidenceTermById: new Map(evidenceTerms.map((t) => [t.id, t])),
    inventionGroups: inventionGroupsRaw,
    inventionTerms,
    inventionTermById: new Map(inventionTerms.map((t) => [t.id, t])),
    stanceBorder: STANCE_BORDER,
    roleColor: ROLE_COLOR,
  };
}

/** Merge declared terms with observed-in-data ids, preserving declared order. */
function mergeDeclaredAndObserved(
  declared: readonly TaxonomyTerm[],
  observed: Set<string>,
): TaxonomyTerm[] {
  const out: TaxonomyTerm[] = [...declared];
  const known = new Set(declared.map((t) => t.id));
  for (const id of observed) {
    if (!known.has(id)) {
      out.push({ id, label: id, definition: "(not declared in claim-pack)" });
    }
  }
  return out;
}

/**
 * Group terms by their `group` field (or a synthetic per-term group if
 * the taxonomy has no grouping). Compute a per-group hue from the
 * semantic table when we recognise the group id, or hash otherwise.
 */
function buildGroupedTerms(
  terms: readonly TaxonomyTerm[],
): { groups: GroupVis[]; terms: TermVis[] } {
  const anyGrouped = terms.some((t) => t.group);
  const byGroup = new Map<string, { label: string; terms: TaxonomyTerm[] }>();
  const groupOrder: string[] = [];
  for (const t of terms) {
    const gid = t.group ?? t.id; // ungrouped → one group per term
    if (!byGroup.has(gid)) {
      byGroup.set(gid, { label: t.groupLabel ?? (anyGrouped ? gid : t.label), terms: [] });
      groupOrder.push(gid);
    }
    byGroup.get(gid)!.terms.push(t);
  }

  const groups: GroupVis[] = [];
  const termsOut: TermVis[] = [];
  for (const gid of groupOrder) {
    const entry = byGroup.get(gid)!;
    const { hue, sat, light } = SEMANTIC_GROUP_HUE[gid] ?? { hue: hashHue(gid), sat: 60, light: 82 };
    const group: GroupVis = {
      id: gid,
      label: entry.label,
      hue,
      baseSat: sat,
      baseLight: light,
      termIds: entry.terms.map((t) => t.id),
    };
    groups.push(group);
    entry.terms.forEach((t, i) => {
      // Darken each subsequent sibling so they're visually distinguishable.
      const l = Math.max(30, light - i * 10);
      const s = sat === 0 ? 0 : Math.max(0, sat - i * 5);
      termsOut.push({
        id: t.id,
        label: t.label,
        groupId: gid,
        groupLabel: entry.label,
        fill: hslCss(hue, s, l),
        indexInGroup: i,
      });
    });
  }
  return { groups, terms: termsOut };
}

function darken(hsl: string, byLightness: number): string {
  const m = hsl.match(/hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)/);
  if (!m) return hsl;
  const [, h, s, l] = m as unknown as [string, string, string, string];
  return hslCss(Number(h), Number(s), Math.max(20, Number(l) - byLightness));
}

// ---------- Entrypoint ----------

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      "run-id": { type: "string" },
      "graph-json": { type: "string" },
      "judgments-jsonl": { type: "string" },
      "claim-json": { type: "string" },
    },
  });
  const outDir = values["out-dir"];
  const graphPath = values["graph-json"];
  if (!outDir || !graphPath) {
    console.error("usage: --out-dir <dir> --graph-json <path> [--judgments-jsonl <path>] [--claim-json <path>]");
    process.exit(2);
  }
  const runId = values["run-id"] ?? "ad-hoc";
  const progress = new ProgressLog(join(outDir, "..", "progress.jsonl"));

  const graph = GraphBundleSchema.parse(JSON.parse(await readFile(graphPath, "utf8"))) as GraphBundle;
  const claimRaw = values["claim-json"]
    ? JSON.parse(await readFile(values["claim-json"], "utf8"))
    : undefined;
  const resolved: ResolvedClaimPack | undefined = claimRaw
    ? resolveClaimPack(ClaimPackSchema.parse(claimRaw))
    : undefined;
  const judgments: OccurrenceJudgment[] = values["judgments-jsonl"]
    ? (await readJsonl(values["judgments-jsonl"])) as OccurrenceJudgment[]
    : [];

  const palette = buildPalette(resolved, graph);

  await progress.emit({
    runId,
    kind: "task-start",
    taskType: "render",
    message: `papers=${graph.papers.length} edges=${graph.edges.length} evidenceGroups=${palette.evidenceGroups.length} inventionTerms=${palette.inventionTerms.length}`,
  });

  await mkdir(outDir, { recursive: true });

  const layout = layoutNodes(graph, palette);
  const svg = renderSvg(graph, layout, palette, resolved?.canonicalClaim);
  await writeFile(join(outDir, "history.svg"), svg, "utf8");

  const viewer = renderViewer(graph, layout, palette, resolved, judgments, svg);
  await writeFile(join(outDir, "viewer.html"), viewer, "utf8");

  const casebook = renderCasebook(graph, judgments, palette, resolved);
  await writeFile(join(outDir, "casebook.md"), casebook, "utf8");

  await progress.emit({
    runId,
    kind: "task-success",
    taskType: "render",
    message: "rendered history.svg + viewer.html + casebook.md",
  });

  console.log(`[render] wrote history.svg, viewer.html, casebook.md to ${outDir}`);
}

// ---------- Layout ----------

interface NodeLayout {
  paperId: string;
  termId: string;
  groupId: string;
  year: number;
  x: number;
  y: number;
  radius: number;
}

interface GraphLayout {
  nodes: NodeLayout[];
  nodeById: Map<string, NodeLayout>;
  width: number;
  height: number;
  chartTop: number;
  chartBottom: number;
  chartLeft: number;
  chartRight: number;
  yearMin: number;
  yearMax: number;
  groups: GroupVis[];          // columns, in render order
  groupXCenter: Map<string, number>;
  laneWidth: number;
}

function layoutNodes(graph: GraphBundle, palette: Palette): GraphLayout {
  const width = 1400;
  const chartTop = 80;
  const chartBottomPad = 80;
  const chartLeft = 120;
  const chartRightPad = 340;

  const years = graph.papers.map((p) => p.year);
  const yMinReal = years.length ? Math.min(...years) : 2020;
  const yMaxReal = years.length ? Math.max(...years) : 2024;
  const yMin = Math.min(yMinReal, 2020);
  const yMax = Math.max(yMaxReal, 2024);
  const yearRangeCount = Math.max(1, yMax - yMin);
  const heightPerYear = 70;
  const height = chartTop + heightPerYear * yearRangeCount + chartBottomPad;

  const groups = palette.evidenceGroups;
  const chartRight = width - chartRightPad;
  const laneWidth = groups.length > 0 ? (chartRight - chartLeft) / groups.length : 0;
  const groupXCenter = new Map<string, number>();
  groups.forEach((g, i) => groupXCenter.set(g.id, chartLeft + laneWidth * (i + 0.5)));

  // Cluster papers by (group, year) for horizontal stacking.
  const byGroupYear = new Map<string, GraphNode[]>();
  for (const p of graph.papers) {
    const term = palette.evidenceTermById.get(p.profile.evidenceClass);
    const gid = term?.groupId ?? "__unknown__";
    const key = `${gid}|${p.year}`;
    const arr = byGroupYear.get(key) ?? [];
    arr.push(p);
    byGroupYear.set(key, arr);
  }

  const nodes: NodeLayout[] = [];
  for (const p of graph.papers) {
    const term = palette.evidenceTermById.get(p.profile.evidenceClass);
    const gid = term?.groupId ?? "__unknown__";
    const xCenter = groupXCenter.get(gid) ?? chartLeft + laneWidth * 0.5;
    const stack = byGroupYear.get(`${gid}|${p.year}`) ?? [];
    const idx = stack.indexOf(p);
    const n = stack.length;
    const xSpread = Math.min(laneWidth - 30, 12 + n * 9);
    const xOffset = n <= 1 ? 0 : ((idx / (n - 1)) - 0.5) * xSpread;
    const x = xCenter + xOffset;
    const y = chartTop + (yMax - p.year) * heightPerYear + heightPerYear / 2;
    nodes.push({
      paperId: p.paperId,
      termId: p.profile.evidenceClass,
      groupId: gid,
      year: p.year,
      x,
      y,
      radius: 10,
    });
  }

  const nodeById = new Map(nodes.map((n) => [n.paperId, n]));
  return {
    nodes,
    nodeById,
    width,
    height,
    chartTop,
    chartBottom: height - chartBottomPad,
    chartLeft,
    chartRight,
    yearMin: yMin,
    yearMax: yMax,
    groups,
    groupXCenter,
    laneWidth,
  };
}

// ---------- SVG ----------

function renderSvg(
  graph: GraphBundle,
  layout: GraphLayout,
  palette: Palette,
  claimText?: string,
): string {
  const { width, height, chartTop, chartBottom, chartLeft, chartRight, yearMin, yearMax, nodes, nodeById, groups, groupXCenter, laneWidth } = layout;

  const nodeById2 = new Map<string, GraphNode>();
  for (const p of graph.papers) nodeById2.set(p.paperId, p);
  const authById = new Map(graph.authority.map((a) => [a.paperId, a]));

  // Assign a 1-based display integer by (year asc, group, id).
  const sortedNodes = [...nodes].sort((a, b) =>
    a.year - b.year || a.groupId.localeCompare(b.groupId) || a.paperId.localeCompare(b.paperId),
  );
  const displayById = new Map<string, number>();
  sortedNodes.forEach((n, i) => displayById.set(n.paperId, i + 1));

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12">`);
  lines.push(`<rect width="${width}" height="${height}" fill="#fafafa"/>`);

  // Title + claim caption
  lines.push(
    `<text x="${chartLeft}" y="36" font-size="18" font-weight="700">Claim citation map</text>`,
  );
  if (claimText) {
    lines.push(
      `<text x="${chartLeft}" y="58" font-size="13" fill="#333" font-style="italic">${escapeXml(claimText)}</text>`,
    );
  }

  // Year gridlines
  const heightPerYear = (chartBottom - chartTop) / Math.max(1, yearMax - yearMin);
  for (let y = yearMin; y <= yearMax; y++) {
    const yy = chartTop + (yearMax - y) * heightPerYear + heightPerYear / 2;
    lines.push(`<text x="${chartLeft - 16}" y="${yy + 4}" text-anchor="end" fill="#555">${y}</text>`);
    lines.push(`<line x1="${chartLeft}" y1="${yy}" x2="${chartRight}" y2="${yy}" stroke="#eee" stroke-width="1"/>`);
  }

  // Group headers (lanes)
  groups.forEach((g, i) => {
    const laneFill = hslCss(g.hue, g.baseSat * 0.6, Math.min(95, g.baseLight + 5));
    const laneX = chartLeft + laneWidth * i;
    const cx = groupXCenter.get(g.id)!;
    lines.push(`<rect x="${laneX}" y="${chartTop - 30}" width="${laneWidth}" height="24" fill="${laneFill}" stroke="#bbb"/>`);
    lines.push(`<text x="${cx}" y="${chartTop - 14}" text-anchor="middle" font-weight="600" fill="#222">${escapeXml(g.label)}</text>`);
    if (i > 0) {
      lines.push(`<line x1="${laneX}" y1="${chartTop}" x2="${laneX}" y2="${chartBottom}" stroke="#ddd" stroke-dasharray="2,4"/>`);
    }
  });

  // Arrow markers per role
  lines.push(`<defs>`);
  for (const [role, color] of Object.entries(ROLE_COLOR)) {
    lines.push(
      `<marker id="arrow-${role}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`,
    );
  }
  lines.push(`</defs>`);

  // Edges
  for (const e of graph.edges) {
    const a = nodeById.get(e.citingPaperId);
    const b = nodeById.get(e.citedPaperId);
    if (!a || !b) continue;
    const color = ROLE_COLOR[e.dominantRole];
    const opacity = 0.7;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const cx = (a.x + b.x) / 2 + dy * 0.06;
    const cy = (a.y + b.y) / 2 - dx * 0.06;
    const strokeWidth = e.mixedSignal ? 1.8 : 1.1;
    const inventionAttr = e.inventionTypes.length > 0
      ? ` data-invention="${e.inventionTypes.join(',')}"`
      : "";
    const mixedAttr = e.mixedSignal ? ` data-mixed="1"` : "";
    lines.push(
      `<path d="M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" opacity="${opacity}" marker-end="url(#arrow-${e.dominantRole})" data-role="${e.dominantRole}" data-edge="${e.edgeId}"${mixedAttr}${inventionAttr}/>`,
    );

    // Invention badges: a tiny glyph per flagged invention, stacked
    // near the cited endpoint.
    if (e.inventionTypes.length > 0) {
      const glyphs = e.inventionTypes.map((id) => palette.inventionTermById.get(id));
      let gx = b.x + 6;
      const gy = b.y - 10;
      for (const g of glyphs) {
        if (!g) continue;
        lines.push(
          `<text x="${gx}" y="${gy}" font-size="11" font-weight="700" fill="${g.color}" data-invention-badge="${g.id}">${escapeXml(g.symbol)}</text>`,
        );
        gx += 11;
      }
    }
  }

  // Nodes
  for (const n of nodes) {
    const node = nodeById2.get(n.paperId);
    const auth = authById.get(n.paperId);
    const term = palette.evidenceTermById.get(n.termId);
    const fill = term?.fill ?? "#d0d0d0";
    const border = STANCE_BORDER[node?.profile.intrinsicStance ?? "unclear"];
    const display = displayById.get(n.paperId)!;

    if (auth?.isAuthority) {
      lines.push(`<circle cx="${n.x}" cy="${n.y}" r="${n.radius + 4}" fill="#ffe45e" stroke="#d8b300" stroke-width="1.5" opacity="0.7"/>`);
    }
    lines.push(
      `<circle cx="${n.x}" cy="${n.y}" r="${n.radius}" fill="${fill}" stroke="${border}" stroke-width="${node?.profile.intrinsicStance === "unclear" ? 1 : 2}" data-paper="${n.paperId}" data-class="${n.termId}" data-group="${n.groupId}" data-stance="${node?.profile.intrinsicStance ?? "unclear"}" data-authority="${auth?.isAuthority ? 1 : 0}" data-retracted="${node?.retracted ? 1 : 0}" data-needsreview="${node?.profile.needsReview ? 1 : 0}"/>`,
    );
    lines.push(
      `<text x="${n.x}" y="${n.y + 4}" text-anchor="middle" font-size="10" font-weight="600" fill="#222" pointer-events="none">${display}</text>`,
    );
  }

  // Legend
  let legendX = chartRight + 24;
  let legendY = chartTop + 10;
  lines.push(`<text x="${legendX}" y="${legendY}" font-weight="700">Legend</text>`);
  legendY += 20;

  // Evidence class — grouped
  lines.push(`<text x="${legendX}" y="${legendY}" font-weight="600" fill="#333">Evidence class (node fill)</text>`);
  legendY += 14;
  for (const g of palette.evidenceGroups) {
    legendY += 18;
    lines.push(`<text x="${legendX}" y="${legendY}" font-size="11" font-weight="600" fill="#555">${escapeXml(g.label)}</text>`);
    for (const tid of g.termIds) {
      const term = palette.evidenceTermById.get(tid);
      if (!term) continue;
      legendY += 16;
      lines.push(`<rect x="${legendX + 10}" y="${legendY - 10}" width="11" height="11" fill="${term.fill}" stroke="#888"/>`);
      lines.push(`<text x="${legendX + 26}" y="${legendY}" font-size="11" fill="#333">${escapeXml(term.label)}</text>`);
    }
  }

  // Stance
  legendY += 24;
  lines.push(`<text x="${legendX}" y="${legendY}" font-weight="600" fill="#333">Intrinsic stance (node border)</text>`);
  for (const s of ["supportive","critical","mixed","unclear"] as IntrinsicStance[]) {
    legendY += 17;
    lines.push(`<circle cx="${legendX + 8}" cy="${legendY - 4}" r="6" fill="#ffffff" stroke="${STANCE_BORDER[s]}" stroke-width="2"/>`);
    lines.push(`<text x="${legendX + 20}" y="${legendY}" font-size="11" fill="#333">${s}</text>`);
  }

  // Authority halo
  legendY += 22;
  lines.push(`<text x="${legendX}" y="${legendY}" font-weight="600" fill="#333">Authority (yellow halo)</text>`);

  // Role
  legendY += 20;
  lines.push(`<text x="${legendX}" y="${legendY}" font-weight="600" fill="#333">Citation role (edge color)</text>`);
  for (const r of ["supportive","critical","neutral","mixed","unclear"] as OccurrenceRole[]) {
    legendY += 17;
    lines.push(`<line x1="${legendX}" y1="${legendY - 4}" x2="${legendX + 26}" y2="${legendY - 4}" stroke="${ROLE_COLOR[r]}" stroke-width="2"/>`);
    lines.push(`<text x="${legendX + 32}" y="${legendY}" font-size="11" fill="#333">${r}</text>`);
  }

  // Invention types (only if the taxonomy declared any and some are observed)
  if (palette.inventionTerms.length > 0) {
    legendY += 24;
    lines.push(`<text x="${legendX}" y="${legendY}" font-weight="600" fill="#333">Invention type (edge badge)</text>`);
    for (const g of palette.inventionGroups) {
      legendY += 16;
      lines.push(`<text x="${legendX}" y="${legendY}" font-size="11" font-weight="600" fill="#555">${escapeXml(g.label)}</text>`);
      for (const tid of g.termIds) {
        const t = palette.inventionTermById.get(tid);
        if (!t) continue;
        legendY += 16;
        lines.push(`<text x="${legendX + 10}" y="${legendY}" font-size="12" fill="${t.color}" font-weight="700">${escapeXml(t.symbol)}</text>`);
        lines.push(`<text x="${legendX + 26}" y="${legendY}" font-size="11" fill="#333">${escapeXml(t.label)}</text>`);
      }
    }
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

function splitAnalyses(graph: GraphBundle): { global: import("../../contracts/graph.ts").AnalysisResult[]; byScope: Map<string, import("../../contracts/graph.ts").AnalysisResult[]> } {
  const global: import("../../contracts/graph.ts").AnalysisResult[] = [];
  const byScope = new Map<string, import("../../contracts/graph.ts").AnalysisResult[]>();
  for (const a of Object.values(graph.analyses ?? {})) {
    if (!a.scope) { global.push(a); continue; }
    if (!byScope.has(a.scope)) byScope.set(a.scope, []);
    byScope.get(a.scope)!.push(a);
  }
  return { global, byScope };
}

function renderAnalysesMd(
  graph: GraphBundle,
  resolved: ResolvedClaimPack | undefined,
  fmt: (v: number | null | undefined) => string,
): string {
  const { global, byScope } = splitAnalyses(graph);
  const lines: string[] = [];
  if (global.length > 0) {
    lines.push(`## Analyses (whole claim)`, ``);
    lines.push(`| metric | value | denominator |`);
    lines.push(`|---|---|---|`);
    for (const a of global) {
      const denom = typeof a.denominator === "number" ? String(a.denominator) : "—";
      lines.push(`| ${a.label} | ${fmt(a.value)} | ${denom} |`);
    }
    lines.push(``);
  }
  if (byScope.size > 0) {
    lines.push(`## Analyses (per subclaim)`, ``);
    const subclaimText = new Map((resolved?.subclaims ?? []).map((s) => [s.id, s.text]));
    for (const [sid, arr] of byScope) {
      lines.push(`### \`${sid}\`${subclaimText.has(sid) ? ` — ${subclaimText.get(sid)}` : ""}`, ``);
      lines.push(`| metric | value | denominator |`);
      lines.push(`|---|---|---|`);
      for (const a of arr) {
        const denom = typeof a.denominator === "number" ? String(a.denominator) : "—";
        lines.push(`| ${a.label} | ${fmt(a.value)} | ${denom} |`);
      }
      lines.push(``);
    }
  }
  return lines.join("\n");
}

function renderAnalysesHtml(
  graph: GraphBundle,
  resolved: ResolvedClaimPack | undefined,
  fmt: (v: number | null | undefined) => string,
): string {
  const { global, byScope } = splitAnalyses(graph);
  const lines: string[] = [];
  if (global.length > 0) {
    lines.push(`<h2>Analyses (whole claim)</h2>`);
    lines.push(`<div class="metric-grid">`);
    for (const a of global) {
      const denom = typeof a.denominator === "number" ? ` <em style="color:#888">(n=${a.denominator})</em>` : "";
      lines.push(`<div class="metric"><span>${escapeHtml(a.label)}</span><b>${fmt(a.value)}</b></div>`);
    }
    lines.push(`</div>`);
  }
  if (byScope.size > 0) {
    lines.push(`<h2>Analyses by subclaim</h2>`);
    const subclaimText = new Map((resolved?.subclaims ?? []).map((s) => [s.id, s.text]));
    for (const [sid, arr] of byScope) {
      lines.push(`<h3><code>${escapeHtml(sid)}</code>${subclaimText.has(sid) ? ` — ${escapeHtml(subclaimText.get(sid)!)}` : ""}</h3>`);
      lines.push(`<div class="metric-grid">`);
      for (const a of arr) {
        lines.push(`<div class="metric"><span>${escapeHtml(a.label)}</span><b>${fmt(a.value)}</b></div>`);
      }
      lines.push(`</div>`);
    }
  }
  return lines.join("\n");
}

// ---------- Viewer HTML ----------

function renderViewer(
  graph: GraphBundle,
  layout: GraphLayout,
  palette: Palette,
  claim: ResolvedClaimPack | undefined,
  judgments: OccurrenceJudgment[],
  svg: string,
): string {
  // Build a lightweight palette payload for client-side rendering.
  const palettePayload = {
    evidenceGroups: palette.evidenceGroups.map((g) => ({ id: g.id, label: g.label, termIds: g.termIds })),
    evidenceTerms: palette.evidenceTerms,
    inventionGroups: palette.inventionGroups.map((g) => ({ id: g.id, label: g.label, termIds: g.termIds })),
    inventionTerms: palette.inventionTerms,
    stanceBorder: STANCE_BORDER,
    roleColor: ROLE_COLOR,
  };

  const observedStances = new Set<string>();
  for (const p of graph.papers) observedStances.add(p.profile.intrinsicStance);
  const observedRoles = new Set<string>();
  for (const e of graph.edges) observedRoles.add(e.dominantRole);

  const canonical = claim?.canonicalClaim;
  const reviewerNotes = claim?.reviewerNotes;
  const subclaims = claim?.subclaims ?? [];

  const years = graph.papers.map((p) => p.year).filter((y) => Number.isFinite(y));
  const yearMin = years.length ? Math.min(...years) : 2020;
  const yearMax = years.length ? Math.max(...years) : 2025;

  const fmtMetric = (v: number | null | undefined): string =>
    v === null || v === undefined ? "<em style='color:#999'>N/A</em>" : v.toFixed(2);

  const payload = {
    claim: claim ?? null,
    analyses: graph.analyses ?? {},
    edgeTotals: graph.edgeTotals,
    papers: graph.papers,
    edges: graph.edges,
    authority: graph.authority,
    judgments,
    subclaims,
    yearBounds: { min: yearMin, max: yearMax },
  };

  const displayById: Record<string, number> = {};
  [...layout.nodes]
    .sort((a, b) => a.year - b.year || a.groupId.localeCompare(b.groupId) || a.paperId.localeCompare(b.paperId))
    .forEach((n, i) => { displayById[n.paperId] = i + 1; });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Claim Cartographer — ${escapeHtml(canonical ?? "graph viewer")}</title>
<style>
  body { font: 14px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #f5f5f6; color: #222; }
  header { background: #1a1a1a; color: #fafafa; padding: 14px 22px; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header .claim { font-size: 13px; opacity: 0.85; font-style: italic; }
  .layout { display: grid; grid-template-columns: minmax(0, 3fr) minmax(320px, 1.4fr); gap: 16px; padding: 16px; max-width: 1900px; margin: 0 auto; }
  .graph-pane { background: white; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); padding: 12px; overflow: auto; max-height: calc(100vh - 140px); }
  .sidebar { background: white; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); padding: 16px; max-height: calc(100vh - 140px); overflow: auto; }
  .sidebar h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #555; margin: 18px 0 6px; }
  .sidebar h2:first-child { margin-top: 0; }
  .sidebar h3 { font-size: 13px; margin: 12px 0 4px; color: #333; }
  .sidebar h4 { font-size: 12px; margin: 8px 0 2px; color: #666; text-transform: uppercase; letter-spacing: 0.02em; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 4px 0; }
  .kv dt { color: #666; font-size: 12px; }
  .kv dd { margin: 0; font-size: 13px; }
  .metric-grid { display: grid; grid-template-columns: 1fr; gap: 2px 12px; }
  .metric-grid .metric { display: flex; justify-content: space-between; padding: 2px 0; font-size: 12px; }
  .metric-grid .metric b { font-variant-numeric: tabular-nums; }
  .edge-row { border-top: 1px solid #eee; padding: 6px 0; font-size: 12px; }
  .edge-row .sentence { color: #333; }
  .edge-row .meta { color: #666; margin-bottom: 2px; }
  .role-supportive { color: #111; }
  .role-critical { color: #d64545; }
  .role-neutral { color: #3a8a3a; }
  .role-mixed { color: #1f6bc9; }
  .role-unclear { color: #888; }
  .filter-block { border-top: 1px solid #eee; padding: 8px 0; }
  .filter-block:first-of-type { border-top: 0; padding-top: 0; }
  .filter-block .group-label { font-size: 11px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 0.04em; margin: 6px 0 2px; }
  .filter-block label { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 0; cursor: pointer; }
  .filter-block label input { margin: 0; }
  .swatch { display: inline-block; width: 11px; height: 11px; border: 1px solid #888; vertical-align: middle; }
  .glyph { display: inline-block; font-weight: 700; font-size: 13px; width: 11px; text-align: center; }
  .filter-actions { display: flex; gap: 6px; margin: 6px 0 2px; font-size: 11px; }
  .filter-actions button { background: #f0f0f0; border: 1px solid #ccc; border-radius: 3px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
  svg { max-width: 100%; height: auto; }
  svg circle[data-paper]:hover { cursor: pointer; stroke-width: 3; }
  svg path[data-edge]:hover { cursor: pointer; stroke-width: 3 !important; }
  .tag { display: inline-block; background: #efefef; color: #333; border-radius: 3px; padding: 0 6px; font-size: 11px; }
  details summary { cursor: pointer; color: #1f6bc9; font-size: 12px; }
  .node-hidden { display: none !important; }
  .edge-hidden { display: none !important; }
  .edge-dim { opacity: 0.12 !important; }
  .invention-tag { display: inline-block; font-weight: 700; margin-right: 4px; }
  /* controls bar sits above the svg */
  .controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 12px; padding: 8px 12px; border-bottom: 1px solid #eee; margin-bottom: 8px; font-size: 12px; color: #333; }
  .controls .ctrl { display: flex; flex-direction: column; gap: 2px; }
  .controls .ctrl-label { font-size: 10px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 0.04em; }
  .controls .ctrl select, .controls .ctrl input[type=text], .controls .ctrl input[type=number] { font: inherit; padding: 3px 6px; border: 1px solid #ccc; border-radius: 3px; }
  .controls .ctrl input[type=range] { width: 100%; }
  .year-range { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 4px; }
  .year-range input { width: 60px; text-align: center; }
  .slider-row { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; }
  /* detail level classes — toggled on body; CSS hides/shows decorations */
  body.detail-1 svg circle[r="14"] { display: none; }                  /* no halos */
  body.detail-1 svg text[data-invention-badge] { display: none; }      /* no invention glyphs */
  body.detail-1 svg text[data-rank] { display: none; }                 /* no rank numbers */
  body.detail-2 svg text[data-rank] { display: none; }                 /* default: no rank numbers */
  /* subclaim pills */
  .sc-pill { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 8px; margin-right: 3px; color: #fff; }
  .claim-header { background: #f7f7f7; border: 1px solid #eee; padding: 8px 10px; border-radius: 4px; margin-bottom: 10px; font-size: 12px; }
  .claim-header h3 { margin: 0 0 4px; font-size: 13px; color: #111; }
  .claim-header .sc-list { margin: 4px 0; padding: 0; list-style: none; font-size: 11px; }
  .claim-header .sc-list li { padding: 1px 0; color: #444; }
  .claim-header .sc-id { font-family: ui-monospace, monospace; font-weight: 700; color: #1f6bc9; margin-right: 4px; }
  /* tabs */
  .tab-row { display: flex; gap: 4px; margin: 8px 0 6px; border-bottom: 2px solid #eee; }
  .tab-row button { background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -2px; padding: 5px 10px; font: inherit; font-size: 12px; color: #666; cursor: pointer; }
  .tab-row button.active { color: #1f6bc9; border-bottom-color: #1f6bc9; font-weight: 600; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
</style>
</head>
<body class="detail-2">
<header>
  <h1>Claim Cartographer</h1>
  <div class="claim">${escapeHtml(canonical ?? "(no claim metadata)")}</div>
</header>
<div class="layout">
  <div class="graph-pane">
    <div class="controls">
      <div class="ctrl">
        <span class="ctrl-label">Focus subclaim</span>
        <select id="focusSubclaim">
          <option value="">All subclaims (whole claim)</option>
          ${subclaims.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.id)} — ${escapeHtml(s.text)}</option>`).join("")}
        </select>
      </div>
      <div class="ctrl">
        <span class="ctrl-label">Detail level</span>
        <div class="slider-row">
          <input id="detailSlider" type="range" min="1" max="3" value="2" step="1"/>
          <span id="detailLabel">2 · default</span>
        </div>
      </div>
      <div class="ctrl">
        <span class="ctrl-label">Years</span>
        <div class="year-range">
          <input id="yearMin" type="number" min="${yearMin - 1}" max="${yearMax + 1}" value="${yearMin}"/>
          –
          <input id="yearMax" type="number" min="${yearMin - 1}" max="${yearMax + 1}" value="${yearMax}"/>
        </div>
      </div>
      <div class="ctrl">
        <span class="ctrl-label">Search title</span>
        <input id="search" type="text" placeholder="e.g. RECOVERY, Gautret"/>
      </div>
    </div>
    ${svg}
  </div>
  <div class="sidebar" id="sidebar">
    <div class="claim-header">
      <h3>Focal claim</h3>
      <div>${escapeHtml(canonical ?? "(none)")}</div>
      ${subclaims.length > 0 ? `<ul class="sc-list">${subclaims.map((s) => `<li><span class="sc-id" id="sc-legend-${escapeHtml(s.id)}">${escapeHtml(s.id)}</span> ${escapeHtml(s.text)}</li>`).join("")}</ul>` : ""}
    </div>

    <div class="tab-row">
      <button class="active" data-tab="summary">Summary</button>
      <button data-tab="filters">Filters</button>
      <button data-tab="detail">Detail</button>
    </div>

    <div class="tab-panel active" data-panel="summary">
      <h2>Graph summary</h2>
      <div class="kv">
        <dt>Papers</dt><dd>${graph.papers.length}</dd>
        <dt>Edges</dt><dd>${graph.edges.length}</dd>
        <dt>Orphans</dt><dd>${graph.orphanPaperIds.length}</dd>
        <dt>Authorities</dt><dd>${graph.authority.filter((a) => a.isAuthority).length}</dd>
      </div>

      <h2>Edge totals</h2>
      <div class="metric-grid">
        <div class="metric"><span>supportive</span><b>${graph.edgeTotals.supportive}</b></div>
        <div class="metric"><span>critical</span><b>${graph.edgeTotals.critical}</b></div>
        <div class="metric"><span>neutral</span><b>${graph.edgeTotals.neutral}</b></div>
        <div class="metric"><span>mixed</span><b>${graph.edgeTotals.mixed}</b></div>
        <div class="metric"><span>unclear</span><b>${graph.edgeTotals.unclear}</b></div>
      </div>

      ${renderAnalysesHtml(graph, claim, fmtMetric)}
    </div>

    <div class="tab-panel" data-panel="filters">
      <div class="filter-actions">
        <button onclick="resetFilters()">Show all</button>
        <button onclick="hideAllFilters()">Hide all</button>
      </div>
      <div id="filters"></div>
    </div>

    <div class="tab-panel" data-panel="detail">
      <div id="nodeDetail">Click a circle to see its profile and citations, or click an edge to see its occurrences.</div>
    </div>
  </div>
</div>
<script>
const GRAPH = ${JSON.stringify(payload)};
const PALETTE = ${JSON.stringify(palettePayload)};
const DISPLAY = ${JSON.stringify(displayById)};
const OBSERVED_STANCES = ${JSON.stringify([...observedStances])};
const OBSERVED_ROLES = ${JSON.stringify([...observedRoles])};

const byPaper = new Map(GRAPH.papers.map(p => [p.paperId, p]));
const edgeById = new Map(GRAPH.edges.map(e => [e.edgeId, e]));
const edgesByPaper = new Map();
for (const e of GRAPH.edges) {
  if (!edgesByPaper.has(e.citingPaperId)) edgesByPaper.set(e.citingPaperId, { out: [], in: [] });
  if (!edgesByPaper.has(e.citedPaperId))  edgesByPaper.set(e.citedPaperId,  { out: [], in: [] });
  edgesByPaper.get(e.citingPaperId).out.push(e);
  edgesByPaper.get(e.citedPaperId).in.push(e);
}
const judgmentsByOccurrence = new Map(GRAPH.judgments.map(j => [j.occurrenceId, j]));
const evidenceTermById = new Map(PALETTE.evidenceTerms.map(t => [t.id, t]));
const inventionTermById = new Map(PALETTE.inventionTerms.map(t => [t.id, t]));
const SUBCLAIMS = GRAPH.subclaims || [];

// Deterministic color per subclaim (stable across runs for the same id).
// Used for pills in detail panels and the header legend.
function hashInt(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) * 16777619; h >>>= 0; }
  return h;
}
const SC_COLORS = {};
SUBCLAIMS.forEach((s, i) => {
  // Use a 10-hue rotation seeded by hash so the first subclaims land
  // on distinct colors and later ones don't collide.
  const hue = (hashInt(s.id) % 360);
  SC_COLORS[s.id] = 'hsl(' + hue + ' 65% 42%)';
});
// Paint the sc-legend spans in the header so they match the pills.
for (const sid of Object.keys(SC_COLORS)) {
  const el = document.getElementById('sc-legend-' + sid);
  if (el) el.style.color = SC_COLORS[sid];
}

function esc(s) { return String(s ?? '').replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

function scPill(sid) {
  const color = SC_COLORS[sid] || '#666';
  return '<span class="sc-pill" style="background:' + color + '">' + esc(sid) + '</span>';
}

function inventionTag(iv) {
  const t = inventionTermById.get(iv);
  if (!t) return '<span class="invention-tag">' + esc(iv) + '</span>';
  return '<span class="invention-tag" style="color:' + t.color + '">' + esc(t.symbol) + ' ' + esc(t.label) + '</span>';
}

// ---------- Paper detail ----------

function renderPaper(paperId) {
  const p = byPaper.get(paperId);
  if (!p) return '<p>Unknown paper.</p>';
  const auth = GRAPH.authority.find(a => a.paperId === paperId);
  const edges = edgesByPaper.get(paperId) || { in: [], out: [] };
  const cls = evidenceTermById.get(p.profile.evidenceClass);
  const occRow = (occId) => {
    const j = judgmentsByOccurrence.get(occId);
    if (!j) return '';
    const role = j.role;
    const inv = j.inventionType ? ' ' + inventionTag(j.inventionType) : '';
    const scs = (j.subclaimIds || []).map(scPill).join('');
    return '<div class="edge-row">'
      + '<div class="meta">' + esc(j.occurrenceId) + ' — <span class="role-' + role + '">' + role + '</span> (conf ' + j.confidence.toFixed(2) + ')' + inv
      + (j.needsReview ? ' <span class="tag">needs review</span>' : '')
      + (scs ? ' ' + scs : '')
      + '</div>'
      + '<div class="sentence">' + esc(j.rationale) + '</div>'
      + (j.citingEvidence && j.citingEvidence.length ? '<details><summary>citing evidence</summary><ul>' + j.citingEvidence.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul></details>' : '')
      + '</div>';
  };
  return '<h2 style="margin-top:0">Paper detail</h2>'
    + '<div class="kv">'
    + '<dt>ID</dt><dd>#' + (DISPLAY[paperId] ?? '?') + ' · <code>' + esc(paperId) + '</code></dd>'
    + '<dt>Title</dt><dd>' + esc(p.title ?? p.paperId) + '</dd>'
    + '<dt>Year</dt><dd>' + p.year + '</dd>'
    + '<dt>Venue</dt><dd>' + esc(p.venue ?? '—') + '</dd>'
    + '<dt>Evidence class</dt><dd><span class="swatch" style="background:' + (cls?.fill || '#ccc') + '"></span> ' + esc(cls?.label || p.profile.evidenceClass) + ' <em style="color:#888">(' + esc(cls?.groupLabel || '—') + ')</em></dd>'
    + '<dt>Intrinsic stance</dt><dd>' + esc(p.profile.intrinsicStance) + '</dd>'
    + '<dt>Relevance</dt><dd>' + p.profile.relevance.toFixed(2) + '</dd>'
    + '<dt>Authority</dt><dd>' + (auth ? auth.authorityScore.toFixed(2) + (auth.isAuthority ? ' (AUTHORITY)' : '') : '—') + '</dd>'
    + (p.retracted ? '<dt>Retracted</dt><dd style="color:#b33">yes</dd>' : '')
    + (p.profile.needsReview ? '<dt>Needs review</dt><dd>yes</dd>' : '')
    + '</div>'
    + '<details open><summary>Rationale</summary><p>' + esc(p.profile.rationale) + '</p></details>'
    + (p.profile.claimSpans.length ? '<details><summary>Claim spans (examples)</summary><ul>' + p.profile.claimSpans.map(s => '<li><i>(' + esc(s.section || '?') + ')</i> ' + esc(s.text) + '</li>').join('') + '</ul></details>' : '')
    + '<h3>Outgoing edges (' + edges.out.length + ')</h3>'
    + (edges.out.flatMap(e => e.occurrenceIds).map(occRow).join('') || '<p>(none)</p>')
    + '<h3>Incoming edges (' + edges.in.length + ')</h3>'
    + (edges.in.flatMap(e => e.occurrenceIds).map(occRow).join('') || '<p>(none)</p>');
}

// ---------- Edge detail ----------

function renderEdge(edgeId) {
  const e = edgeById.get(edgeId);
  if (!e) return '<p>Unknown edge.</p>';
  const citing = byPaper.get(e.citingPaperId);
  const cited = byPaper.get(e.citedPaperId);
  const occRow = (occId) => {
    const j = judgmentsByOccurrence.get(occId);
    if (!j) return '';
    const role = j.role;
    const inv = j.inventionType ? ' ' + inventionTag(j.inventionType) : '';
    const scs = (j.subclaimIds || []).map(scPill).join('');
    return '<div class="edge-row">'
      + '<div class="meta">' + esc(j.occurrenceId) + ' — <span class="role-' + role + '">' + role + '</span> (conf ' + j.confidence.toFixed(2) + ')' + inv + (scs ? ' ' + scs : '') + '</div>'
      + '<div class="sentence">' + esc(j.rationale) + '</div>'
      + (j.citingEvidence && j.citingEvidence.length ? '<details open><summary>citing sentence</summary><ul>' + j.citingEvidence.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul></details>' : '')
      + (j.citedEvidence && j.citedEvidence.length ? '<details><summary>cited evidence</summary><ul>' + j.citedEvidence.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul></details>' : '')
      + '</div>';
  };
  const roleCounts = Object.entries(e.roleCounts || {}).filter(([,v]) => v > 0).map(([k,v]) => k + '=' + v).join(', ');
  const scBreakdown = Object.entries(e.rolesBySubclaim || {}).map(([sid, counts]) => {
    const parts = Object.entries(counts).filter(([,v]) => v > 0).map(([r,v]) => r + '=' + v).join(', ');
    return '<li>' + scPill(sid) + ' ' + esc(parts || '—') + '</li>';
  }).join('');
  return '<h2 style="margin-top:0">Edge detail</h2>'
    + '<div class="kv">'
    + '<dt>Edge</dt><dd><code>' + esc(edgeId) + '</code></dd>'
    + '<dt>Citing</dt><dd>#' + (DISPLAY[e.citingPaperId] ?? '?') + ' ' + esc(citing?.title ?? e.citingPaperId) + '</dd>'
    + '<dt>Cited</dt><dd>#' + (DISPLAY[e.citedPaperId] ?? '?') + ' ' + esc(cited?.title ?? e.citedPaperId) + '</dd>'
    + '<dt>Dominant role</dt><dd><span class="role-' + e.dominantRole + '">' + e.dominantRole + '</span></dd>'
    + '<dt>Mixed signal</dt><dd>' + (e.mixedSignal ? 'yes' : 'no') + '</dd>'
    + '<dt>Role counts</dt><dd>' + esc(roleCounts) + '</dd>'
    + (e.inventionTypes && e.inventionTypes.length ? '<dt>Invention flags</dt><dd>' + e.inventionTypes.map(inventionTag).join(' ') + '</dd>' : '')
    + '<dt>Confidence</dt><dd>' + (typeof e.confidence === 'number' ? e.confidence.toFixed(2) : '—') + '</dd>'
    + '</div>'
    + (scBreakdown ? '<h3>Per-subclaim role counts</h3><ul>' + scBreakdown + '</ul>' : '')
    + '<h3>Occurrences (' + e.occurrenceIds.length + ')</h3>'
    + (e.occurrenceIds.map(occRow).join('') || '<p>(none)</p>');
}

// ---------- Filter sidebar ----------

function makeFilterBlock(title, items, attrName) {
  const block = document.createElement('div');
  block.className = 'filter-block';
  const h = document.createElement('h3');
  h.textContent = title;
  block.appendChild(h);
  for (const it of items) {
    if (it.groupLabel) {
      const gl = document.createElement('div');
      gl.className = 'group-label';
      gl.textContent = it.groupLabel;
      block.appendChild(gl);
      for (const t of it.terms) appendFilterItem(block, t, attrName);
    } else {
      appendFilterItem(block, it, attrName);
    }
  }
  return block;
}
function appendFilterItem(block, it, attrName) {
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = it.checked !== false;
  cb.setAttribute('data-filter', attrName);
  cb.setAttribute('data-value', it.id);
  cb.addEventListener('change', applyFilters);
  label.appendChild(cb);
  if (it.swatch) {
    const s = document.createElement('span');
    s.className = 'swatch';
    s.style.background = it.swatch;
    label.appendChild(s);
  }
  if (it.glyph) {
    const g = document.createElement('span');
    g.className = 'glyph';
    g.style.color = it.glyphColor || '#333';
    g.textContent = it.glyph;
    label.appendChild(g);
  }
  const txt = document.createElement('span');
  txt.textContent = it.label;
  label.appendChild(txt);
  block.appendChild(label);
}

function buildFilters() {
  const root = document.getElementById('filters');
  root.innerHTML = '';

  // Evidence class (grouped)
  const evidenceItems = PALETTE.evidenceGroups.map(g => ({
    groupLabel: g.label,
    terms: g.termIds.map(tid => {
      const t = evidenceTermById.get(tid);
      return { id: tid, label: t?.label || tid, swatch: t?.fill || '#ccc' };
    }),
  }));
  root.appendChild(makeFilterBlock('Evidence class', evidenceItems, 'class'));

  // Stance
  root.appendChild(makeFilterBlock('Intrinsic stance', OBSERVED_STANCES.map(s => ({
    id: s, label: s, swatch: '#fff',
  })), 'stance'));

  // Role
  root.appendChild(makeFilterBlock('Edge role', OBSERVED_ROLES.map(r => ({
    id: r, label: r, swatch: PALETTE.roleColor[r] || '#888',
  })), 'role'));

  // Subclaims (if any). Each checkbox keeps edges that engage that subclaim.
  if (SUBCLAIMS.length > 0) {
    root.appendChild(makeFilterBlock('Engages subclaim', SUBCLAIMS.map(s => ({
      id: s.id, label: s.id + ' — ' + s.text, swatch: SC_COLORS[s.id],
    })), 'subclaim'));
    // Extra row: allow edges not labeled with any subclaim to remain visible.
    const block = document.querySelector('.filter-block:last-of-type');
    const gl = document.createElement('div');
    gl.className = 'group-label';
    gl.textContent = 'Unlabeled';
    block.appendChild(gl);
    appendFilterItem(block, { id: '__none__', label: 'edges with no subclaim label', swatch: '#ddd' }, 'subclaim');
  }

  // Invention types
  if (PALETTE.inventionTerms.length > 0) {
    const inventionItems = PALETTE.inventionGroups.map(g => ({
      groupLabel: g.label,
      terms: g.termIds.map(tid => {
        const t = inventionTermById.get(tid);
        return { id: tid, label: t?.label || tid, glyph: t?.symbol || '?', glyphColor: t?.color };
      }),
    }));
    root.appendChild(makeFilterBlock('Invention type', inventionItems, 'invention'));
  }

  // Flags (off by default when restrictive, on by default when inclusive)
  const flags = [
    { id: 'mixedSignal', label: 'Mixed-signal edges only', def: false },
    { id: 'hasInvention', label: 'Invention-flagged edges only', def: false },
    { id: 'authority', label: 'Authorities only', def: false },
    { id: 'retracted', label: 'Show retracted papers', def: true },
    { id: 'needsReview', label: 'Show needs-review papers', def: true },
  ];
  const flagBlock = document.createElement('div');
  flagBlock.className = 'filter-block';
  const h = document.createElement('h3'); h.textContent = 'Flags'; flagBlock.appendChild(h);
  for (const f of flags) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = f.def;
    cb.setAttribute('data-flag', f.id);
    cb.addEventListener('change', applyFilters);
    label.appendChild(cb);
    const t = document.createElement('span'); t.textContent = f.label; label.appendChild(t);
    flagBlock.appendChild(label);
  }
  root.appendChild(flagBlock);
}

function getActiveSet(attr) {
  const s = new Set();
  document.querySelectorAll('input[data-filter="' + attr + '"]').forEach(cb => {
    if (cb.checked) s.add(cb.getAttribute('data-value'));
  });
  return s;
}
function getFlag(id) {
  const cb = document.querySelector('input[data-flag="' + id + '"]');
  return cb && cb.checked;
}
function getControlValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

// ---------- Filter / focus / detail engine ----------

function pickDominantFromCounts(counts) {
  const order = ['supportive','critical','mixed','neutral','unclear'];
  let best = 'unclear', bestN = -1;
  for (const r of order) {
    const n = counts[r] || 0;
    if (n > bestN) { best = r; bestN = n; }
  }
  return best;
}

function applyFilters() {
  const activeClass = getActiveSet('class');
  const activeStance = getActiveSet('stance');
  const activeRole = getActiveSet('role');
  const activeSub = getActiveSet('subclaim');
  const activeInvention = getActiveSet('invention');
  const mixedOnly = getFlag('mixedSignal');
  const inventionOnly = getFlag('hasInvention');
  const authorityOnly = getFlag('authority');
  const showRetracted = getFlag('retracted');
  const showNeedsReview = getFlag('needsReview');

  const focus = getControlValue('focusSubclaim');
  const yMin = Number(getControlValue('yearMin'));
  const yMax = Number(getControlValue('yearMax'));
  const search = (getControlValue('search') || '').trim().toLowerCase();

  const visiblePaperIds = new Set();
  document.querySelectorAll('svg circle[data-paper]').forEach(c => {
    const pid = c.getAttribute('data-paper');
    const p = byPaper.get(pid);
    const cls = c.getAttribute('data-class');
    const stance = c.getAttribute('data-stance');
    const authority = c.getAttribute('data-authority') === '1';
    const retracted = c.getAttribute('data-retracted') === '1';
    const needsreview = c.getAttribute('data-needsreview') === '1';
    let show = activeClass.has(cls) && activeStance.has(stance);
    if (authorityOnly && !authority) show = false;
    if (retracted && !showRetracted) show = false;
    if (needsreview && !showNeedsReview) show = false;
    if (p && Number.isFinite(yMin) && p.year < yMin) show = false;
    if (p && Number.isFinite(yMax) && p.year > yMax) show = false;
    if (search && p && !(p.title || '').toLowerCase().includes(search)) show = false;
    c.classList.toggle('node-hidden', !show);
    const txt = c.nextElementSibling;
    if (txt && txt.tagName === 'text') txt.classList.toggle('node-hidden', !show);
    if (show) visiblePaperIds.add(pid);
  });

  document.querySelectorAll('svg path[data-edge]').forEach(path => {
    const edgeId = path.getAttribute('data-edge');
    const edge = edgeById.get(edgeId);
    if (!edge) return;
    const globalRole = edge.dominantRole;
    const mixed = !!edge.mixedSignal;
    const inventions = edge.inventionTypes || [];
    const scKeys = Object.keys(edge.rolesBySubclaim || {});

    // Subclaim filter: if any subclaim checkbox is unchecked, hide
    // edges that engage ONLY unchecked subclaims. Edges with no
    // subclaim label use the __none__ pseudo-id.
    let subclaimOK = true;
    if (SUBCLAIMS.length > 0) {
      if (scKeys.length === 0) {
        subclaimOK = activeSub.has('__none__');
      } else {
        subclaimOK = scKeys.some(k => activeSub.has(k));
      }
    }

    // Role filter: depends on focus mode. If focus is "all", use the
    // whole-claim dominant role; if focused on a subclaim, use that
    // subclaim's dominant role (an edge not engaging the focused
    // subclaim gets no role, and is dimmed rather than hidden so
    // the user can still see graph density).
    let displayRole = globalRole;
    let inFocus = true;
    if (focus && SUBCLAIMS.length > 0) {
      const counts = (edge.rolesBySubclaim || {})[focus];
      if (counts && Object.values(counts).some(v => v > 0)) {
        displayRole = pickDominantFromCounts(counts);
      } else {
        inFocus = false;
      }
    }

    let show = activeRole.has(displayRole) && subclaimOK;
    if (mixedOnly && !mixed) show = false;
    if (inventionOnly && inventions.length === 0) show = false;
    if (activeInvention.size > 0 && inventions.length > 0 && !inventions.some(iv => activeInvention.has(iv))) show = false;
    if (!visiblePaperIds.has(edge.citingPaperId) || !visiblePaperIds.has(edge.citedPaperId)) show = false;

    // Recolor edge based on displayRole in focus mode.
    if (focus && inFocus) {
      path.setAttribute('stroke', PALETTE.roleColor[displayRole] || '#888');
      path.setAttribute('marker-end', 'url(#arrow-' + displayRole + ')');
    } else if (focus && !inFocus) {
      // Dim edges that don't engage the focused subclaim.
      path.classList.add('edge-dim');
    } else {
      // Reset to original role color
      path.setAttribute('stroke', PALETTE.roleColor[globalRole] || '#888');
      path.setAttribute('marker-end', 'url(#arrow-' + globalRole + ')');
      path.classList.remove('edge-dim');
    }
    if (focus && inFocus) path.classList.remove('edge-dim');

    path.classList.toggle('edge-hidden', !show);
  });

  document.querySelectorAll('svg text[data-invention-badge]').forEach(el => {
    const id = el.getAttribute('data-invention-badge');
    const show = activeInvention.size === 0 || activeInvention.has(id);
    el.classList.toggle('edge-hidden', !show);
  });
}

// ---------- Reset helpers ----------

function resetFilters() {
  document.querySelectorAll('#filters input[type=checkbox][data-filter]').forEach(cb => { cb.checked = true; });
  document.querySelectorAll('input[data-flag="mixedSignal"],input[data-flag="hasInvention"],input[data-flag="authority"]').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('input[data-flag="retracted"],input[data-flag="needsReview"]').forEach(cb => { cb.checked = true; });
  applyFilters();
}
function hideAllFilters() {
  document.querySelectorAll('#filters input[type=checkbox][data-filter]').forEach(cb => { cb.checked = false; });
  applyFilters();
}

// ---------- Detail level ----------

function setDetailLevel(n) {
  document.body.classList.remove('detail-1','detail-2','detail-3');
  document.body.classList.add('detail-' + n);
  const label = document.getElementById('detailLabel');
  if (label) label.textContent = n + ' · ' + (n === '1' ? 'simple' : n === '3' ? 'dense' : 'default');
}

// ---------- Tabs ----------

function switchTab(target) {
  document.querySelectorAll('.tab-row button').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === target);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.getAttribute('data-panel') === target);
  });
}

// ---------- Wiring ----------

document.querySelectorAll('svg circle[data-paper]').forEach(c => {
  c.addEventListener('click', (ev) => {
    const id = ev.currentTarget.getAttribute('data-paper');
    document.getElementById('nodeDetail').innerHTML = renderPaper(id);
    switchTab('detail');
  });
});
document.querySelectorAll('svg path[data-edge]').forEach(p => {
  p.addEventListener('click', (ev) => {
    const id = ev.currentTarget.getAttribute('data-edge');
    document.getElementById('nodeDetail').innerHTML = renderEdge(id);
    switchTab('detail');
  });
});

document.getElementById('focusSubclaim').addEventListener('change', applyFilters);
document.getElementById('detailSlider').addEventListener('input', (e) => setDetailLevel(e.target.value));
document.getElementById('yearMin').addEventListener('input', applyFilters);
document.getElementById('yearMax').addEventListener('input', applyFilters);
document.getElementById('search').addEventListener('input', applyFilters);

document.querySelectorAll('.tab-row button').forEach(b => {
  b.addEventListener('click', () => switchTab(b.getAttribute('data-tab')));
});

buildFilters();
setDetailLevel('2');
applyFilters();
</script>
</body>
</html>
`;
}

// ---------- Casebook ----------

function renderCasebook(
  graph: GraphBundle,
  judgments: OccurrenceJudgment[],
  palette: Palette,
  claim: ResolvedClaimPack | undefined,
): string {
  const judgmentById = new Map(judgments.map((j) => [j.occurrenceId, j]));
  const auth = [...graph.authority].sort((a, b) => b.authorityScore - a.authorityScore).slice(0, 10);
  const mixed = graph.edges.filter((e) => e.mixedSignal);
  const withInvention = graph.edges.filter((e) => e.inventionTypes.length > 0);
  const nodeById = new Map(graph.papers.map((p) => [p.paperId, p]));
  const fmt = (v: number | null | undefined): string =>
    v === null || v === undefined ? "N/A (too sparse)" : v.toFixed(2);

  const classLabel = (id: string): string => palette.evidenceTermById.get(id)?.label ?? id;

  const sampleRoleEdges = (role: OccurrenceRole, n = 3): EdgeBundle[] =>
    graph.edges.filter((e) => e.dominantRole === role).slice(0, n);

  const roleSection = (title: string, role: OccurrenceRole) => {
    const sample = sampleRoleEdges(role, 3);
    if (sample.length === 0) return `### ${title}\n\n_(no edges of this role in the run)_\n`;
    const bullets = sample.map((e) => {
      const first = e.occurrenceIds[0];
      const j = first ? judgmentById.get(first) : undefined;
      const citing = nodeById.get(e.citingPaperId);
      const cited = nodeById.get(e.citedPaperId);
      const inv = e.inventionTypes.length > 0 ? ` · invention: ${e.inventionTypes.join(", ")}` : "";
      return `- **${e.citingPaperId}** → **${e.citedPaperId}** · conf ${e.confidence.toFixed(2)}${e.mixedSignal ? " · mixed" : ""}${inv}\n  - citing: ${classLabel(citing?.profile.evidenceClass ?? "?")} / ${citing?.profile.intrinsicStance ?? "?"}\n  - cited: ${classLabel(cited?.profile.evidenceClass ?? "?")} / ${cited?.profile.intrinsicStance ?? "?"}${j ? `\n  - rationale: ${j.rationale}` : ""}`;
    });
    return `### ${title}\n\n${bullets.join("\n")}\n`;
  };

  const c = claim;

  const taxonomySection = (() => {
    if (palette.evidenceGroups.length === 0) return "";
    const lines: string[] = [`## Taxonomy in use`, ``];
    lines.push(`**Evidence class groups:**`);
    for (const g of palette.evidenceGroups) {
      lines.push(`- _${g.label}_ (\`${g.id}\`) — ${g.termIds.map((id) => classLabel(id)).join("; ")}`);
    }
    if (palette.inventionTerms.length > 0) {
      lines.push(``);
      lines.push(`**Invention type groups:**`);
      for (const g of palette.inventionGroups) {
        lines.push(`- _${g.label}_ (\`${g.id}\`) — ${g.termIds.map((id) => palette.inventionTermById.get(id)?.label ?? id).join("; ")}`);
      }
    }
    return lines.join("\n");
  })();

  const inventionSection = (() => {
    if (withInvention.length === 0) return "_None — every citation was honest._";
    const byType: Record<string, EdgeBundle[]> = {};
    for (const e of withInvention) {
      for (const t of e.inventionTypes) {
        if (!byType[t]) byType[t] = [];
        byType[t].push(e);
      }
    }
    const lines: string[] = [];
    for (const [typeId, edges] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
      const label = palette.inventionTermById.get(typeId)?.label ?? typeId;
      lines.push(`### ${label} (\`${typeId}\`) — ${edges.length} edge(s)`);
      for (const e of edges.slice(0, 5)) {
        lines.push(`- **${e.citingPaperId}** → **${e.citedPaperId}** · ${e.occurrenceIds.length} occurrence(s)`);
      }
    }
    return lines.join("\n");
  })();

  return [
    `# Casebook: ${c?.canonicalClaim ?? "(untitled claim)"}`,
    ``,
    `Run ID: \`${graph.runId}\` · Claim ID: \`${graph.claimId}\``,
    ``,
    `## Corpus boundaries`,
    ``,
    c?.reviewerNotes ?? "_(no reviewer notes recorded)_",
    ``,
    taxonomySection,
    ``,
    `## Graph at a glance`,
    ``,
    `- **Papers**: ${graph.papers.length}`,
    `- **Edges**: ${graph.edges.length}`,
    `- **Authorities** (score > 0.5): ${graph.authority.filter((a) => a.isAuthority).length}`,
    `- **Orphan relevant papers**: ${graph.orphanPaperIds.length}`,
    `- **Mixed-signal edges**: ${mixed.length}`,
    `- **Edges with invention flags**: ${withInvention.length}`,
    ``,
    renderAnalysesMd(graph, claim, fmt),
    ``,
    `## Top authorities`,
    ``,
    auth.length === 0
      ? "_(none)_"
      : auth
          .map((a) => {
            const p = nodeById.get(a.paperId);
            return `- **${a.paperId}** (${p?.year ?? "?"}) — score ${a.authorityScore.toFixed(2)}, supportive-in-degree ${a.supportiveInDegree}, total-in-degree ${a.totalInDegree}${p ? ` (${classLabel(p.profile.evidenceClass)} / ${p.profile.intrinsicStance})` : ""}`;
          })
          .join("\n"),
    ``,
    `## Illustrative edges`,
    ``,
    roleSection("Supportive", "supportive"),
    roleSection("Critical", "critical"),
    roleSection("Mixed", "mixed"),
    ``,
    `## Mixed-signal edges`,
    ``,
    mixed.length === 0
      ? "_None — every edge pointed consistently._"
      : mixed.slice(0, 10).map((e) => `- **${e.citingPaperId}** → **${e.citedPaperId}**: supportive=${e.roleCounts.supportive ?? 0}, critical=${e.roleCounts.critical ?? 0}`).join("\n"),
    ``,
    `## Citation-invention patterns`,
    ``,
    inventionSection,
    ``,
    graph.papers.length < 30
      ? `## Note\n\n_Only ${graph.papers.length} relevant papers survived profiling; graph statistics are fragile at this size._\n`
      : "",
    ``,
    `---`,
    ``,
    `_Generated by Claim Cartographer._`,
    ``,
  ].filter((l) => l !== "").join("\n");
}

// ---------- utils ----------

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!),
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
