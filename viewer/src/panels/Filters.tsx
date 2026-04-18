// Top-of-sidebar controls: view mode + year. All other filters (stance,
// role, group) live inside a collapsed details block so the default
// view is clean.

import { useViewer, type ViewMode } from "../store.ts";
import { ROLE_COLOR, STANCE_COLOR } from "../lib/palette.ts";
import type { OccurrenceRole, IntrinsicStance, RunBundle } from "../lib/types.ts";
import { Help } from "./Help.tsx";

function estimateVisibleEdges(bundle: RunBundle | null, d: number): number {
  if (!bundle) return 0;
  const authIds = new Set(bundle.graph.authority.filter((a) => a.isAuthority).map((a) => a.paperId));
  let n = 0;
  for (const e of bundle.graph.edges) {
    const a = authIds.has(e.citingPaperId);
    const c = authIds.has(e.citedPaperId);
    if (a && c) n += 1;
    else if (a || c) n += d;
    else n += d * d;
  }
  return Math.round(n);
}

const ROLES: OccurrenceRole[] = ["supportive", "critical", "neutral", "mixed", "unclear"];
const STANCES: IntrinsicStance[] = ["supportive", "critical", "mixed", "unclear"];

const VIEW_MODES: Array<{ id: ViewMode; label: string; blurb: string }> = [
  { id: "default", label: "Greenberg", blurb: "Primary data split by stance; reviews, models, and other consolidated." },
  { id: "lens", label: "Lens", blurb: "Top amplifier papers foregrounded with their incoming supportive citations — shows the lens effect." },
  { id: "invention-audit", label: "Inventions", blurb: "Hide non-distortion edges. Click a paper to trace its invention chain." },
  { id: "stance-split", label: "All stances", blurb: "Every evidence group sub-split by stance. Maximum detail; can get noisy." },
];

export function Filters() {
  const bundle = useViewer((s) => s.bundle);
  const palette = useViewer((s) => s.palette);
  const viewMode = useViewer((s) => s.viewMode);
  const setViewMode = useViewer((s) => s.setViewMode);
  const roleFilter = useViewer((s) => s.roleFilter);
  const stanceFilter = useViewer((s) => s.stanceFilter);
  const groupFilter = useViewer((s) => s.groupFilter);
  const yearRange = useViewer((s) => s.yearRange);
  const densityFrac = useViewer((s) => s.densityFrac);
  const toggleRole = useViewer((s) => s.toggleRole);
  const toggleStance = useViewer((s) => s.toggleStance);
  const toggleGroup = useViewer((s) => s.toggleGroup);
  const setYearRange = useViewer((s) => s.setYearRange);
  const setDensityFrac = useViewer((s) => s.setDensityFrac);
  const reset = useViewer((s) => s.resetFilters);

  if (!bundle || !palette) return null;
  const years = bundle.graph.papers.map((p) => p.year);
  const yMin = years.length ? Math.min(...years) : 2020;
  const yMax = years.length ? Math.max(...years) : 2025;

  const activeMode = VIEW_MODES.find((m) => m.id === viewMode) ?? VIEW_MODES[0]!;

  const activeFilterCount =
    ROLES.filter((r) => !roleFilter[r]).length +
    STANCES.filter((s) => !stanceFilter[s]).length +
    Object.entries(groupFilter).filter(([, v]) => !v).length;

  return (
    <div className="controls">
      <div className="control-section">
        <div className="section-head">
          <span className="section-title">View</span>
          <Help term="View modes">
            <p>Four lenses on the same citation network.</p>
            <ul>
              <li><b>Greenberg</b> — the default. Primary data split left/right into critical vs supportive. Reviews, models, and other consolidated.</li>
              <li><b>Lens</b> — highlights the ~5 most-cited review papers and the supportive traffic flowing to them. Makes the <i>lens effect</i> visible: a tiny number of papers channel most of the traffic.</li>
              <li><b>Inventions</b> — shows only citation distortions (transmutation, diversion, dead-end, back-door, retraction-blindness). Click any paper to trace its invention chain.</li>
              <li><b>All stances</b> — every evidence group split by stance. Useful when you want to see critique-starvation across models or reviews too.</li>
            </ul>
          </Help>
        </div>
        <div className="segmented">
          {VIEW_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`seg ${viewMode === m.id ? "active" : ""}`}
              onClick={() => setViewMode(m.id)}
              title={m.blurb}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="view-blurb">{activeMode.blurb}</p>
      </div>

      <div className="control-section">
        <div className="section-head">
          <span className="section-title">Year</span>
          <span className="section-aside">through {yearRange ? yearRange[1] : yMax}</span>
        </div>
        <input
          className="year-slider"
          type="range"
          min={yMin}
          max={yMax}
          value={yearRange ? yearRange[1] : yMax}
          onChange={(e) => setYearRange([yMin, Number(e.target.value)])}
        />
      </div>

      <div className="control-section">
        <div className="section-head">
          <span className="section-title">Density</span>
          <span className="section-aside">
            {Math.round(densityFrac * 100)}% · ≈{estimateVisibleEdges(bundle, densityFrac)} edges
          </span>
          <Help term="Density">
            <p>Randomly hides a fraction of non-authority papers (deterministic per paper id, so toggling stays coherent). All authorities are always kept.</p>
            <p>Default is picked so the visible-edge count lands near Greenberg 2009 fig 1 (~678 edges) — the density human eyes can scan.</p>
            <p>Edge survival is roughly density² since both endpoints must survive.</p>
          </Help>
        </div>
        <input
          className="year-slider"
          type="range"
          min={5}
          max={100}
          step={1}
          value={Math.round(densityFrac * 100)}
          onChange={(e) => setDensityFrac(Number(e.target.value) / 100)}
        />
      </div>

      <details className="control-section collapsible">
        <summary>
          <span className="section-title">Filters</span>
          {activeFilterCount > 0 && (
            <span className="pill">{activeFilterCount} hidden</span>
          )}
        </summary>
        <div className="filter-grid">
          <div>
            <div className="filter-label">
              Citation role
              <Help term="Citation role">
                <p>Stance of the <i>citation</i> from the citing paper toward the focal claim.</p>
                <ul>
                  <li><b>supportive</b> — the citation is made in support of the claim.</li>
                  <li><b>critical</b> — the citation challenges, contradicts, or weakens it.</li>
                  <li><b>neutral</b> — referenced without committing to a position.</li>
                  <li><b>mixed</b> — the occurrence carries both supportive and critical readings.</li>
                  <li><b>unclear</b> — the classifier couldn't decide.</li>
                </ul>
              </Help>
            </div>
            {ROLES.map((r) => (
              <label key={r} className="ck">
                <input type="checkbox" checked={roleFilter[r]} onChange={() => toggleRole(r)} />
                <span style={{ color: ROLE_COLOR[r] }}>{r}</span>
              </label>
            ))}
          </div>
          <div>
            <div className="filter-label">
              Paper stance
              <Help term="Paper stance (intrinsic)">
                <p>The paper's own stance on the focal claim, before looking at who cites it.</p>
                <p>Shown as the <strong>node border color</strong>.</p>
              </Help>
            </div>
            {STANCES.map((s) => (
              <label key={s} className="ck">
                <input type="checkbox" checked={stanceFilter[s]} onChange={() => toggleStance(s)} />
                <span style={{ color: STANCE_COLOR[s] }}>{s}</span>
              </label>
            ))}
          </div>
          <div>
            <div className="filter-label">
              Evidence group
              <Help term="Evidence group">
                <p>Functional role of a paper in the network.</p>
                <ul>
                  <li><b>Primary data</b> — papers that <i>generate</i> new clinical observations.</li>
                  <li><b>Reviews</b> — syntheses that <i>amplify</i> primary data.</li>
                  <li><b>Models</b> — animal / cell-culture <i>surrogates</i>.</li>
                  <li><b>Other</b> — everything else (methodology, commentary, case reports of related conditions).</li>
                </ul>
              </Help>
            </div>
            {palette.evidenceGroups.map((g) => (
              <label key={g.id} className="ck" title={g.label}>
                <input type="checkbox" checked={groupFilter[g.id] ?? true} onChange={() => toggleGroup(g.id)} />
                <span>{g.shortLabel}</span>
              </label>
            ))}
          </div>
        </div>
        <button className="btn-reset" onClick={reset}>reset filters</button>
      </details>
    </div>
  );
}
