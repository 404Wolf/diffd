import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire("/home/wolf/.herdr/worktrees/diffd/mobile-sidebar/web/package.json");
const { chromium } = require("playwright");
const reviewUrl = process.argv[2]; const base = new URL(reviewUrl).origin; const shots = "/tmp/claude-1001/-home-wolf--herdr-worktrees-diffd-mobile-sidebar/99bf4316-5d02-485b-b337-678c76d3d834/scratchpad/phone-shots"; mkdirSync(shots,{recursive:true});
const errors = [];
// -- Helpers ---------------------------------------------------------------------
let step = 0;
const log = (m) => console.log(`  ${m}`);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log(`✓ ${msg}`);
}
async function section(name, fn) {
  step++;
  console.log(`\n${step}. ${name}`);
  await fn();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function keys(page, ...seq) {
  for (const k of seq) {
    await page.keyboard.press(k);
    await sleep(25);
  }
  await sleep(120);
}
const status = async (page) => (await page.locator("footer").innerText()).replace(/\s+/g, " ");
/** The file:line the cursor is on, from the status line. */
/** Wait (briefly) until the status line mentions `text`; for commands that answer asynchronously. */
const statusSoon = async (page, text, ms = 5000) =>
  page
    .waitForFunction((t) => document.querySelector("footer")?.innerText.includes(t), text, { timeout: ms })
    .then(() => true)
    .catch(() => false);
const at = async (page) => (await status(page)).match(/([\w.-]+):(\d+|-) (?:new|old)/)?.[1] ?? "";
const shot = (page, name) => page.screenshot({ path: `${shots}/${String(step).padStart(2, "0")}-${name}.png` });
/** The top visible row and its offset, to prove the page didn't move. */
const viewport = (page) =>
  page.evaluate(() => {
    const buf = document.querySelector(".buffer.focused");
    const top = buf.getBoundingClientRect().top + 34;
    for (const r of buf.querySelectorAll(".row")) {
      if (r.closest(".gap-body[hidden]")) continue;
      const rect = r.getBoundingClientRect();
      if (rect.bottom > top) return { key: `${r.dataset.f}:${r.dataset.r}`, y: Math.round(rect.top) };
    }
    return null;
  });
/** The code at the top of the focused buffer, and where it is: survives rows and files being renumbered. */
const topLine = (page) =>
  page.evaluate(() => {
    const buf = document.querySelector(".buffer.focused");
    const top = buf.getBoundingClientRect().top + 34;
    for (const r of buf.querySelectorAll(".row")) {
      if (r.closest(".gap-body[hidden]")) continue;
      const rect = r.getBoundingClientRect();
      if (rect.bottom > top) return { text: r.innerText, y: Math.round(rect.top) };
    }
    return null;
  });
/** Wait until the part of the history the header names is on screen (the chip shows it while it loads). */
const spanReady = (page) => page.waitForFunction(() => !document.querySelector('[data-span-chip][aria-busy="true"]'));

/**
 * A long diff is windowed: only rows near the screen are in the page. Scroll
 * through the buffer, as a reader would, until `selector` is there.
 */
async function scrollUntil(page, selector, pane = ".buffer.focused") {
  for (let i = 0; i < 400; i++) {
    if ((await page.locator(`${pane} ${selector}`).count()) > 0) return;
    const end = await page.evaluate(
      ({ pane, first }) => {
        const buf = document.querySelector(pane);
        const before = buf.scrollTop;
        buf.scrollTop = first ? 0 : before + buf.clientHeight * 0.8;
        return !first && buf.scrollTop === before;
      },
      { pane, first: i === 0 },
    );
    if (end && (await page.locator(`${pane} ${selector}`).count()) === 0) return;
    await sleep(30);
  }
}
/** The review again, without the splits, views and places the page saved from earlier sections. */
async function freshPage(page) {
  await page.goto(base);
  await page.evaluate(() => {
    for (const store of [localStorage, sessionStorage])
      for (const k of Object.keys(store)) if (k.startsWith("diffd:session:")) store.removeItem(k);
  });
  await page.goto(reviewUrl);
}

async function cursorTo(page, fileName, line, side = "new", pane = ".buffer.focused") {
  // Click the code cell of that line, like a user would.
  const selector = `[data-file-section]:has([data-path$="${fileName}"]) .row[data-${side === "new" ? "nl" : "ol"}="${line}"] .code[data-side="${side}"]`;
  await scrollUntil(page, selector, pane);
  const cell = page.locator(`${pane} ${selector}`).first();
  if ((await cell.count()) === 0) {
    const rows = await page.evaluate(
      ({ pane, fileName }) =>
        [...document.querySelectorAll(`${pane} [data-file-section]:has([data-path$="${fileName}"]) .row`)].map((r) => `${r.dataset.ol}/${r.dataset.nl}`).join(" "),
      { pane, fileName },
    );
    throw new Error(`FAILED: no ${side} line ${line} of ${fileName} to click (rows: ${rows || "none"})`);
  }
  // Rows far from the screen are filled in as they come near it, which can
  // replace the element being scrolled to: look it up again then.
  for (let attempt = 0; ; attempt++) {
    try {
      await cell.scrollIntoViewIfNeeded();
      break;
    } catch (e) {
      if (attempt > 2 || !String(e).includes("not attached")) throw e;
      await sleep(100);
    }
  }
  await cell.click({ position: { x: 4, y: 4 } });
  await sleep(80);
}

const browser = await chromium.launch({ executablePath: "/home/wolf/.nix-profile/bin/google-chrome-stable" });
try {
  await section("On a phone the drawers are sheets over the code, opened from the top bar", async () => {
    // A Pixel Fold's cover screen: narrow, touch.
    const phone = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
    });
    const p = await phone.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    try {
      await p.goto(reviewUrl);
      await p.waitForSelector(".buffer.focused .row");
      const panes = async () => (await p.locator("#panes").boundingBox()).width;
      const left = p.locator("aside[data-drawer=left]");
      const right = p.locator("aside[data-drawer=right]");
      /** Wait for a sheet to open or close, and to finish sliding. */
      const sheet = async (side, state) => {
        await p.waitForFunction(
          ([side, state]) => document.querySelector(`aside[data-drawer=${side}]`)?.dataset.sheet === state,
          [side, state],
        );
        await sleep(350);
      };
      check((await panes()) >= 410 && !(await left.isVisible()) && !(await right.isVisible()), "the code has the whole width; both drawers start put away");
      const wide = await p.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth]);
      check(wide[0] === wide[2] && wide[1] === wide[2], `the sheets waiting off screen don't widen the page (${wide.join(" / ")})`);
      const bar = await p.locator("header").boundingBox();
      check(bar.height <= 56, `the top bar is one line (${Math.round(bar.height)}px)`);
      await p.locator("[data-header-details]").tap();
      const details = p.locator("[data-header-details-panel]");
      await details.waitFor();
      const said = await details.innerText();
      check(said.includes("Add burst capacity") && said.includes("main") && /\d+ files/.test(said), "the rest of it is behind the details button");
      const focused = () =>
        p.evaluate(() => {
          const a = document.activeElement;
          if (a?.matches("[data-header-details-panel] a")) return "link";
          if (a?.closest("[data-header-details-panel]")) return "panel";
          return a?.matches("[data-header-details]") ? "button" : a?.tagName;
        });
      check((await focused()) === "panel", "focus goes into the details");
      await p.keyboard.press("Tab");
      check((await focused()) === "link", "tab reaches its link");
      await p.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });
      const backOnButton = await p
        .waitForFunction(() => document.activeElement?.matches("[data-header-details]"), null, { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      check(backOnButton, "esc closes it, back on its button");
      const toggle = await p.locator("[data-drawer-toggle=left]").boundingBox();
      check(toggle.width >= 44 && toggle.height >= 44, "the files button is big enough to tap");

      await p.tap("[data-drawer-toggle=left]");
      await sheet("left", "open");
      check((await left.isVisible()) && (await panes()) >= 410, "it slides the files over the code, which keeps its width");
      const focusIn = () =>
        p.evaluate(() => {
          const a = document.activeElement;
          return a?.closest("aside[data-drawer]")?.dataset.drawer ?? a?.dataset.drawerToggle ?? a?.tagName;
        });
      check((await focusIn()) === "left", "focus goes into it");
      await p.keyboard.press("Escape");
      await sheet("left", "closed");
      check((await focusIn()) === "left", "esc puts it away, and focus goes back to its button");
      await p.tap("[data-drawer-toggle=left]");
      await sheet("left", "open");
      await p.locator("aside[data-drawer=left] input[type=search]").tap();
      await p.keyboard.press("Escape");
      await sheet("left", "closed");
      check(!(await left.isVisible()), "esc in the filter puts it away too");
      await p.tap("[data-drawer-toggle=left]");
      await sheet("left", "open");
      const row = await p.locator("aside[data-drawer=left] [data-tree-file]").first().boundingBox();
      check(row.height >= 44, `tree rows are big enough to tap (${row.height}px)`);
      await shot(p, "phone-files");
      await p.locator('[data-tree-file$="api.ts"]').tap();
      await sheet("left", "closed");
      check((await status(p)).includes("api.ts"), "tapping a file opens it and puts the files away");

      await p.tap("[data-drawer-toggle=right]");
      await sheet("right", "open");
      check(await right.locator("#chat-input").isVisible(), "the other button brings out activity and the chat");
      await p.touchscreen.tap(12, 500);
      await sheet("right", "closed");
      check(!(await right.isVisible()), "tapping the dimmed code puts it away");
      await p.tap("[data-drawer-toggle=right]");
      await sheet("right", "open");
      await right.locator("#chat-input").tap();
      await p.keyboard.press("Escape");
      await sheet("right", "closed");
      check(!(await right.isVisible()) && (await p.locator("[data-drawer-backdrop]").count()) === 0, "esc in the chat puts it away, backdrop and all");
      // With a keyboard (a phone with one, a narrow window): ctrl-h brings the files out, into focus.
      await p.locator(".buffer.focused").focus();
      await p.keyboard.press("Control+h");
      await sheet("left", "open");
      check((await focusIn()) === "left", "ctrl-h opens the files with focus in them, not in the code behind");
      await p.keyboard.press("Escape");
      await sheet("left", "closed");

      // Esc closes only the top layer: the details over the files, then the files.
      await p.tap("[data-drawer-toggle=left]");
      await sheet("left", "open");
      await p.locator("[data-header-details]").tap();
      await details.waitFor();
      await p.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });
      check((await left.isVisible()) && (await p.locator("[data-drawer-backdrop]").count()) === 1, "esc with the details over the files closes only the details");
      await p.keyboard.press("Escape");
      await sheet("left", "closed");
      check(!(await left.isVisible()), "and esc again the files");

      // Unfolded (the inner screen): the drawers sit beside the code again, and the details go with their button.
      await p.locator("[data-header-details]").tap();
      await details.waitFor();
      await p.setViewportSize({ width: 884, height: 1050 });
      await p.waitForFunction(() => !document.querySelector("aside[data-drawer=left]")?.dataset.sheet);
      check((await left.isVisible()) && (await panes()) < 884 - 200, "on a wider screen the files are beside the code");
      await details.waitFor({ state: "detached" });
      check(!(await p.locator("[data-header-details]").isVisible()), "and the details close with their button gone");
      const onCode = await p
        .waitForFunction(() => document.activeElement?.closest(".buffer"), null, { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      check(onCode, "focus goes to the code rather than the hidden button");
    } finally {
      await phone.close();
    }
  });

  check(errors.length === 0, "no errors " + errors.join(" | "));
} finally { await browser.close(); }
