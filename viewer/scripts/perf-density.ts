// Measure the cost of dragging the density slider: each step triggers
// thinnedGraph → layout → edgesJsx/nodesJsx → React commit → paint.
// Prints per-step wall time + the main phases from Performance.getMetrics.
//
// Usage:  bun viewer/scripts/perf-density.ts [url]

import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:3000";
const executablePath = process.env.CHROME_PATH ?? "/usr/bin/chromium";

const browser = await chromium.launch({ executablePath, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");

console.log(`[density] open ${url}`);
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[data-paper]", { timeout: 60_000 });
await page.waitForTimeout(500);

const snap = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m: Record<string, number> = {};
  for (const e of metrics) m[e.name] = e.value;
  return m;
};

// Measure a single density step by setting the slider value and
// waiting for the next animation frame.
async function step(pct: number): Promise<{ wall: number; script: number; style: number; layout: number; nodes: number; edges: number }> {
  // Dispatch the input + commit THEN measure — we want the cost of
  // actually committing the density change, not of dispatching.
  const before = await snap();
  const t0 = Date.now();
  await page.evaluate(async (p) => {
    const slider = document.querySelector('.control-section input[type="range"][max="100"]') as HTMLInputElement | null;
    if (!slider) throw new Error("density slider not found");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const initialEdgeCount = document.querySelectorAll("g[data-edge-id]").length;
    setter.call(slider, String(p));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));  // bypass debounce
    // Poll until the edge-count DOM changes, then settle one more
    // frame so style/layout flushes.
    for (let i = 0; i < 400; i++) {
      if (document.querySelectorAll("g[data-edge-id]").length !== initialEdgeCount) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
  }, pct);
  const wall = Date.now() - t0;
  const after = await snap();
  const n = await page.$$eval("g[data-paper]", (es) => es.length);
  const e = await page.$$eval("g[data-edge-id]", (es) => es.length);
  const d = (k: string) => ((after[k] ?? 0) - (before[k] ?? 0)) * 1000;
  return { wall, script: d("ScriptDuration"), style: d("RecalcStyleDuration"), layout: d("LayoutDuration"), nodes: n, edges: e };
}

console.log("pct  nodes  edges   wall   script   style   layout");
for (const p of [40, 60, 80, 100, 80, 60, 40, 23, 10]) {
  const r = await step(p);
  console.log(
    `${String(p).padStart(3)}% ${String(r.nodes).padStart(6)} ${String(r.edges).padStart(6)}  ${String(r.wall).padStart(5)}ms ${r.script.toFixed(1).padStart(7)}ms ${r.style.toFixed(1).padStart(7)}ms ${r.layout.toFixed(1).padStart(7)}ms`,
  );
}

await browser.close();
