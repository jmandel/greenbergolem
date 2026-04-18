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
  resetFilters: () => void;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
}

const ALL_ROLES: OccurrenceRole[] = ["supportive", "critical", "neutral", "mixed", "unclear"];
const ALL_STANCES: IntrinsicStance[] = ["supportive", "critical", "mixed", "unclear"];

const allOn = <K extends string>(keys: readonly K[]): Record<K, boolean> =>
  Object.fromEntries(keys.map((k) => [k, true])) as Record<K, boolean>;

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
  sidebarOpen: true,
  sidebarWidth: 340,

  setBundle: (b) =>
    set(() => {
      const years = b.graph.papers.map((p) => p.year);
      const min = years.length ? Math.min(...years) : 2020;
      const max = years.length ? Math.max(...years) : 2025;
      const palette = buildPalette(b.resolved, b.graph);
      const groupFilter = Object.fromEntries(palette.evidenceGroups.map((g) => [g.id, true]));
      return { bundle: b, palette, yearRange: [min, max], groupFilter };
    }),
  setViewMode: (m) => set({ viewMode: m }),
  selectPaper: (id) => set({ selectedPaperId: id, selectedEdgeId: null }),
  selectEdge: (id) => set({ selectedEdgeId: id, selectedPaperId: null }),
  setHover: (id) => set({ hoverPaperId: id }),
  toggleRole: (r) => set((s) => ({ roleFilter: { ...s.roleFilter, [r]: !s.roleFilter[r] } })),
  toggleStance: (st) => set((s) => ({ stanceFilter: { ...s.stanceFilter, [st]: !s.stanceFilter[st] } })),
  toggleGroup: (gid) => set((s) => ({ groupFilter: { ...s.groupFilter, [gid]: !s.groupFilter[gid] } })),
  setYearRange: (r) => set({ yearRange: r }),
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
    })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(220, Math.min(640, w)) }),
}));
