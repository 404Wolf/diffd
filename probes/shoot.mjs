// node shoot.mjs <url> <outprefix>
import { createRequire } from "node:module";
const require = createRequire("/home/wolf/.herdr/worktrees/diffd/mobile-sidebar/web/package.json");
const { chromium } = require("playwright");
const [url, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/home/wolf/.nix-profile/bin/google-chrome-stable", args: ["--ignore-certificate-errors"] });
const devices = {
  cover: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  inner: { viewport: { width: 884, height: 1050 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  innerland: { viewport: { width: 1050, height: 884 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 } },
};
for (const [name, d] of Object.entries(devices)) {
  const ctx = await browser.newContext({ ...d, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector("[data-file-section], main p", { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}-${name}.png` });
  const info = await page.evaluate(() => {
    const r = (el) => el && (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect());
    return {
      vw: innerWidth, docW: document.documentElement.scrollWidth,
      left: r(document.querySelector("aside[data-drawer=left]")),
      leftHandle: r(document.querySelector("aside[data-drawer=left] [role=separator]")),
      right: r(document.querySelector("aside[data-drawer=right]")),
      panes: r(document.getElementById("panes")),
      header: r(document.querySelector("header")),
    };
  });
  console.log(name, JSON.stringify(info));
  await ctx.close();
}
await browser.close();
