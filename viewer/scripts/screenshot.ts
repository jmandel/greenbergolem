import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? "/tmp/viewer-shot.png";

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[data-paper]", { timeout: 60_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: out, fullPage: false });
console.log(`wrote ${out}`);
await browser.close();
