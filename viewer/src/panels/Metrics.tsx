// Compact metrics panel. Shows the four headline numbers up top, and
// hides the full analyses dictionary behind a collapsed details block.

import { useViewer } from "../store.ts";
import { Help } from "./Help.tsx";

export function Metrics() {
  const graph = useViewer((s) => s.bundle?.graph);
  if (!graph) return null;
  const analyses = Object.values(graph.analyses ?? {});
  const totals = graph.edgeTotals;
  const authorityCount = graph.authority.filter((a) => a.isAuthority).length;

  // Promote two analyses to the headline block when available.
  const critStarve = analyses.find((a) => a.template === "role-ratio-complement");
  const top5 = analyses.find((a) => a.template === "supportive-in-degree-concentration");
  const totalSupCrit = totals.supportive + totals.critical;

  const global = analyses.filter((a) => !a.scope);
  const scoped = new Map<string, typeof analyses>();
  for (const a of analyses) {
    if (!a.scope) continue;
    if (!scoped.has(a.scope)) scoped.set(a.scope, []);
    scoped.get(a.scope)!.push(a);
  }

  return (
    <div className="control-section">
      <div className="section-head">
        <span className="section-title">Graph</span>
      </div>

      <div className="headline-grid">
        <HeadlineFig label="papers" value={graph.papers.length} />
        <HeadlineFig label="citations" value={graph.edges.length} />
        <HeadlineFig
          label="authorities"
          value={authorityCount}
          help={
            <Help term="Authority">
              <p>Papers that receive a disproportionate share of supportive citations.</p>
              <p>Defined computationally (Kleinberg hub-and-authority; we use supportive in-degree as a proxy).</p>
              <p>Shown as <b style={{ color: "#b58a00" }}>yellow-filled</b> nodes.</p>
              <em>Greenberg 2009 used authority status to reveal which papers had come to carry the belief system — in IBM amyloid, 9 of the 10 top authorities supported the claim.</em>
            </Help>
          }
        />
        <HeadlineFig
          label="critique starv."
          value={critStarve?.value != null ? `${(critStarve.value * 100).toFixed(1)}%` : "—"}
          help={
            <Help term="Critique starvation">
              <p>Critical citations as a fraction of (supportive + critical) — the lower the number, the less the network engages dissent.</p>
              <p>Denominator: {totalSupCrit} supportive+critical edges.</p>
              <em>Greenberg reported ~3% in the IBM amyloid network: contradictory findings existed but were barely cited.</em>
            </Help>
          }
        />
      </div>

      {top5 && top5.value != null && (
        <p className="headline-caption">
          Top 5 papers hold <b>{(top5.value * 100).toFixed(0)}%</b> of supportive citations{" "}
          <Help term="Lens effect">
            <p>When a few papers collect most of the citation traffic, those papers act as a magnifying lens — routing supportive evidence forward while isolating critical findings.</p>
            <p>Greenberg: "63% of all citation paths flow through one review paper."</p>
          </Help>
        </p>
      )}

      <details className="collapsible">
        <summary>
          <span className="section-title">All analyses</span>
          <span className="pill">{global.length + [...scoped.values()].reduce((n, a) => n + a.length, 0)}</span>
        </summary>
        {global.length > 0 && (
          <div className="metric-grid">
            {global.map((a) => (
              <span key={a.id} style={{ display: "contents" }}>
                <span title={a.id}>{a.label}</span>
                <Val v={a.value} />
              </span>
            ))}
          </div>
        )}
        {[...scoped.entries()].map(([sid, arr]) => (
          <div key={sid}>
            <h3 className="subscope">scope: <code>{sid}</code></h3>
            <div className="metric-grid">
              {arr.map((a) => (
                <span key={a.id} style={{ display: "contents" }}>
                  <span title={a.id}>{a.label}</span>
                  <Val v={a.value} />
                </span>
              ))}
            </div>
          </div>
        ))}
        <p className="metric-note">Ratios read "N/A" when the denominator is too sparse to be meaningful.</p>
      </details>
    </div>
  );
}

function HeadlineFig({
  label,
  value,
  help,
}: {
  label: string;
  value: number | string;
  help?: React.ReactNode;
}) {
  return (
    <div className="headline-fig">
      <div className="headline-val">{value}</div>
      <div className="headline-label">
        {label}
        {help}
      </div>
    </div>
  );
}

function Val({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <b className="na">N/A</b>;
  return <b>{v.toFixed(2)}</b>;
}
