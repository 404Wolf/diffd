// node after.mjs <url> <outprefix>
import { createRequire } from "node:module";
const require = createRequire("/home/wolf/.herdr/worktrees/diffd/mobile-sidebar/web/package.json");
const { chromium } = require("playwright");
const [url, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/home/wolf/.nix-profile/bin/google-chrome-stable" });
const mobile = { deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
const devices = {
  cover: { viewport: { width: 412, height: 915 }, ...mobile },
  inner: { viewport: { width: 884, height: 1050 }, ...mobile },
  innerland: { viewport: { width: 1050, height: 884 }, ...mobile },
  desktop: { viewport: { width: 1440, height: 900 } },
};
const geo = (page) => page.evaluate(() => {
  const r = (el) => el && (({ x, width }) => `${Math.round(x)}+${Math.round(width)}`)(el.getBoundingClientRect());
  const vis = (el) => el && getComputedStyle(el).visibility === "visible" && el.getBoundingClientRect().right > 0 && el.getBoundingClientRect().left < innerWidth;
  const L = document.querySelector("aside[data-drawer=left]"), R = document.querySelector("aside[data-drawer=right]");
  const t = document.querySelector("[data-drawer-toggle=left]");
  return { left: r(L), leftVisible: vis(L), right: r(R), rightVisible: vis(R), panes: r(document.getElementById("panes")),
    toggle: t && getComputedStyle(t).display !== "none" ? r(t) + "x" + Math.round(t.getBoundingClientRect().height) : "hidden",
    backdrop: !!document.querySelector("[data-drawer-backdrop]"), rowH: document.querySelector("[data-tree-file]")?.getBoundingClientRect().height };
});
for (const [name, d] of Object.entries(devices)) {
  const ctx = await browser.newContext(d);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector("[data-file-section], main p");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}-${name}.png` });
  console.log(name, "load", JSON.stringify(await geo(page)));
  if (d.hasTouch) {
    if ((await page.getAttribute("[data-drawer-toggle=left]", "aria-expanded")) !== "true")
      await page.tap("[data-drawer-toggle=left]");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}-${name}-files.png` });
    console.log(name, "files open", JSON.stringify(await geo(page)));
    // Open a file from the tour: on a phone the sheet gets out of the way.
    await page.tap("[data-tree-file='web/src/api.ts']");
    await page.waitForTimeout(500);
    const top = await page.evaluate(() => document.querySelector("footer").innerText.replace(/\s+/g, " ").slice(0, 60));
    console.log(name, "after tapping api.ts", JSON.stringify(await geo(page)), top);
    await page.tap("[data-drawer-toggle=right]");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}-${name}-activity.png` });
    console.log(name, "activity open", JSON.stringify(await geo(page)));
    if (await page.$("[data-drawer-backdrop]")) {
      await page.touchscreen.tap(10, 500);
      await page.waitForTimeout(400);
      console.log(name, "after tapping backdrop", JSON.stringify(await geo(page)));
    } else {
      await page.tap("[data-drawer-toggle=right]");
      await page.waitForTimeout(300);
      console.log(name, "after toggling activity again", JSON.stringify(await geo(page)));
    }
  }
  if (errors.length) console.log(name, "ERRORS", errors);
  await ctx.close();
}
await browser.close();
