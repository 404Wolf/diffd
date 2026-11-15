// node compose-shots.mjs <url> <outprefix> [drag]
import { createRequire } from "node:module";
const require = createRequire("/home/wolf/.herdr/worktrees/diffd/mobile-sidebar/web/package.json");
const { chromium } = require("playwright");
const [url, out, mode] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/home/wolf/.nix-profile/bin/google-chrome-stable" });
const mobile = { deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
const devices = {
  cover: { viewport: { width: 412, height: 915 }, ...mobile },
  inner: { viewport: { width: 884, height: 1050 }, ...mobile },
  innerland: { viewport: { width: 1050, height: 884 }, ...mobile },
};
for (const [name, d] of Object.entries(devices)) {
  const ctx = await browser.newContext(d);
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector(".buffer.focused .row");
  const sel = '[data-file-section]:has([data-path$="src/lib.rs"]) .num[data-side="new"][data-n="45"]';
  for (let i = 0; i < 60 && !(await page.locator(sel).count()); i++) {
    await page.evaluate(() => { const b = document.querySelector(".buffer.focused"); b.scrollTop += b.clientHeight * 0.6; });
    await page.waitForTimeout(60);
  }
  const num = page.locator(sel).first();
  await num.scrollIntoViewIfNeeded();
  await page.evaluate((s) => { const el = document.querySelector(s); const b = document.querySelector(".buffer.focused"); b.scrollTop += el.getBoundingClientRect().top - b.getBoundingClientRect().top - 120; }, sel);
  await page.waitForTimeout(200);
  if (mode === "drag") {
    const a = await num.boundingBox();
    const end = page.locator(sel.replace('"45"', '"50"')).first();
    const b = await end.boundingBox();
    const cdp = await ctx.newCDPSession(page);
    const x = a.x + a.width / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: a.y + a.height / 2 }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: a.y + a.height / 2 + ((b.y - a.y) * i) / 8 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await num.tap();
  }
  await page.waitForSelector('[role=dialog][aria-label="Write a comment"]', { timeout: 5000 }).catch(() => console.log(name, "no composer"));
  await page.waitForTimeout(400);
  const label = await page.locator('[role=dialog][aria-label="Write a comment"]').innerText().catch(() => "");
  console.log(name, JSON.stringify(label.split("\n")[0]));
  await page.screenshot({ path: `${out}-${name}.png` });
  await ctx.close();
}
await browser.close();
