// node topbar.mjs <url> <outprefix>
import { createRequire } from "node:module";
const require = createRequire("/home/wolf/.herdr/worktrees/diffd/mobile-sidebar/web/package.json");
const { chromium } = require("playwright");
const [url, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/home/wolf/.nix-profile/bin/google-chrome-stable", args: ["--ignore-certificate-errors"] });
const mobile = { deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true };
const devices = {
  small: { viewport: { width: 360, height: 780 }, ...mobile },
  cover: { viewport: { width: 412, height: 915 }, ...mobile },
  inner: { viewport: { width: 884, height: 1050 }, ...mobile },
  desktop: { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true },
};
const head = (page) => page.evaluate(() => {
  const h = document.querySelector("header");
  const kids = [...h.children].filter((c) => c.getClientRects().length && getComputedStyle(c).display !== "contents");
  const tops = new Set(kids.map((c) => Math.round(c.getBoundingClientRect().top)));
  return { height: Math.round(h.getBoundingClientRect().height), rows: tops.size, overflow: h.scrollWidth > h.clientWidth, text: h.innerText.replace(/\s+/g, " ").slice(0, 120) };
});
for (const [name, d] of Object.entries(devices)) {
  const ctx = await browser.newContext(d);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector("[data-file-section], main p");
  await page.waitForTimeout(600);
  console.log(name, JSON.stringify(await head(page)));
  await page.screenshot({ path: `${out}-${name}.png`, clip: { x: 0, y: 0, width: d.viewport.width, height: Math.min(d.viewport.height, 420) } });
  const details = page.locator("[data-header-details]");
  if (await details.isVisible()) {
    await details.tap();
    await page.waitForSelector("[data-header-details-panel]");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}-${name}-details.png`, clip: { x: 0, y: 0, width: d.viewport.width, height: Math.min(d.viewport.height, 420) } });
    console.log(name, "details:", (await page.locator("[data-header-details-panel]").innerText()).replace(/\s+/g, " "));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    console.log(name, "after esc panel open:", await page.locator("[data-header-details-panel]").count());
  }
  // A commit on screen: its chip joins the bar.
  await page.locator(".buffer.focused").focus().catch(() => {});
  for (const k of ["]", "r"]) await page.keyboard.press(k);
  await page.waitForFunction(() => document.querySelector("[data-span-chip]") && !document.querySelector('[data-span-chip][aria-busy="true"]'), null, { timeout: 8000 }).catch(() => console.log(name, "no chip"));
  await page.waitForTimeout(300);
  console.log(name, "with chip", JSON.stringify(await head(page)));
  await page.screenshot({ path: `${out}-${name}-chip.png`, clip: { x: 0, y: 0, width: d.viewport.width, height: Math.min(d.viewport.height, 420) } });
  if (errors.length) console.log(name, "ERRORS", errors);
  await ctx.close();
}
await browser.close();
