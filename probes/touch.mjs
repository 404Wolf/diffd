import { createRequire } from "node:module";
const require = createRequire("/home/wolf/.herdr/worktrees/diffd/mobile-sidebar/web/package.json");
const { chromium } = require("playwright");
const [url] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/home/wolf/.nix-profile/bin/google-chrome-stable" });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto(url);
await page.waitForSelector("[data-file-section], main p");
await page.waitForTimeout(500);
const w = () => page.evaluate(() => [...document.querySelectorAll("aside[data-drawer]")].map((a) => a.dataset.drawer + ":" + a.getBoundingClientRect().width));
console.log("start", await w());
const h = await page.locator("aside[data-drawer=left] [role=separator]").boundingBox();
// double tap the handle
await page.touchscreen.tap(h.x + 3, h.y + 300); await page.waitForTimeout(80); await page.touchscreen.tap(h.x + 3, h.y + 300);
await page.waitForTimeout(400);
console.log("after double tap handle", await w());
// touch drag via CDP
const cdp = await ctx.newCDPSession(page);
const drag = async (x0, x1, y) => {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 10, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
};
const h2 = await page.locator("aside[data-drawer=left] [role=separator]").boundingBox();
await drag(h2.x + 3, 30, h2.y + 300);
console.log("after drag left handle to x=30", await w());
const r = await page.locator("aside[data-drawer=right] [role=separator]").boundingBox();
await page.touchscreen.tap(r.x + 5, r.y + 300); await page.waitForTimeout(400);
console.log("after tap right handle", await w());
await page.screenshot({ path: process.argv[3] });
await browser.close();
