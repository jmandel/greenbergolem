import { useEffect, useRef } from "react";
import { useViewer } from "./store.ts";
import { dataSource } from "./data/loader.ts";
import { GreenbergSvg } from "./spikes/svg/GreenbergSvg.tsx";
import { Sidebar } from "./panels/Sidebar.tsx";

export function App() {
  const bundle = useViewer((s) => s.bundle);
  const setBundle = useViewer((s) => s.setBundle);
  const sidebarOpen = useViewer((s) => s.sidebarOpen);
  const sidebarWidth = useViewer((s) => s.sidebarWidth);
  const toggleSidebar = useViewer((s) => s.toggleSidebar);
  const setSidebarWidth = useViewer((s) => s.setSidebarWidth);

  useEffect(() => {
    (async () => {
      const runs = await dataSource.listRuns();
      if (runs.length === 0) return;
      const b = await dataSource.loadRun(runs[0]!.id);
      setBundle(b);
    })();
  }, [setBundle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "[") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const dragState = useRef<{ startX: number; startW: number } | null>(null);
  const onDragStart = (e: React.MouseEvent) => {
    dragState.current = { startX: e.clientX, startW: sidebarWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const dx = dragState.current.startX - ev.clientX;
      setSidebarWidth(dragState.current.startW + dx);
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <>
      <header className="topbar">
        <h1>Claim Cartographer</h1>
        <span className="claim">{bundle?.claim?.canonicalClaim ?? "loading…"}</span>
        <span className="spacer" />
        <button
          className="sidebar-toggle"
          onClick={toggleSidebar}
          title={sidebarOpen ? "Hide details pane (keyboard: [ )" : "Show details pane"}
        >
          {sidebarOpen ? "›" : "‹"}
        </button>
      </header>
      <main
        className={`app-layout ${sidebarOpen ? "" : "sidebar-collapsed"}`}
        style={sidebarOpen ? ({ gridTemplateColumns: `minmax(0, 1fr) ${sidebarWidth}px` } as React.CSSProperties) : undefined}
      >
        <section className="graph-pane">
          <div className="graph-body">
            {bundle ? <GreenbergSvg /> : <p>Loading bundle…</p>}
          </div>
        </section>
        {sidebarOpen && (
          <div style={{ position: "relative" }}>
            <div
              onMouseDown={onDragStart}
              style={{
                position: "absolute",
                left: -6,
                top: 0,
                bottom: 0,
                width: 10,
                cursor: "col-resize",
                zIndex: 10,
              }}
              title="Drag to resize"
            />
            <Sidebar />
          </div>
        )}
      </main>
    </>
  );
}
