// Drive the page over any review, e.g. one of a real repository shared by
// scripts/verify-review.py: load it, walk every file and commit, expand
// everything, open file views and splits, use symbols, and check nothing
// breaks (no page errors, no failed requests) and that it stays quick.
//
//   node web/e2e/smoke.mjs <review-url> [<review-url> …]
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch(process.env.DIFFD_E2E_CHROMIUM ? { executablePath: process.env.DIFFD_E2E_CHROMIUM } : {});

const status = async (page) => (await page.locator("footer").innerText()).replace(/\s+/g, " ");
const press = async (page, ...keys) => {
  for (const k of keys) {
    await page.keyboard.press(k);
    await page.waitForTimeout(15);
  }
};
let failed = false;

for (const url of process.argv.slice(2)) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("response", (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForSelector("[data-file-section], main p");
  const loaded = Date.now() - t0;
  const state = await page.evaluate(() => JSON.parse(document.getElementById("diffd-boot").textContent).state);
  const files = state.snapshot.files.length;
  const commits = state.history.commits.length;
  const timings = { load: loaded };
  const time = async (name, fn) => {
    const s = Date.now();
    await fn();
    timings[name] = Date.now() - s;
  };
  await page.locator(".buffer.focused").focus();

  const seen = new Set();
  await time("walk files", async () => {
    for (let i = 0; i < files + 2; i++) {
      await press(page, "]", "f");
      seen.add((await status(page)).split(" ")[1]);
    }
  });
  await time("hunks", async () => {
    for (let i = 0; i < 20; i++) await press(page, "]", "c");
  });
  await time("expand all", () => press(page, "z", "Shift+R"));
  await time("to the end and back", () => press(page, "Shift+G", "g", "g"));
  await time("file view", async () => {
    await press(page, "]", "c", "g", "Enter");
    await press(page, "Control+o");
  });
  await time("symbols", async () => {
    for (let i = 0; i < 5; i++) await press(page, "w");
    await press(page, "Escape");
  });
  await time("split", async () => {
    await press(page, "Control+Backslash", "]", "f", "Control+Escape");
  });
  if (commits > 0)
    await time("walk commits", async () => {
      for (let i = 0; i < Math.min(commits, 6); i++) {
        await press(page, "]", "r");
        await page.waitForTimeout(250);
      }
      await press(page, "Space", "c");
      await press(page, "Escape");
    });
  await time("search", async () => {
    await press(page, "/");
    await page.keyboard.type("the");
    await page.waitForTimeout(200);
    await press(page, "Escape");
  });
  const rows = await page.locator(".row").count();
  await page.waitForTimeout(300);
  const ok = problems.length === 0;
  failed ||= !ok;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${url}  ${files} files, ${commits} commits, ${rows} rows rendered · ` +
      Object.entries(timings)
        .map(([k, v]) => `${k} ${v}ms`)
        .join(", "),
  );
  for (const p of problems) console.log(`     ${p}`);
  await context.close();
}
await browser.close();
process.exitCode = failed ? 1 : 0;
