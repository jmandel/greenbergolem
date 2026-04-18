// Right-hand sidebar. Three modes, all sharing a consistent header:
//
//   nothing selected  → overview (controls + metrics + glossary)
//   paper selected    → paper card + its citations (click any to
//                       navigate to that edge)
//   edge selected     → citation card with both endpoints as
//                       clickable cards + the full occurrence trail
//
// No "back" concept — every card is a forward click, and an
// always-present "Overview" link at the top deselects everything.

import { useMemo } from "react";
import { useViewer } from "../store.ts";
import { Metrics } from "./Metrics.tsx";
import { Filters } from "./Filters.tsx";
import { STANCE_COLOR, ROLE_COLOR, AUTHORITY_FILL, DIVERSION_EDGE_COLOR, type Palette } from "../lib/palette.ts";
import type { EdgeBundle, GraphNode } from "../lib/types.ts";
import { Help } from "./Help.tsx";

export function Sidebar() {
  const bundle = useViewer((s) => s.bundle);
  const selectedPaperId = useViewer((s) => s.selectedPaperId);
  const selectedEdgeId = useViewer((s) => s.selectedEdgeId);

  if (!bundle) return <div className="sidebar">Loading…</div>;

  return (
    <aside className="sidebar">
      <SidebarHeader />
      {!selectedPaperId && !selectedEdgeId && <Overview />}
      {selectedPaperId && <PaperPanel paperId={selectedPaperId} />}
      {selectedEdgeId && <EdgePanel edgeId={selectedEdgeId} />}
    </aside>
  );
}

function SidebarHeader() {
  const selectedPaperId = useViewer((s) => s.selectedPaperId);
  const selectedEdgeId = useViewer((s) => s.selectedEdgeId);
  const selectPaper = useViewer((s) => s.selectPaper);
  const selectEdge = useViewer((s) => s.selectEdge);
  const anySelection = selectedPaperId || selectedEdgeId;

  return (
    <div className="sb-header">
      <button
        type="button"
        className={`sb-crumb ${!anySelection ? "current" : ""}`}
        onClick={() => { selectPaper(null); selectEdge(null); }}
      >
        Overview
      </button>
      {selectedPaperId && (
        <>
          <span className="sb-crumb-sep">›</span>
          <span className="sb-crumb current">Paper</span>
        </>
      )}
      {selectedEdgeId && (
        <>
          <span className="sb-crumb-sep">›</span>
          <span className="sb-crumb current">Citation</span>
        </>
      )}
    </div>
  );
}

function Overview() {
  return (
    <>
      <Filters />
      <Metrics />
      <VisualKey />
      <Glossary />
      <HowToRead />
      <p className="sb-hint">
        Click a paper or citation in the graph to dig in.
      </p>
    </>
  );
}

function VisualKey() {
  const palette = useViewer((s) => s.palette);
  if (!palette) return null;
  return (
    <details className="control-section collapsible">
      <summary><span className="section-title">Visual key</span></summary>
      <div className="key-grid">
        <div className="key-label">Node fill</div>
        <div className="key-row">
          {palette.evidenceGroups.map((g) => (
            <span key={g.id} className="key-chip">
              <span className="key-dot" style={{ background: `hsl(${g.hue} ${g.baseSat}% ${g.baseLight}%)`, borderColor: "#999" }} />
              {g.shortLabel}
            </span>
          ))}
          <span className="key-chip">
            <span className="key-dot" style={{ background: AUTHORITY_FILL, borderColor: "#8a6d00" }} />
            authority
          </span>
        </div>

        <div className="key-label">Node border (stance)</div>
        <div className="key-row">
          {(Object.entries(STANCE_COLOR) as Array<[keyof typeof STANCE_COLOR, string]>).map(([k, color]) => (
            <span key={k} className="key-chip">
              <span className="key-dot" style={{ background: "#fff", borderColor: color, borderWidth: 2 }} />
              {k}
            </span>
          ))}
        </div>

        <div className="key-label">Edge (citation role)</div>
        <div className="key-row">
          {(["supportive","neutral","critical"] as const).map((k) => (
            <span key={k} className="key-chip">
              <span className="key-arrow" style={{ background: ROLE_COLOR[k] }} />
              {k}
            </span>
          ))}
          <span className="key-chip">
            <span className="key-arrow" style={{ background: DIVERSION_EDGE_COLOR }} />
            diversion
          </span>
        </div>

        <div className="key-label">Invention glyphs</div>
        <div className="key-row">
          {palette.inventionTerms.map((iv) => (
            <span key={iv.id} className="key-chip">
              <span className="key-glyph" style={{ color: iv.color }}>{iv.symbol}</span>
              {iv.label.toLowerCase().replace(/ .*$/, "")}
            </span>
          ))}
        </div>
      </div>
    </details>
  );
}

function HowToRead() {
  return (
    <details className="control-section collapsible">
      <summary><span className="section-title">How to read this</span></summary>
      <ol className="howto">
        <li>Each <b>circle</b> is a paper. Horizontal position = evidence group; vertical position = year.</li>
        <li>The circle's <b>fill color</b> tells you the group. <b>Yellow fill</b> = authority in the network.</li>
        <li>The circle's <b>border color</b> is the paper's stance on the claim.</li>
        <li>An <b>arrow</b> A → B means A cited B. Black = supportive, red-pink = critical, blue = a diversion.</li>
        <li>Hover a paper to pop its neighbors. Click to open details in this panel.</li>
      </ol>
    </details>
  );
}

function Glossary() {
  const palette = useViewer((s) => s.palette);
  const resolved = useViewer((s) => s.bundle?.resolved);
  if (!palette || !resolved) return null;
  return (
    <details className="control-section collapsible">
      <summary><span className="section-title">Glossary</span></summary>

      <h3 className="subscope">Evidence class</h3>
      <ul className="glossary-list">
        {resolved.evidenceClass.map((t) => (
          <li key={t.id}>
            <b>{t.label}</b>
            <span className="glossary-group">
              {palette.evidenceTermById.get(t.id)?.groupLabel ?? t.groupLabel ?? ""}
            </span>
            <p>{t.definition}</p>
          </li>
        ))}
      </ul>

      <h3 className="subscope">Citation inventions</h3>
      <ul className="glossary-list">
        {resolved.inventionTypes.map((t) => (
          <li key={t.id}>
            <b>
              <span style={{ color: palette.inventionTermById.get(t.id)?.color, marginRight: 4 }}>
                {palette.inventionTermById.get(t.id)?.symbol}
              </span>
              {t.label}
            </b>
            <p>{t.definition}</p>
          </li>
        ))}
      </ul>

      <h3 className="subscope">Network terms</h3>
      <ul className="glossary-list">
        <li>
          <b>Authority</b>
          <p>A paper receiving a disproportionate share of supportive citations. Yellow-filled in the figure.</p>
        </li>
        <li>
          <b>Lens effect</b>
          <p>A handful of review papers collect and focus most of the citation traffic — amplifying some findings while isolating others.</p>
        </li>
        <li>
          <b>Critique starvation</b>
          <p>Critical citations as a fraction of (supportive + critical). Low values mean the network barely engages dissent.</p>
        </li>
        <li>
          <b>Transmutation chain</b>
          <p>Sequence of citations that progressively harden a hypothesis into "fact". Trace them in Inventions view.</p>
        </li>
      </ul>
    </details>
  );
}

// ────────────────────────────────────────────────────────────
// Paper panel
// ────────────────────────────────────────────────────────────

function PaperPanel({ paperId }: { paperId: string }) {
  const bundle = useViewer((s) => s.bundle)!;
  const palette = useViewer((s) => s.palette);
  const node = useMemo(() => bundle.graph.papers.find((p) => p.paperId === paperId), [bundle, paperId]);
  const authority = useMemo(() => bundle.graph.authority.find((a) => a.paperId === paperId), [bundle, paperId]);
  const edges = useMemo(() => edgesFor(paperId, bundle.graph.edges), [bundle, paperId]);

  if (!node || !palette) return null;
  const termVis = palette.evidenceTermById.get(node.profile.evidenceClass);
  const stanceColor = STANCE_COLOR[node.profile.intrinsicStance];

  return (
    <>
      <PaperCard node={node} palette={palette} size="full" />
      <div className="chip-row">
        {termVis && (
          <span className="chip" style={{ borderColor: termVis.fill }}>
            <span className="chip-dot" style={{ background: termVis.fill, borderColor: "#888" }} />
            {termVis.groupLabel}
            <Help term="Evidence class"><p>{termVis.label}.</p><p>Group: {termVis.groupLabel}</p></Help>
          </span>
        )}
        <span className="chip" style={{ borderColor: stanceColor }}>
          <span className="chip-dot" style={{ borderColor: stanceColor, background: "transparent" }} />
          <span style={{ color: stanceColor, fontWeight: 600 }}>{node.profile.intrinsicStance}</span>
          <Help term="Intrinsic stance"><p>The paper's own position on the claim.</p></Help>
        </span>
        {authority?.isAuthority && (
          <span className="chip chip-gold">
            <span className="chip-dot" style={{ background: "#ffdc57", borderColor: "#8a6d00" }} />
            Authority
            <Help term="Authority"><p>Papers receiving a disproportionate share of supportive citations.</p></Help>
          </span>
        )}
        {node.retracted && (
          <span className="chip chip-red">
            retracted
          </span>
        )}
      </div>

      <section className="sb-section">
        <h3 className="section-title">Rationale <Help term="Rationale"><p>The paper-profile subagent's summary of what this paper actually says about the focal claim.</p></Help></h3>
        <p className="rationale">{node.profile.rationale}</p>
      </section>

      {node.profile.claimSpans.length > 0 && (
        <section className="sb-section">
          <details>
            <summary className="summary-inline">Claim spans ({node.profile.claimSpans.length})</summary>
            <ul className="spans">
              {node.profile.claimSpans.map((s, i) => (
                <li key={i}><i>({s.section ?? "?"})</i>: "{s.text}"</li>
              ))}
            </ul>
          </details>
        </section>
      )}

      <CitationList
        heading="Cites"
        help={<Help term="Outgoing citation"><p>Papers that <i>this</i> paper cites. Click any row to inspect the citation.</p></Help>}
        edges={edges.outgoing}
        palette={palette}
        perspective="out"
      />
      <CitationList
        heading="Cited by"
        help={<Help term="Incoming citation"><p>Papers that cite <i>this</i> one. Click any row to inspect that citation.</p></Help>}
        edges={edges.incoming}
        palette={palette}
        perspective="in"
      />
    </>
  );
}

// ────────────────────────────────────────────────────────────
// Edge (citation) panel
// ────────────────────────────────────────────────────────────

function EdgePanel({ edgeId }: { edgeId: string }) {
  const bundle = useViewer((s) => s.bundle)!;
  const palette = useViewer((s) => s.palette);
  const edge = useMemo(() => bundle.graph.edges.find((e) => e.edgeId === edgeId), [bundle, edgeId]);
  const citing = useMemo(() => bundle.graph.papers.find((p) => p.paperId === edge?.citingPaperId), [bundle, edge]);
  const cited = useMemo(() => bundle.graph.papers.find((p) => p.paperId === edge?.citedPaperId), [bundle, edge]);
  const judgments = useMemo(
    () => bundle.judgments.filter((j) => (edge ? edge.occurrenceIds.includes(j.occurrenceId) : false)),
    [bundle, edge],
  );
  if (!edge || !citing || !cited || !palette) return null;

  const roleClass = `role-${edge.dominantRole}`;
  const inventionVis = (edge.inventionTypes ?? []).map((id) => palette.inventionTermById.get(id)).filter(Boolean);

  return (
    <>
      <section className="sb-section">
        <h3 className="section-title">Citing</h3>
        <PaperCard node={citing} palette={palette} size="compact" clickable />
      </section>

      <div className="arrow-row">
        <span className={roleClass} style={{ fontWeight: 700, fontSize: 14 }}>
          ↓ {edge.dominantRole}
          <Help term="Dominant role"><p>Net stance of this edge when all occurrences are aggregated.</p></Help>
        </span>
        <div className="chip-row">
          {inventionVis.length > 0 && inventionVis.map((v) => (
            <span key={v!.id} className="chip" style={{ borderColor: v!.color, color: v!.color }}>
              <span style={{ fontWeight: 700 }}>{v!.symbol}</span> {v!.label}
              <Help term={v!.label}><p>See the Glossary → Citation inventions for the full definition of each type.</p></Help>
            </span>
          ))}
          {edge.mixedSignal && <span className="chip">mixed</span>}
          <span className="chip chip-mono">{edge.occurrenceIds.length} occ</span>
          <span className="chip chip-mono">conf {edge.confidence.toFixed(2)}</span>
        </div>
      </div>

      <section className="sb-section">
        <h3 className="section-title">Cited</h3>
        <PaperCard node={cited} palette={palette} size="compact" clickable />
      </section>

      <section className="sb-section">
        <h3 className="section-title">Occurrences ({judgments.length}) <Help term="Occurrence"><p>One occurrence per citation site in the citing paper's text. Each carries its own role and rationale; the edge's dominant role is their aggregate.</p></Help></h3>
        {judgments.map((j) => {
          const invLabel = j.inventionType ? palette.inventionTermById.get(j.inventionType) : undefined;
          return (
            <article key={j.occurrenceId} className="occ-card">
              <div className="occ-meta">
                <span className={`role-${j.role}`}>{j.role}</span>
                {" · "}<code>{j.section ?? "?"}</code>
                {" · conf "}{j.confidence.toFixed(2)}
                {invLabel && (
                  <> · <span style={{ color: invLabel.color, fontWeight: 600 }}>{invLabel.symbol} {invLabel.label}</span></>
                )}
                {j.needsReview && <> · <span className="tag">review</span></>}
              </div>
              {j.sentence && <blockquote className="occ-quote">"{j.sentence}"</blockquote>}
              <p className="occ-rat">{j.rationale}</p>
            </article>
          );
        })}
      </section>
    </>
  );
}

// ────────────────────────────────────────────────────────────
// Shared paper card (used inside PaperPanel + EdgePanel)
// ────────────────────────────────────────────────────────────

function PaperCard({
  node,
  palette,
  size,
  clickable = false,
}: {
  node: GraphNode;
  palette: Palette;
  size: "full" | "compact";
  clickable?: boolean;
}) {
  const selectPaper = useViewer((s) => s.selectPaper);
  const authority = useViewer((s) => s.bundle?.graph.authority.find((a) => a.paperId === node.paperId));
  const termVis = palette.evidenceTermById.get(node.profile.evidenceClass);
  const stanceColor = STANCE_COLOR[node.profile.intrinsicStance];

  const onClick = clickable ? () => selectPaper(node.paperId) : undefined;

  return (
    <article
      className={`paper-card ${size} ${clickable ? "clickable" : ""}`}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter") onClick?.(); } : undefined}
    >
      <div className="paper-card-indicator">
        <span className="paper-year">{node.year}</span>
        <span
          className="paper-dot"
          style={{
            background: authority?.isAuthority ? "#ffdc57" : termVis?.fill ?? "#d0d0d0",
            borderColor: stanceColor,
          }}
        />
      </div>
      <div className="paper-card-body">
        <div className="paper-card-title">{node.title}</div>
        <div className="paper-card-meta">
          {node.authors.slice(0, 3).join(", ")}{node.authors.length > 3 ? " et al." : ""}
          {node.venue && <> · <i>{node.venue}</i></>}
        </div>
        {size === "full" && (
          <div className="paper-card-id"><code>{node.paperId}</code></div>
        )}
      </div>
    </article>
  );
}

// ────────────────────────────────────────────────────────────
// Citation list (used twice inside PaperPanel)
// ────────────────────────────────────────────────────────────

function CitationList({
  heading,
  help,
  edges,
  palette,
  perspective,
}: {
  heading: string;
  help: React.ReactNode;
  edges: EdgeBundle[];
  palette: Palette;
  perspective: "in" | "out";
}) {
  const bundle = useViewer((s) => s.bundle)!;
  const selectEdge = useViewer((s) => s.selectEdge);

  if (edges.length === 0) {
    return (
      <section className="sb-section">
        <h3 className="section-title">{heading} (0) {help}</h3>
        <p className="muted">(none)</p>
      </section>
    );
  }

  // Sort by year so the chronology is obvious.
  const sorted = [...edges].sort((a, b) => {
    const pa = bundle.graph.papers.find((p) => p.paperId === (perspective === "out" ? a.citedPaperId : a.citingPaperId));
    const pb = bundle.graph.papers.find((p) => p.paperId === (perspective === "out" ? b.citedPaperId : b.citingPaperId));
    return (pa?.year ?? 0) - (pb?.year ?? 0);
  });

  return (
    <section className="sb-section">
      <h3 className="section-title">{heading} ({edges.length}) {help}</h3>
      <ul className="edge-list">
        {sorted.map((e) => {
          const otherId = perspective === "out" ? e.citedPaperId : e.citingPaperId;
          const other = bundle.graph.papers.find((p) => p.paperId === otherId);
          const inv = (e.inventionTypes ?? []).map((id) => palette.inventionTermById.get(id)).filter(Boolean);
          return (
            <li
              key={e.edgeId}
              className="edge-list-item"
              role="button"
              tabIndex={0}
              onClick={() => selectEdge(e.edgeId)}
              onKeyDown={(ev) => { if (ev.key === "Enter") selectEdge(e.edgeId); }}
            >
              <div className="edge-list-main">
                <span className={`role-${e.dominantRole}`} style={{ textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em" }}>
                  {e.dominantRole}
                </span>
                <span className="edge-list-arrow">{perspective === "out" ? "→" : "←"}</span>
                <span className="edge-list-title">
                  {other ? `${other.title}` : otherId}
                </span>
              </div>
              <div className="edge-list-sub">
                {other?.year ?? "?"}
                {other?.venue && <> · <i>{other.venue}</i></>}
                {inv.length > 0 && (
                  <> · {inv.map((v) => (
                    <span key={v!.id} style={{ color: v!.color, fontWeight: 600, marginLeft: 4 }}>
                      {v!.symbol} {v!.label}
                    </span>
                  ))}</>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function edgesFor(paperId: string, edges: EdgeBundle[]): { incoming: EdgeBundle[]; outgoing: EdgeBundle[] } {
  const outgoing = edges.filter((e) => e.citingPaperId === paperId);
  const incoming = edges.filter((e) => e.citedPaperId === paperId);
  return { incoming, outgoing };
}
