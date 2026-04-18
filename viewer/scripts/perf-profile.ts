// CDP-based perf probe. Opens the viewer, waits for the graph to
// render, then fires a burst of in-page pointer events (NOT via
// playwright.mouse.move, which round-trips per call) and captures
// deltas via Performance.getMetrics. Prints JS vs layout vs paint
// time spent during the burst.
//
// Usage:  bun viewer/scripts/perf-profile.ts [url]

import { chromium } from "playwright-core";

async function main() {
  const url = process.argv[2] ?? "http://localhost:3001";
  const executablePath = process.env.CHROME_PATH ?? "/usr/bin/chromium";

  console.log(`[perf] launching chromium at ${executablePath}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");

  console.log(`[perf] open ${url}`);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-paper]", { timeout: 10_000 });
  const counts = await page.evaluate(() => ({
    nodes: document.querySelectorAll("[data-paper]").length,
    edges: document.querySelectorAll("[data-edge-id]").length,
  }));
  console.log(`[perf] rendered: ${counts.nodes} nodes, ${counts.edges} edges`);

  // Warm up — let any init idle tasks finish.
  await page.waitForTimeout(500);

  // Before snapshot.
  const mBefore = snapshot((await cdp.send("Performance.getMetrics")).metrics);

  // In-page hover burst. Dispatches N synthetic pointermove events on
  // all [data-paper] and [data-edge-id] elements. This exercises the
  // CSS-hover overlay path the same way user pointer movement would.
  const burst = await page.evaluate(async () => {
    const N = 600;
    const nodes = Array.from(document.querySelectorAll("[data-paper]")) as HTMLElement[];
    const edges = Array.from(document.querySelectorAll("[data-edge-id]")) as HTMLElement[];
    const targets = [...nodes, ...edges];
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const t = targets[i % targets.length]!;
      const r = t.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      t.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
      // Yield to the event loop so rAF can fire + React can flush.
      if ((i & 7) === 7) await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    // Settle
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    return { n: N, wallMs: performance.now() - t0, targets: targets.length };
  });

  const mAfter = snapshot((await cdp.send("Performance.getMetrics")).metrics);

  const dScriptDuration = mAfter.ScriptDuration - mBefore.ScriptDuration;
  const dLayoutDuration = mAfter.LayoutDuration - mBefore.LayoutDuration;
  const dRecalcStyleDuration = mAfter.RecalcStyleDuration - mBefore.RecalcStyleDuration;
  const dTaskDuration = mAfter.TaskDuration - mBefore.TaskDuration;
  const dLayoutCount = mAfter.LayoutCount - mBefore.LayoutCount;
  const dRecalcStyleCount = mAfter.RecalcStyleCount - mBefore.RecalcStyleCount;

  console.log(`[perf] pointermove burst: n=${burst.n} over ${burst.wallMs.toFixed(0)}ms wall (targets=${burst.targets})`);
  console.log(`[perf] per-event budget: ${(burst.wallMs / burst.n).toFixed(2)}ms/event`);
  console.log(`[perf] CDP metrics Δ during burst:`);
  console.log(`         Script:      ${ms(dScriptDuration)}   (${per(dScriptDuration, burst.n)} /event)`);
  console.log(`         RecalcStyle: ${ms(dRecalcStyleDuration)}   (${dRecalcStyleCount} recalcs, ${per(dRecalcStyleDuration, burst.n)} /event)`);
  console.log(`         Layout:      ${ms(dLayoutDuration)}   (${dLayoutCount} layouts, ${per(dLayoutDuration, burst.n)} /event)`);
  console.log(`         TotalTask:   ${ms(dTaskDuration)}`);

  await browser.close();
}

function snapshot(metrics: Array<{ name: string; value: number }>) {
  const m: Record<string, number> = {};
  for (const e of metrics) m[e.name] = e.value;
  return m as any;
}

function ms(seconds: number): string {
  return `${(seconds * 1000).toFixed(1)}ms`;
}
function per(sec: number, n: number): string {
  return `${((sec * 1000) / Math.max(1, n)).toFixed(3)}ms`;
}

main().catch((e) => { console.error(e); process.exit(1); });
