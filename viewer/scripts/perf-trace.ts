// Captures a Chrome DevTools Performance trace around a density
// slider step and dumps the top JS call stacks by self time. Lets us
// see whether React reconciliation, useMemo recomputation, or JSX
// allocation is dominating.
//
// Usage:  bun viewer/scripts/perf-trace.ts

import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

await cdp.send("Profiler.enable");
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector("[data-paper]", { timeout: 60_000 });
await page.waitForTimeout(500);

await cdp.send("Profiler.start");

const t0 = Date.now();
await page.evaluate(async () => {
  const slider = document.querySelector('.control-section input[type="range"][max="100"]') as HTMLInputElement | null;
  if (!slider) throw new Error("no density slider");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(slider, "100");
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
});
const wall = Date.now() - t0;

const { profile } = await cdp.send("Profiler.stop");
console.log(`[trace] wall: ${wall}ms   samples: ${profile.samples?.length ?? 0}`);

// Build a time-attribution: for each sample, the TOP-OF-STACK function
// gets one sample's worth of time. Walk the node tree and aggregate.
type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
const byId = new Map<number, Node>();
for (const n of profile.nodes) byId.set(n.id, n as Node);

const topSelf = new Map<string, number>();
const interval = profile.timeDeltas && profile.timeDeltas.length ? profile.timeDeltas : null;
const samples = profile.samples ?? [];
for (let i = 0; i < samples.length; i++) {
  const nodeId = samples[i]!;
  const n = byId.get(nodeId);
  if (!n) continue;
  const name = n.callFrame.functionName || "(anonymous)";
  const url = n.callFrame.url || "";
  const key = url.includes("greenbergsvg") || url.includes("GreenbergSvg")
    ? `[app] ${name}`
    : url.includes("react-dom")
    ? `[react-dom] ${name}`
    : url.includes("react")
    ? `[react] ${name}`
    : url.includes("node_modules") || url.includes("chunk")
    ? `[lib] ${name}`
    : name;
  const dt = interval ? (interval[i] ?? 1) : 1;
  topSelf.set(key, (topSelf.get(key) ?? 0) + dt);
}

const sorted = [...topSelf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
const totalUs = [...topSelf.values()].reduce((a, b) => a + b, 0) || 1;
console.log(`\ntop self-time functions (μs, % of total):\n`);
for (const [name, us] of sorted) {
  console.log(`  ${(us / 1000).toFixed(1).padStart(7)}ms  ${((us / totalUs) * 100).toFixed(1).padStart(5)}%  ${name}`);
}

await browser.close();
