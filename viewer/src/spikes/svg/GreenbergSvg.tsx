// The main citation-network figure. Year × evidence-class layout with
// per-viewMode positional emphasis:
//
//   "default"         — one column per evidence-class group.
//   "stance-split"    — within each group, sub-split by intrinsic stance
//                       (supportive / critical / mixed / unclear) so
//                       critique-starvation asymmetry is visible
//                       positionally (Greenberg 2009 style).
//   "lens"            — amplifier-group nodes foregrounded; their
//                       incoming supportive edges drawn bold, the
//                       rest dimmed. Makes the lens effect visible.
//   "invention-audit" — edges without an inventionType dimmed; edges
//                       with an invention flag drawn bold with the
//                       type's glyph badge near the cited endpoint.
//                       Node selection in this mode highlights the
//                       full multi-hop invention chain upstream and
//                       downstream (transmutation tracing).
//
// Node fill = evidence class (taxonomy-driven). Border = stance
// (supportive/critical/mixed/unclear; fixed enum). Halo = authority.
// Edge color = dominant role (fixed enum). Callout boxes appear on
// hovered or selected invention edges.

import { useEffect, useMemo, useRef, useState } from "react";
import { useViewer } from "../../store.ts";
import { paperLayout, fitLayoutOpts, type LayoutMode } from "../../lib/layout.ts";
import { STANCE_COLOR, ROLE_COLOR, AUTHORITY_FILL, DIVERSION_EDGE_COLOR } from "../../lib/palette.ts";
import type { Palette } from "../../lib/palette.ts";
import type { OccurrenceRole, EdgeBundle } from "../../lib/types.ts";

export function GreenbergSvg() {
  const bundle = useViewer((s) => s.bundle);
  const palette = useViewer((s) => s.palette);
  const viewMode = useViewer((s) => s.viewMode);
  const roleFilter = useViewer((s) => s.roleFilter);
  const stanceFilter = useViewer((s) => s.stanceFilter);
  const groupFilter = useViewer((s) => s.groupFilter);
  const yearRange = useViewer((s) => s.yearRange);
  const selectedPaperId = useViewer((s) => s.selectedPaperId);
  const selectedEdgeId = useViewer((s) => s.selectedEdgeId);
  const selectPaper = useViewer((s) => s.selectPaper);
  const selectEdge = useViewer((s) => s.selectEdge);
  // NOTE: we deliberately do NOT subscribe to hoverPaperId here. On a
  // 682-edge network, re-running the filter/emphasis pipeline for every
  // pointermove was the biggest perf cliff.

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  // Hover state kept LOCAL, not in zustand. Only the <style>-tag subtree
  // re-renders on hover; the 900-element graph stays stable.
  const [hoverPaperId, setHoverPaperIdLocal] = useState<string | null>(null);
  const [hoverEdgeId, setHoverEdgeIdLocal] = useState<string | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<{ p: string | null; e: string | null }>({ p: null, e: null });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Debounce resize updates — ResizeObserver can fire in tight bursts
    // (especially during window drags) and each update re-runs the
    // whole layout pipeline.
    let pending: number | null = null;
    const ro = new ResizeObserver(() => {
      if (pending !== null) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        setContainerSize({ w: el.clientWidth, h: el.clientHeight });
        pending = null;
      });
    });
    ro.observe(el);
    setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    return () => { ro.disconnect(); if (pending !== null) cancelAnimationFrame(pending); };
  }, []);

  const years = bundle?.graph.papers.map((p) => p.year) ?? [];
  const yearCount = years.length ? Math.max(1, Math.max(...years) - Math.min(...years) + 1) : 1;
  const opts = fitLayoutOpts(yearCount, containerSize.w, containerSize.h);
  const layoutMode: LayoutMode =
    viewMode === "stance-split" ? "stance-split" : "greenberg";

  const layout = useMemo(
    () => (bundle && palette ? paperLayout(bundle.graph, palette, layoutMode, opts) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundle, palette, layoutMode, opts.width, opts.heightPerYear, opts.nodeRadius],
  );
  const authByPaper = useMemo(
    () => new Map((bundle?.graph.authority ?? []).map((a) => [a.paperId, a])),
    [bundle],
  );

  // Lens-mode: compute the top-k amplifier-group nodes by supportive
  // in-degree. These get bold halos and their incoming supportive
  // edges drawn thick; everything else dimmed.
  const lensFocus = useMemo(() => {
    if (!bundle || !palette) return new Set<string>();
    if (viewMode !== "lens") return new Set<string>();
    const amplifierTermIds = new Set<string>();
    for (const t of palette.evidenceTerms) if (t.groupId === "amplifier") amplifierTermIds.add(t.id);
    const supIn = new Map<string, number>();
    for (const e of bundle.graph.edges) {
      if (e.dominantRole !== "supportive") continue;
      const cited = bundle.graph.papers.find((p) => p.paperId === e.citedPaperId);
      if (!cited || !amplifierTermIds.has(cited.profile.evidenceClass)) continue;
      supIn.set(e.citedPaperId, (supIn.get(e.citedPaperId) ?? 0) + 1);
    }
    const topK = [...supIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return new Set(topK.map(([id]) => id));
  }, [bundle, palette, viewMode]);

  const connected = useMemo(() => {
    if (!bundle) return new Set<string>();
    const focus = selectedPaperId;
    if (!focus) return new Set<string>();
    const s = new Set<string>([focus]);
    for (const e of bundle.graph.edges) {
      if (e.citingPaperId === focus) s.add(e.citedPaperId);
      if (e.citedPaperId === focus) s.add(e.citingPaperId);
    }
    return s;
  }, [bundle, selectedPaperId]);

  // Per-paper "self + neighbors" token string for the CSS hover
  // overlay. This is computed once per bundle and lets us drive hover
  // dimming via CSS selectors (e.g. `[data-neighbors~="paperX"]`)
  // instead of re-rendering 900 React elements on every pointermove.
  const neighborStrById = useMemo(() => {
    const out = new Map<string, string>();
    if (!bundle) return out;
    const m = new Map<string, Set<string>>();
    for (const p of bundle.graph.papers) m.set(p.paperId, new Set([p.paperId]));
    for (const e of bundle.graph.edges) {
      m.get(e.citingPaperId)?.add(e.citedPaperId);
      m.get(e.citedPaperId)?.add(e.citingPaperId);
    }
    for (const [k, v] of m) out.set(k, [...v].join(" "));
    return out;
  }, [bundle]);

  // Single pointermove handler on the SVG root. Finds the nearest
  // element with a data-paper or data-edge-id ancestor and rAF-throttles
  // the React state update. Skips when nothing changed.
  const onPointerMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const t = ev.target as Element | null;
    if (!t || !t.closest) return;
    const nodeG = t.closest("[data-paper]") as Element | null;
    const edgeG = t.closest("[data-edge-id]") as Element | null;
    const p = nodeG?.getAttribute("data-paper") ?? null;
    const e = edgeG?.getAttribute("data-edge-id") ?? null;
    if (pendingHoverRef.current.p === p && pendingHoverRef.current.e === e) return;
    pendingHoverRef.current = { p, e };
    if (hoverRafRef.current != null) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = null;
      const cur = pendingHoverRef.current;
      setHoverPaperIdLocal(cur.p);
      setHoverEdgeIdLocal(cur.e);
    });
  };
  const onPointerLeave = () => {
    pendingHoverRef.current = { p: null, e: null };
    if (hoverRafRef.current != null) {
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }
    setHoverPaperIdLocal(null);
    setHoverEdgeIdLocal(null);
  };

  // Invention-chain tracing: BFS upstream and downstream from the
  // selected paper through invention-flagged edges only. Collects both
  // the traversed edge ids and the papers they touch. Used in
  // invention-audit mode to make transmutation chains visible.
  const inventionChain = useMemo(() => {
    const empty = { edges: new Set<string>(), papers: new Set<string>() };
    if (!bundle) return empty;
    const focus = selectedPaperId;
    if (!focus || viewMode !== "invention-audit") return empty;
    const byCiting = new Map<string, EdgeBundle[]>();
    const byCited = new Map<string, EdgeBundle[]>();
    for (const e of bundle.graph.edges) {
      if (!e.inventionTypes || e.inventionTypes.length === 0) continue;
      if (!byCiting.has(e.citingPaperId)) byCiting.set(e.citingPaperId, []);
      byCiting.get(e.citingPaperId)!.push(e);
      if (!byCited.has(e.citedPaperId)) byCited.set(e.citedPaperId, []);
      byCited.get(e.citedPaperId)!.push(e);
    }
    const edges = new Set<string>();
    const papers = new Set<string>([focus]);
    // Downstream (cited → citing): edges pointing AT the focus paper
    // from others are upstream in the chain (something cited our
    // paper). We trace both directions to capture the full chain.
    const stack = [focus];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of byCited.get(cur) ?? []) {
        if (edges.has(e.edgeId)) continue;
        edges.add(e.edgeId);
        if (!papers.has(e.citingPaperId)) { papers.add(e.citingPaperId); stack.push(e.citingPaperId); }
      }
      for (const e of byCiting.get(cur) ?? []) {
        if (edges.has(e.edgeId)) continue;
        edges.add(e.edgeId);
        if (!papers.has(e.citedPaperId)) { papers.add(e.citedPaperId); stack.push(e.citedPaperId); }
      }
    }
    return { edges, papers };
  }, [bundle, selectedPaperId, viewMode]);

  if (!bundle || !palette || !layout) return <div ref={containerRef} style={{ width: "100%", height: "100%" }}>Loading…</div>;

  const { positions, byId, width, height, chartTop, chartBottom, chartLeft, chartRight, yearMin, yearMax, columns } = layout;

  const visibleNode = (paperId: string) => {
    const p = byId.get(paperId);
    if (!p) return false;
    if (!groupFilter[p.groupId]) return false;
    if (!stanceFilter[p.stance]) return false;
    if (yearRange && (p.year < yearRange[0] || p.year > yearRange[1])) return false;
    return true;
  };

  const visibleEdge = (e: EdgeBundle) => {
    if (!roleFilter[e.dominantRole]) return false;
    if (!visibleNode(e.citingPaperId) || !visibleNode(e.citedPaperId)) return false;
    if (viewMode === "invention-audit" && (!e.inventionTypes || e.inventionTypes.length === 0)) return false;
    if (viewMode === "lens") {
      if (e.dominantRole !== "supportive") return false;
      if (!lensFocus.has(e.citedPaperId)) return false;
    }
    return true;
  };

  const visibleEdges = useMemo(
    () => bundle.graph.edges.filter(visibleEdge),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundle, roleFilter, groupFilter, stanceFilter, yearRange, viewMode, lensFocus, byId],
  );
  const visiblePositions = useMemo(
    () => positions.filter((p) => visibleNode(p.paperId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positions, groupFilter, stanceFilter, yearRange],
  );

  const focus = selectedPaperId;
  const edgeEmphasis = (e: EdgeBundle): { stroke: number; opacity: number; bigArrow: boolean } => {
    const isSelected = e.edgeId === selectedEdgeId;
    const isFocused = focus && (e.citingPaperId === focus || e.citedPaperId === focus);
    const inChain = viewMode === "invention-audit" && inventionChain.edges.has(e.edgeId);
    const invention = (e.inventionTypes?.length ?? 0) > 0;
    let base = e.mixedSignal ? 2 : 1.1;
    let opacity = focus ? (isFocused ? 0.9 : 0.05) : 0.28;
    if (isSelected) { base = 3; opacity = 1; }
    if (viewMode === "invention-audit" && invention) { base = Math.max(base, 2); opacity = Math.max(opacity, 0.7); }
    if (inChain) { base = Math.max(base, 2.6); opacity = 0.95; }
    if (viewMode === "lens" && lensFocus.has(e.citedPaperId)) { base = Math.max(base, 2.2); opacity = 0.85; }
    return { stroke: base, opacity, bigArrow: isSelected || !!isFocused || inChain };
  };

  const nodeOpacity = (paperId: string) => {
    if (viewMode === "lens") return lensFocus.has(paperId) ? 1 : focus && connected.has(paperId) ? 0.9 : 0.35;
    if (viewMode === "invention-audit" && selectedPaperId && inventionChain.papers.size > 0) {
      return inventionChain.papers.has(paperId) ? 1 : 0.2;
    }
    return !focus || connected.has(paperId) ? 1 : 0.25;
  };

  const heightPerYear = (chartBottom - chartTop) / Math.max(1, yearMax - yearMin + 1);

  // Callout: shown for hovered-or-selected invention edge. The React
  // state update on hover is cheap because the graph body is stable
  // (useMemo'd) and only the callout subtree + the <style> tag
  // re-render.
  const calloutEdge = (() => {
    const id = hoverEdgeId ?? selectedEdgeId;
    if (!id) return null;
    const e = bundle.graph.edges.find((x) => x.edgeId === id);
    if (!e || !e.inventionTypes || e.inventionTypes.length === 0) return null;
    return e;
  })();

  // Graph-body JSX is memoized so hover state changes don't re-execute
  // 900 .map() iterations or re-construct vDOM. Only the <style> tag
  // (inside the return below) and the callout subtree update on hover.
  const edgesJsx = useMemo(() => (
    visibleEdges.map((e) => {
      const a = byId.get(e.citingPaperId);
      const b = byId.get(e.citedPaperId);
      if (!a || !b) return null;
      const isDiversion = (e.inventionTypes ?? []).includes("diversion");
      const color = isDiversion ? DIVERSION_EDGE_COLOR : ROLE_COLOR[e.dominantRole];
      // Shrink endpoints to each node's circumference so the arrow
      // sits visibly on the cited node's edge instead of being buried
      // in the fill.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / len;
      const uy = dy / len;
      const aOff = a.r + 1.5;
      const bOff = b.r + 1.5;
      const ax = a.x + ux * aOff;
      const ay = a.y + uy * aOff;
      const bx = b.x - ux * bOff;
      const by = b.y - uy * bOff;
      const cx = (ax + bx) / 2 + (by - ay) * 0.06;
      const cy = (ay + by) / 2 - (bx - ax) * 0.06;
      const em = edgeEmphasis(e);
      const d = `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`;
      const inv = (e.inventionTypes ?? []).map((id) => palette.inventionTermById.get(id)).filter(Boolean);
      const markerKey = isDiversion ? "diversion" : e.dominantRole;
      return (
        <g
          key={e.edgeId}
          data-edge-id={e.edgeId}
          data-edge-endpoints={`${e.citingPaperId} ${e.citedPaperId}`}
        >
          <path
            d={d}
            fill="none"
            stroke="transparent"
            strokeWidth={10}
            style={{ cursor: "pointer" }}
            onClick={(ev) => { ev.stopPropagation(); selectEdge(e.edgeId); }}
          />
          <path d={d} fill="none" stroke={color} strokeWidth={em.stroke} opacity={em.opacity} markerEnd={`url(#arrow-${markerKey}${em.bigArrow ? "-big" : ""})`} pointerEvents="none" />
          {inv.length > 0 && em.opacity > 0.25 && (
            inv.map((t, i) => (
              <text key={`${e.edgeId}-inv-${t!.id}`} x={b.x + 6 + i * 10} y={b.y - 10} fontSize={11} fontWeight={700} fill={t!.color} pointerEvents="none">
                {t!.symbol}
              </text>
            ))
          )}
        </g>
      );
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [visibleEdges, byId, palette, selectedEdgeId, selectedPaperId, viewMode, inventionChain, lensFocus]);

  const nodesJsx = useMemo(() => (
    visiblePositions.map((p) => {
      const auth = authByPaper.get(p.paperId);
      const termVis = palette.evidenceTermById.get(p.node.profile.evidenceClass);
      const paletteFill = termVis?.fill ?? "#d0d0d0";
      const isAuthority = !!auth?.isAuthority;
      const fill = isAuthority ? AUTHORITY_FILL : paletteFill;
      const stance = p.node.profile.intrinsicStance;
      const stanceStroke = STANCE_COLOR[stance];
      const isSelected = p.paperId === selectedPaperId;
      const isLens = viewMode === "lens" && lensFocus.has(p.paperId);
      const isChainEnd = viewMode === "invention-audit" && inventionChain.papers.has(p.paperId) && p.paperId === selectedPaperId;
      return (
        <g
          key={p.paperId}
          data-paper={p.paperId}
          data-neighbors={neighborStrById.get(p.paperId)}
          opacity={nodeOpacity(p.paperId)}
          style={{ cursor: "pointer" }}
          onClick={(ev) => { ev.stopPropagation(); selectPaper(p.paperId); }}
        >
          {(isLens || isChainEnd) && (
            <circle cx={p.x} cy={p.y} r={p.r + 6} fill="none" stroke={isLens ? "#b58a00" : "#7a1fa2"} strokeWidth={2.2} opacity={0.9} />
          )}
          {p.node.retracted && (
            <circle cx={p.x} cy={p.y} r={p.r + 2} fill="none" stroke="#b33a3a" strokeWidth={1.5} strokeDasharray="2 2" />
          )}
          <circle
            cx={p.x}
            cy={p.y}
            r={p.r + (isSelected ? 2 : 0)}
            fill={fill}
            stroke={isAuthority ? "#8a6d00" : stanceStroke}
            strokeWidth={isAuthority ? 1.5 : stance === "unclear" ? 1 : isSelected ? 3 : 2}
            data-term={p.node.profile.evidenceClass}
            data-group={p.groupId}
            data-stance={stance}
            data-year={p.year}
            data-authority={isAuthority ? "1" : "0"}
          />
          {isAuthority && stance !== "unclear" && (
            <circle cx={p.x} cy={p.y} r={Math.max(2, p.r - 3)} fill="none" stroke={stanceStroke} strokeWidth={1.4} />
          )}
          {p.r >= 8 && (
            <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize={p.r >= 10 ? 10 : 8} fontWeight={600} fill="#222" pointerEvents="none">
              {p.displayNumber}
            </text>
          )}
        </g>
      );
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [visiblePositions, authByPaper, palette, selectedPaperId, viewMode, inventionChain, lensFocus, neighborStrById]);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: "block", width: "100%", height: "100%", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", fontSize: 12 }}
        onClick={() => { selectPaper(null); selectEdge(null); }}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        {/* Hover overlay: a single <style> tag drives the dimming via
            CSS selectors on data-* attributes. Keeps hover-on-a-hub
            nearly free — no React reconciliation of the graph body. */}
        {(hoverPaperId || hoverEdgeId) && (
          <style>{buildHoverStyles(hoverPaperId, hoverEdgeId)}</style>
        )}
        <rect width={width} height={height} fill="#fafafa" />

        {/* Year gridlines */}
        {Array.from({ length: yearMax - yearMin + 1 }, (_, i) => yearMin + i).map((yr) => {
          const yy = chartTop + (yearMax - yr) * heightPerYear + heightPerYear / 2;
          return (
            <g key={yr}>
              <line x1={chartLeft} y1={yy} x2={chartRight} y2={yy} stroke="#eee" />
              <text x={chartLeft - 12} y={yy + 4} textAnchor="end" fill="#555" style={{ fontVariantNumeric: "tabular-nums" }}>
                {yr}
              </text>
            </g>
          );
        })}

        {/* Column headers: group band + optional sub-stance label */}
        <ColumnHeaders palette={palette} columns={columns} chartTop={chartTop} chartBottom={chartBottom} />

        {/* Arrow markers per role (small / big) + a dedicated diversion
            marker. Citation direction is citing → cited; the head sits
            at the cited endpoint. */}
        <defs>
          {(Object.keys(ROLE_COLOR) as OccurrenceRole[]).flatMap((role) => [
            <marker key={`s-${role}`} id={`arrow-${role}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={9} markerHeight={9} orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={ROLE_COLOR[role]} />
            </marker>,
            <marker key={`b-${role}`} id={`arrow-${role}-big`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={13} markerHeight={13} orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={ROLE_COLOR[role]} />
            </marker>,
          ])}
          <marker id="arrow-diversion" viewBox="0 0 10 10" refX="9" refY="5" markerWidth={9} markerHeight={9} orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={DIVERSION_EDGE_COLOR} />
          </marker>
          <marker id="arrow-diversion-big" viewBox="0 0 10 10" refX="9" refY="5" markerWidth={13} markerHeight={13} orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={DIVERSION_EDGE_COLOR} />
          </marker>
        </defs>

        {/* Edges (memoized) */}
        {edgesJsx}

        {/* Nodes (memoized). Authority papers are FILLED yellow
            (Greenberg's convention). Lens/chain focus uses auxiliary
            halo colors; retracted papers wear a red dashed ring. */}
        {nodesJsx}

        {/* Invention callout — floats near the focused edge with a
            short "X → Y: <invention> — <rationale>" annotation. */}
        {calloutEdge && (() => {
          const a = byId.get(calloutEdge.citingPaperId);
          const b = byId.get(calloutEdge.citedPaperId);
          if (!a || !b) return null;
          const invLabels = (calloutEdge.inventionTypes ?? [])
            .map((id) => palette.inventionTermById.get(id))
            .filter(Boolean)
            .map((t) => `${t!.symbol} ${t!.label}`)
            .join("  ·  ");
          const judg = bundle.judgments.find((j) => calloutEdge.occurrenceIds.includes(j.occurrenceId));
          const rat = (judg?.rationale ?? "").slice(0, 160);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const W = 280;
          const H = 74;
          const cx = Math.min(Math.max(mx, chartLeft + W / 2 + 4), chartRight - W / 2 - 4);
          const cy = Math.min(Math.max(my - 50, chartTop + H / 2 + 4), chartBottom - H / 2 - 4);
          return (
            <g pointerEvents="none">
              <line x1={mx} y1={my} x2={cx} y2={cy} stroke="#777" strokeDasharray="3 3" />
              <rect x={cx - W / 2} y={cy - H / 2} width={W} height={H} rx={6} fill="#fffbe5" stroke="#b58a00" strokeWidth={1} opacity={0.97} />
              <text x={cx - W / 2 + 10} y={cy - H / 2 + 18} fontSize={11} fontWeight={700} fill="#5a3a00">
                {invLabels || "(no invention)"}
              </text>
              {wrapLines(rat, 44).slice(0, 3).map((line, i) => (
                <text key={i} x={cx - W / 2 + 10} y={cy - H / 2 + 34 + i * 12} fontSize={10.5} fill="#333">
                  {line}
                </text>
              ))}
            </g>
          );
        })()}

      </svg>
    </div>
  );
}

// Emits the CSS rules that dim/emphasize nodes and edges based on the
// currently hovered paper or edge id. Rendered as a <style> child of
// the SVG so updates cost exactly one text node swap — no React
// reconciliation of the 900-element graph body.
function buildHoverStyles(paperId: string | null, edgeId: string | null): string {
  const rules: string[] = [];
  // Safe fallback if CSS.escape isn't available (SSR / old env).
  const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));
  if (paperId) {
    const p = esc(paperId);
    // Dim everything not neighboring the hovered paper.
    rules.push(`[data-paper]:not([data-neighbors~="${p}"]) { opacity: 0.15; }`);
    rules.push(`[data-edge-endpoints]:not([data-edge-endpoints~="${p}"]) { opacity: 0.05; }`);
    rules.push(`[data-edge-endpoints][data-edge-endpoints~="${p}"] { opacity: 1; }`);
    // Halo the hovered paper itself.
    rules.push(`[data-paper="${p}"] > circle:last-of-type { stroke-width: 3; }`);
  }
  if (edgeId) {
    const e = esc(edgeId);
    rules.push(`[data-edge-id]:not([data-edge-id="${e}"]) { opacity: 0.15; }`);
    rules.push(`[data-edge-id="${e}"] { opacity: 1; }`);
    rules.push(`[data-edge-id="${e}"] path:last-of-type { stroke-width: 3.5; }`);
  }
  return rules.join("\n");
}

function wrapLines(s: string, maxChars: number): string[] {
  if (!s) return [];
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function ColumnHeaders({
  palette,
  columns,
  chartTop,
  chartBottom,
}: {
  palette: Palette;
  columns: Array<{ id: string; label: string; subLabel?: string; x: number; width: number; groupId: string }>;
  chartTop: number;
  chartBottom: number;
}) {
  // Group header band: colored strip spanning all sub-columns of the
  // same group. Below it, optional sub-column labels (for stance-split).
  const groupSpans = new Map<string, { x0: number; x1: number; label: string; hue: number }>();
  for (const c of columns) {
    const g = palette.evidenceGroups.find((gg) => gg.id === c.groupId);
    const hue = g?.hue ?? 0;
    const span = groupSpans.get(c.groupId);
    if (!span) {
      groupSpans.set(c.groupId, { x0: c.x - c.width / 2, x1: c.x + c.width / 2, label: g?.shortLabel ?? g?.label ?? c.groupId, hue });
    } else {
      span.x0 = Math.min(span.x0, c.x - c.width / 2);
      span.x1 = Math.max(span.x1, c.x + c.width / 2);
    }
  }

  return (
    <>
      {/* Group header strip. Short labels so they fit inside their
          column band even when "Other" gets 50% of the width. */}
      {[...groupSpans.entries()].map(([gid, span]) => {
        const spanW = span.x1 - span.x0;
        return (
          <g key={`gh-${gid}`}>
            <rect x={span.x0} y={chartTop - 36} width={spanW} height={18} fill={`hsl(${span.hue} 40% 90%)`} stroke="#bbb" />
            <text x={(span.x0 + span.x1) / 2} y={chartTop - 23} textAnchor="middle" fontWeight={700} fill="#222" fontSize={spanW < 80 ? 10 : 12}>
              {span.label}
            </text>
          </g>
        );
      })}
      {/* Sub-column labels (stance in stance-split mode, else none) */}
      {columns.map((c) => (
        c.subLabel ? (
          <g key={`ch-${c.id}`}>
            <text x={c.x} y={chartTop - 5} textAnchor="middle" fontSize={11} fontStyle="italic" fill={STANCE_COLOR[c.subLabel as keyof typeof STANCE_COLOR] ?? "#555"}>
              {c.subLabel}
            </text>
          </g>
        ) : null
      ))}
      {/* Vertical column dividers */}
      {columns.map((c, i) => (
        i > 0 ? (
          <line key={`cd-${c.id}`} x1={c.x - c.width / 2} y1={chartTop} x2={c.x - c.width / 2} y2={chartBottom} stroke="#ddd" strokeDasharray="2 4" />
        ) : null
      ))}
    </>
  );
}

