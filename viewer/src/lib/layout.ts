// Layout functions driven by the claim-pack's taxonomy groups + view
// mode. Produces `(x, y, r, …)` per paper for the SVG renderer.
//
// Modes:
//   * "greenberg"     — Greenberg 2009 default: ONE column per group,
//                       except the producer group which is sub-split by
//                       stance (critical | supportive | …), because
//                       stance differences among primary data are what
//                       authority-status bias acts upon. Reviews,
//                       models, and other are single columns.
//   * "group"         — one column per group, no stance sub-split
//                       (useful when stance is mostly missing).
//   * "stance-split"  — every group sub-split by stance (maximum
//                       detail; gets noisy on large graphs).

import type { GraphBundle, GraphNode, IntrinsicStance } from "./types.ts";
import type { Palette } from "./palette.ts";

export interface LayoutOpts {
  width: number;
  chartTop: number;
  chartBottom: number;
  chartLeft: number;
  chartRight: number;
  heightPerYear: number;
  nodeRadius: number;
}

export const DEFAULT_OPTS: LayoutOpts = {
  width: 1400,
  chartTop: 90,
  chartBottom: 40,
  chartLeft: 70,
  chartRight: 30,
  heightPerYear: 60,
  nodeRadius: 9,
};

export function fitLayoutOpts(
  yearCount: number,
  containerW: number,
  containerH: number,
): LayoutOpts {
  const base = DEFAULT_OPTS;
  // Width: fill the container exactly, no minimum. The SVG uses
  // viewBox + preserveAspectRatio, so the rendered image scales to
  // whatever the browser gives us; we just need a reasonable internal
  // coordinate system.
  const width = Math.max(800, containerW > 0 ? containerW : base.width);
  const availableH = Math.max(240, (containerH > 0 ? containerH : 800) - (base.chartTop + base.chartBottom) - 12);
  // Target: entire figure fits in the viewport by default (Greenberg's
  // fig 1 is one static image). Shrink heightPerYear if the chart
  // would otherwise overflow vertically.
  const naturalH = yearCount * base.heightPerYear;
  if (naturalH <= availableH) return { ...base, width };
  const heightPerYear = Math.max(32, Math.floor(availableH / Math.max(1, yearCount)));
  const nodeRadius = Math.max(4, Math.min(base.nodeRadius, Math.floor(heightPerYear / 6)));
  return { ...base, width, heightPerYear, nodeRadius };
}

export interface NodePosition {
  paperId: string;
  node: GraphNode;
  groupId: string;
  stance: IntrinsicStance;
  year: number;
  x: number;
  y: number;
  r: number;
  displayNumber: number;
}

export interface LayoutResult {
  positions: NodePosition[];
  byId: Map<string, NodePosition>;
  width: number;
  height: number;
  chartTop: number;
  chartBottom: number;
  chartLeft: number;
  chartRight: number;
  yearMin: number;
  yearMax: number;
  // For column-header rendering:
  columns: Array<{ id: string; label: string; subLabel?: string; x: number; width: number; groupId: string }>;
}

// Stance sub-column order for split modes.
const STANCE_ORDER_FULL: IntrinsicStance[] = ["critical", "supportive", "mixed", "unclear"];
// In Greenberg mode we collapse mixed/unclear into supportive so the
// producer split is just critical | supportive, matching fig 1.
const STANCE_ORDER_GREENBERG: IntrinsicStance[] = ["critical", "supportive"];

// When in greenberg mode, bucket each stance into one of the two sub-
// column keys. In stance-split mode we keep all four distinct.
function stanceBucket(mode: LayoutMode, s: IntrinsicStance): IntrinsicStance {
  if (mode !== "greenberg") return s;
  return s === "critical" ? "critical" : "supportive";
}

export type LayoutMode = "greenberg" | "group" | "stance-split";

// Groups that get stance-sub-split in "greenberg" mode. Producer is
// always split (stance matters most for primary data). Everything else
// stays consolidated. Extend here if future claim packs add other
// groups whose stance deserves positional separation.
const GREENBERG_SPLIT_GROUPS = new Set(["producer"]);

export function paperLayout(
  graph: GraphBundle,
  palette: Palette,
  mode: LayoutMode,
  opts: LayoutOpts = DEFAULT_OPTS,
): LayoutResult {
  const { width, chartTop, chartBottom: chartBottomMargin, chartLeft, chartRight: chartRightMargin, heightPerYear, nodeRadius } = opts;

  const years = graph.papers.map((p) => p.year);
  const yMinData = years.length ? Math.min(...years) : 2020;
  const yMaxData = years.length ? Math.max(...years) : 2024;
  const yearMin = yMinData;
  const yearMax = yMaxData;
  const yearCount = Math.max(1, yearMax - yearMin + 1);
  const height = chartTop + yearCount * heightPerYear + chartBottomMargin;
  const chartBottom = height - chartBottomMargin;
  const chartRight = width - chartRightMargin;

  const shouldSplit = (gid: string): boolean => {
    if (mode === "stance-split") return true;
    if (mode === "greenberg") return GREENBERG_SPLIT_GROUPS.has(gid);
    return false;
  };

  const colKeyFor = (p: GraphNode): string => {
    const gid = palette.evidenceTermById.get(p.profile.evidenceClass)?.groupId ?? "__unknown__";
    if (!shouldSplit(gid)) return gid;
    const bucket = stanceBucket(mode, p.profile.intrinsicStance);
    return `${gid}|${bucket}`;
  };

  const keysWithData = new Set<string>();
  for (const p of graph.papers) keysWithData.add(colKeyFor(p));

  const stanceOrder = mode === "greenberg" ? STANCE_ORDER_GREENBERG : STANCE_ORDER_FULL;
  const ordered: Array<{ id: string; label: string; subLabel?: string; groupId: string }> = [];
  for (const g of palette.evidenceGroups) {
    if (shouldSplit(g.id)) {
      for (const st of stanceOrder) {
        const k = `${g.id}|${st}`;
        if (!keysWithData.has(k)) continue;
        ordered.push({ id: k, label: g.label, subLabel: st, groupId: g.id });
      }
    } else {
      if (!keysWithData.has(g.id)) continue;
      ordered.push({ id: g.id, label: g.label, groupId: g.id });
    }
  }
  for (const k of keysWithData) {
    if (!ordered.some((c) => c.id === k)) {
      const [gid, st] = k.split("|");
      ordered.push({ id: k, label: gid || "unknown", subLabel: st, groupId: gid || "unknown" });
    }
  }

  // Column widths: proportional to sqrt(paper count) so the "other"
  // column (which dominates in Greenberg's figure) gets more room than
  // a sparse critical-primary sub-column. Floor + square-root keep the
  // contrast visible without letting one column swallow everything.
  const colCounts = new Map<string, number>();
  for (const p of graph.papers) {
    const k = colKeyFor(p);
    colCounts.set(k, (colCounts.get(k) ?? 0) + 1);
  }
  const weightOf = (k: string) => Math.max(1, Math.sqrt(colCounts.get(k) ?? 0)) + 0.5;
  const totalWeight = ordered.reduce((s, c) => s + weightOf(c.id), 0) || 1;
  const usableColsW = chartRight - chartLeft;

  const columns: LayoutResult["columns"] = [];
  let cursor = chartLeft;
  ordered.forEach((c) => {
    const w = (weightOf(c.id) / totalWeight) * usableColsW;
    columns.push({ ...c, x: cursor + w / 2, width: w });
    cursor += w;
  });
  const colByKey = new Map(columns.map((c) => [c.id, c]));

  const authByPaper = new Map(graph.authority.map((a) => [a.paperId, a.authorityScore]));
  const sorted = [...graph.papers].sort((a, b) => {
    const byYear = a.year - b.year;
    if (byYear !== 0) return byYear;
    const ci = columns.findIndex((c) => c.id === colKeyFor(a));
    const cj = columns.findIndex((c) => c.id === colKeyFor(b));
    if (ci !== cj) return ci - cj;
    const ad = (authByPaper.get(b.paperId) ?? 0) - (authByPaper.get(a.paperId) ?? 0);
    if (ad !== 0) return ad;
    return a.paperId.localeCompare(b.paperId);
  });
  const displayById = new Map<string, number>();
  sorted.forEach((n, i) => displayById.set(n.paperId, i + 1));

  const cells = new Map<string, { colId: string; nodes: GraphNode[] }>();
  for (const p of graph.papers) {
    const colId = colKeyFor(p);
    const key = `${colId}\u241e${p.year}`;
    const entry = cells.get(key) ?? { colId, nodes: [] };
    entry.nodes.push(p);
    cells.set(key, entry);
  }

  const cellPadding = 4;
  const pitch = nodeRadius * 2 + cellPadding;
  const usableH = heightPerYear - cellPadding * 2;
  const rowsFit = Math.max(1, Math.floor(usableH / pitch));

  const positions: NodePosition[] = [];
  for (const entry of cells.values()) {
    const col = colByKey.get(entry.colId);
    if (!col) continue;
    const usableW = col.width - cellPadding * 2;
    const cols = Math.max(1, Math.floor(usableW / pitch));
    const ordered = [...entry.nodes].sort((a, b) => {
      const d = (authByPaper.get(b.paperId) ?? 0) - (authByPaper.get(a.paperId) ?? 0);
      if (d !== 0) return d;
      return a.paperId.localeCompare(b.paperId);
    });
    const cellNodes = ordered.length;
    const neededRows = Math.ceil(cellNodes / cols);
    const effectivePitch = neededRows > rowsFit ? usableH / neededRows : pitch;
    const effectiveR = Math.max(4, Math.min(nodeRadius, (effectivePitch - cellPadding) / 2));
    const effectiveCols = neededRows > rowsFit
      ? Math.max(1, Math.floor(usableW / effectivePitch))
      : cols;
    const actualRows = Math.ceil(cellNodes / effectiveCols);

    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i]!;
      const colI = i % effectiveCols;
      const row = Math.floor(i / effectiveCols);
      const usedCols = Math.min(effectiveCols, cellNodes - row * effectiveCols);
      const rowWidth = (usedCols - 1) * effectivePitch;
      const xStart = col.x - rowWidth / 2;
      const x = xStart + colI * effectivePitch;
      const yBandCenter = chartTop + (yearMax - p.year) * heightPerYear + heightPerYear / 2;
      const bandHeight = (actualRows - 1) * effectivePitch;
      const yStart = yBandCenter - bandHeight / 2;
      const y = yStart + row * effectivePitch;
      const gid = palette.evidenceTermById.get(p.profile.evidenceClass)?.groupId ?? "__unknown__";
      positions.push({
        paperId: p.paperId,
        node: p,
        groupId: gid,
        stance: p.profile.intrinsicStance,
        year: p.year,
        x,
        y,
        r: effectiveR,
        displayNumber: displayById.get(p.paperId) ?? 0,
      });
    }
  }

  const byId = new Map(positions.map((p) => [p.paperId, p]));
  return {
    positions,
    byId,
    width,
    height,
    chartTop,
    chartBottom,
    chartLeft,
    chartRight,
    yearMin,
    yearMax,
    columns,
  };
}
