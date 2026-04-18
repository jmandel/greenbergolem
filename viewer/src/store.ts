// Viewer state: selection, filters, view-mode. Zustand keeps it simple and
// out of React context.
//
// Filters are driven by the resolved claim pack's taxonomy groups, not a
// hardcoded lane list. A "lane" in this viewer is an evidence-class
// GROUP (producer / amplifier / surrogate / other for biomedical);
// each group contains one or more evidence-class terms. Filter state is
// keyed by group id.

import { create } from "zustand";
import type { OccurrenceRole, RunBundle, IntrinsicStance } from "./lib/types.ts";
import { buildPalette, type Palette } from "./lib/palette.ts";

export type ViewMode =
  | "default"          // Greenberg-style: producer group split by stance, others consolidated
  | "stance-split"     // every group sub-split by intrinsic stance
  | "lens"             // highlight top amplifier nodes + incoming supportive flows
  | "invention-audit"; // only invention-flagged edges, rationale in detail

export interface ViewerState {
  bundle: RunBundle | null;
  palette: Palette | null;
  viewMode: ViewMode;
  selectedPaperId: string | null;
  selectedEdgeId: string | null;
  hoverPaperId: string | null;
  roleFilter: Record<OccurrenceRole, boolean>;
  stanceFilter: Record<IntrinsicStance, boolean>;
  // Filter by evidence-class GROUP id (producer / amplifier / surrogate / other / …)
  groupFilter: Record<string, boolean>;
  yearRange: [number, number] | null;
  // Density: fraction of non-authority papers to show (0.05–1.0).
  // Deterministic: papers are hashed to [0,1) once at bundle load;
  // a paper is visible iff its hash < densityFrac OR it's an authority.
  // All edges between hidden papers are hidden too.
  densityFrac: number;
  sidebarOpen: boolean;
  sidebarWidth: number;

  setBundle: (b: RunBundle) => void;
  setViewMode: (m: ViewMode) => void;
  selectPaper: (id: string | null) => void;
  selectEdge: (id: string | null) => void;
  setHover: (id: string | null) => void;
  toggleRole: (r: OccurrenceRole) => void;
  toggleStance: (s: IntrinsicStance) => void;
  toggleGroup: (gid: string) => void;
  setYearRange: (r: [number, number] | null) => void;
  setDensityFrac: (f: number) => void;
  resetFilters: () => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
}

const ALL_ROLES: OccurrenceRole[] = ["supportive", "critical", "neutral", "mixed", "unclear"];
const ALL_STANCES: IntrinsicStance[] = ["supportive", "critical", "mixed", "unclear"];

const allOn = <K extends string>(keys: readonly K[]): Record<K, boolean> =>
  Object.fromEntries(keys.map((k) => [k, true])) as Record<K, boolean>;

// Default density targets ~the same visible edge count Greenberg showed
// in fig 1 (n=678). Solved analytically: with random thinning that
// keeps a fraction d of non-authority papers (authorities always
// kept), expected visible edges = n_aa + n_an·d + n_nn·d², where
// (n_aa, n_an, n_nn) count edges by how many endpoints are authorities.
// Solve for d. Clamped to [0.05, 1].
const DEFAULT_TARGET_EDGES = 678;
function pickDefaultDensity(b: RunBundle): number {
  const authIds = new Set(b.graph.authority.filter((a) => a.isAuthority).map((a) => a.paperId));
  let nAA = 0, nAN = 0, nNN = 0;
  for (const e of b.graph.edges) {
    const a = authIds.has(e.citingPaperId);
    const c = authIds.has(e.citedPaperId);
    if (a && c) nAA++;
    else if (a || c) nAN++;
    else nNN++;
  }
  const target = Math.min(DEFAULT_TARGET_EDGES, b.graph.edges.length);
  if (b.graph.edges.length <= target) return 1;
  // Find d ∈ [0,1] such that nAA + nAN·d + nNN·d² = target.
  // Quadratic: nNN·d² + nAN·d + (nAA - target) = 0.
  if (nNN < 1) return Math.max(0.05, Math.min(1, nAN > 0 ? (target - nAA) / nAN : 1));
  const disc = nAN * nAN - 4 * nNN * (nAA - target);
  if (disc < 0) return 1;
  const d = (-nAN + Math.sqrt(disc)) / (2 * nNN);
  return Math.max(0.05, Math.min(1, d));
}

export const useViewer = create<ViewerState>((set) => ({
  bundle: null,
  palette: null,
  viewMode: "default",
  selectedPaperId: null,
  selectedEdgeId: null,
  hoverPaperId: null,
  roleFilter: allOn(ALL_ROLES),
  stanceFilter: allOn(ALL_STANCES),
  groupFilter: {},
  yearRange: null,
  densityFrac: 1,
  sidebarOpen: true,
  sidebarWidth: 340,

  setBundle: (b) =>
    set(() => {
      const years = b.graph.papers.map((p) => p.year);
      const min = years.length ? Math.min(...years) : 2020;
      const max = years.length ? Math.max(...years) : 2025;
      const palette = buildPalette(b.resolved, b.graph);
      const groupFilter = Object.fromEntries(palette.evidenceGroups.map((g) => [g.id, true]));
      return {
        bundle: b,
        palette,
        yearRange: [min, max],
        groupFilter,
        densityFrac: pickDefaultDensity(b),
      };
    }),
  setViewMode: (m) => set({ viewMode: m }),
  selectPaper: (id) => set({ selectedPaperId: id, selectedEdgeId: null }),
  selectEdge: (id) => set({ selectedEdgeId: id, selectedPaperId: null }),
  setHover: (id) => set({ hoverPaperId: id }),
  toggleRole: (r) => set((s) => ({ roleFilter: { ...s.roleFilter, [r]: !s.roleFilter[r] } })),
  toggleStance: (st) => set((s) => ({ stanceFilter: { ...s.stanceFilter, [st]: !s.stanceFilter[st] } })),
  toggleGroup: (gid) => set((s) => ({ groupFilter: { ...s.groupFilter, [gid]: !s.groupFilter[gid] } })),
  setYearRange: (r) => set({ yearRange: r }),
  setDensityFrac: (f) => set({ densityFrac: Math.max(0.05, Math.min(1, f)) }),
  resetFilters: () =>
    set((s) => ({
      roleFilter: allOn(ALL_ROLES),
      stanceFilter: allOn(ALL_STANCES),
      groupFilter: s.palette ? Object.fromEntries(s.palette.evidenceGroups.map((g) => [g.id, true])) : {},
      yearRange: s.bundle
        ? [
            Math.min(...s.bundle.graph.papers.map((p) => p.year)),
            Math.max(...s.bundle.graph.papers.map((p) => p.year)),
          ]
        : null,
      densityFrac: s.bundle ? pickDefaultDensity(s.bundle) : 1,
    })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(220, Math.min(640, w)) }),
}));
