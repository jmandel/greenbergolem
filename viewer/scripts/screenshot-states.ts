// Screenshot the viewer in three states: overview, paper selected,
// edge selected. Used to validate sidebar redesigns end-to-end.

import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:3000";
const outDir = "/tmp";

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[data-paper]", { timeout: 10_000 });
await page.waitForTimeout(400);

// State 1: overview
await page.screenshot({ path: `${outDir}/state-overview.png` });
console.log(`overview: ${outDir}/state-overview.png`);

// State 2: click a known authority paper.
// `data-authority` is on the inner <circle>, so look for a <g data-paper>
// that contains a descendant circle with data-authority="1".
const authId = await page.$$eval("g[data-paper]", (els) => {
  const target = els.find((el) => el.querySelector('circle[data-authority="1"]')) as HTMLElement | undefined;
  return target ? target.getAttribute("data-paper") : null;
});
console.log(`picked authority: ${authId}`);
if (authId) {
  await page.click(`[data-paper="${authId}"]`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/state-paper.png` });
  console.log(`paper: ${outDir}/state-paper.png`);

  // State 3: click an outgoing edge from that paper, if one exists.
  const firstEdge = await page.$("aside .edge-list-item");
  if (firstEdge) {
    await firstEdge.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}/state-edge.png` });
    console.log(`edge: ${outDir}/state-edge.png`);
  }
}

await browser.close();
