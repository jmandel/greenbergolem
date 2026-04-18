import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { useViewer } from "./store.ts";

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(<App />);

// Expose the store on window so headless test harnesses can set selection /
// hover / mode programmatically without synthesizing DOM events.
(window as unknown as { __viewer__: unknown }).__viewer__ = useViewer;
