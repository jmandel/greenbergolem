// Headless chromium harness for the viewer. Starts the bun dev server on an
// ephemeral port, points chromium at it, waits for layout, captures a PNG,
// and optionally dumps layout stats (node positions, visible-bounds, console
// logs, network errors). Use this to iterate on visual regressions.
//
// Usage:
//   bun viewer/scripts/debug.ts                     # default — screenshot
//   bun viewer/scripts/debug.ts --mode svg          # SVG view only
//   bun viewer/scripts/debug.ts --mode canvas       # Canvas view
//   bun viewer/scripts/debug.ts --stats             # also print layout stats
//   bun viewer/scripts/debug.ts --port 5556         # override port

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mode: { type: "string", default: "svg" },          // svg | canvas | both
      port: { type: "string", default: "5563" },
      out: { type: "string", default: "viewer/debug" },
      stats: { type: "boolean", default: false },
      "viewport-w": { type: "string", default: "1600" },
      "viewport-h": { type: "string", default: "1000" },
      hover: { type: "string" },                         // paper id to hover
      select: { type: "string" },                        // paper id to click
    },
  });

  const port = Number(values.port);
  const outDir = values.out!;
  await mkdir(outDir, { recursive: true });

  // Start bun dev server
  const server = spawn("bun", ["--hot", "viewer/index.html"], {
    env: { ...process.env, BUN_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog: string[] = [];
  server.stdout!.on("data", (d) => serverLog.push(d.toString()));
  server.stderr!.on("data", (d) => serverLog.push(d.toString()));

  // Wait for server ready (crude: poll `/`)
  const serverUrl = `http://localhost:${port}`;
  await waitForHttp(serverUrl, 15_000);

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const context = await browser.newContext({
    viewport: { width: Number(values["viewport-w"]), height: Number(values["viewport-h"]) },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const consoleLog: string[] = [];
  page.on("console", (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLog.push(`[pageerror] ${err.message}`));

  await page.goto(serverUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("svg, canvas", { timeout: 10_000 });
  // Allow layout + data load to settle.
  await page.waitForTimeout(600);

  const modes = values.mode === "both" ? ["svg", "canvas"] : [values.mode!];
  for (const m of modes) {
    const label = m === "svg" ? "Greenberg · SVG" : "Force · Canvas";
    await page.getByRole("button", { name: label }).click();
    await page.waitForTimeout(400);

    if (values.hover) {
      await page.evaluate((id) => {
        (window as any).__viewer__.getState().setHover(id);
      }, values.hover);
    }
    if (values.select) {
      await page.evaluate((id) => {
        (window as any).__viewer__.getState().selectPaper(id);
      }, values.select);
    }
    await page.waitForTimeout(250);

    const png = `${outDir}/viewer.${m}.png`;
    await page.screenshot({ path: png, fullPage: false });
    console.log(`wrote ${png}`);

    if (values.stats) {
      const stats = await page.evaluate(() => {
        // Snapshot DOM layout for the SVG view.
        const svg = document.querySelector("svg");
        const circles = svg ? Array.from(svg.querySelectorAll("circle[data-paper]")) : [];
        const byCell = new Map<string, number>();
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const c of circles) {
          const cx = Number(c.getAttribute("cx"));
          const cy = Number(c.getAttribute("cy"));
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          const key = `${Math.round(cx / 40)}|${Math.round(cy / 40)}`;
          byCell.set(key, (byCell.get(key) ?? 0) + 1);
        }
        const crowded = [...byCell.entries()].filter(([, n]) => n > 6);
        const edges = svg ? Array.from(svg.querySelectorAll("path[marker-end]")) : [];
        const pane = document.querySelector(".graph-pane")?.getBoundingClientRect();
        const svgBox = svg?.getBoundingClientRect();
        return {
          circleCount: circles.length,
          edgeCount: edges.length,
          crowdedCells: crowded,
          bounds: { minX, maxX, minY, maxY },
          pane,
          svgBox,
        };
      });
      console.log(`[${m}] stats:`, JSON.stringify(stats, null, 2));
    }
  }

  if (consoleLog.length) {
    console.log("--- page console / errors ---");
    for (const l of consoleLog.slice(-30)) console.log(l);
  }

  await browser.close();
  server.kill();
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not ready within ${timeoutMs}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
