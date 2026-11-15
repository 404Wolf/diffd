import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire("/home/wolf/.herdr/worktrees/diffd/mobile-sidebar/web/package.json");
const { chromium } = require("playwright");
const reviewUrl = process.argv[2]; const base = new URL(reviewUrl).origin; const shots = process.argv[3] ?? "/tmp/claude-1001/-home-wolf--herdr-worktrees-diffd-mobile-sidebar/99bf4316-5d02-485b-b337-678c76d3d834/scratchpad/shots"; mkdirSync(shots,{recursive:true});
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
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
try {
  await section("Reviewing from a phone: drag over line numbers, comment, reply, resolve", async () => {
    const phone = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
    });
    const p = await phone.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    const cdp = await phone.newCDPSession(p);
    /** A finger pressed on one element, dragged to another, and lifted. */
    const touchDrag = async (from, to) => {
      const a = await from.boundingBox();
      const b = await to.boundingBox();
      const x = a.x + a.width / 2;
      const [y0, y1] = [a.y + a.height / 2, b.y + b.height / 2];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= 8; i++)
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 8 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const file = "tools/logreport.py";
    const num = (n) => p.locator(`.buffer.focused [data-file-section]:has([data-path$="${file}"]) .num[data-side="new"][data-n="${n}"]`).first();
    const composer = p.getByRole("dialog", { name: "Write a comment" });
    const range = () => composer.locator("[data-composer-range]").innerText();
    try {
      await p.goto(reviewUrl);
      await p.waitForSelector(".buffer.focused .row");
      await scrollUntil(p, `[data-file-section]:has([data-path$="${file}"]) .num[data-side="new"][data-n="6"]`);
      await num(3).scrollIntoViewIfNeeded();
      await touchDrag(num(3), num(6));
      await composer.waitFor();
      check((await range()).includes("L3–6"), `dragging a finger down the line numbers selects lines 3 to 6 (${await range()})`);
      const docked = await composer.boundingBox();
      check(docked.width >= 410 && docked.y + docked.height >= 915 - 30, "the composer is docked along the bottom, full width");
      const send = composer.getByRole("button", { name: "Comment", exact: true });
      check((await send.boundingBox()).height >= 44, "its Comment button is big enough to tap");

      // The on-screen keyboard: the page's viewport shrinks (interactive-widget=resizes-content).
      await p.setViewportSize({ width: 412, height: 520 });
      await sleep(400);
      const geo = await p.evaluate(() => {
        const c = document.querySelector('[role=dialog][aria-label="Write a comment"]').getBoundingClientRect();
        const rows = [...document.querySelectorAll(".buffer.focused .row.vsel")].map((r) => r.getBoundingClientRect());
        return { top: c.top, bottom: c.bottom, h: innerHeight, last: rows.at(-1)?.bottom ?? null, first: rows[0]?.top ?? null };
      });
      check(geo.bottom <= geo.h + 1 && geo.top > 0, `with the keyboard up the composer is still all on screen (${Math.round(geo.top)}–${Math.round(geo.bottom)} of ${geo.h})`);
      check(geo.last !== null && geo.last <= geo.top + 1, "and the selected lines are scrolled into view above it");
      const words = `Phone comment ${Date.now()}: why a Counter here?`;
      await composer.getByRole("textbox").fill(words);
      await send.tap();
      await composer.waitFor({ state: "detached" });
      const thread = p.locator(".buffer.focused [data-thread]").filter({ hasText: words });
      await thread.waitFor();
      check(true, "tapping Comment sends it: the thread shows on those lines");
      await p.setViewportSize({ width: 412, height: 915 });
      await sleep(300);

      const reply = thread.getByRole("button", { name: /^Reply/ });
      check((await reply.boundingBox()).height >= 44, "the thread's Reply is big enough to tap");
      await reply.tap();
      await composer.waitFor();
      await composer.getByRole("textbox").fill("Phone reply: never mind, it's for most_common.");
      await composer.getByRole("button", { name: "Comment", exact: true }).tap();
      await composer.waitFor({ state: "detached" });
      await thread.filter({ hasText: "Phone reply" }).waitFor();
      check(true, "a reply written on the phone joins the thread");
      await thread.getByRole("button", { name: "Resolve" }).tap();
      await thread.getByRole("button", { name: "Reopen" }).waitFor();
      check(true, "Resolve works by tap");

      // Tap a line, then others: the line first tapped stays, each tap moves the other end.
      const rangeIs = (want) =>
        p
          .waitForFunction((w) => document.querySelector("[data-composer-range]")?.textContent.includes(w), want, { timeout: 3000 })
          .then(() => true)
          .catch(() => false);
      await num(10).scrollIntoViewIfNeeded();
      await num(10).tap();
      await composer.waitFor();
      check((await range()).includes("L10"), "a tap on a line number starts a comment on that line");
      await composer.getByRole("textbox").fill("A draft that should survive a reload");
      await num(12).tap();
      check(await rangeIs("L10–12"), "tapping another line number moves the range's end to it (L10–12)");
      await p.reload();
      await p.waitForSelector(".buffer.focused .row");
      await composer.waitFor();
      check(
        (await rangeIs("L10–12")) && (await composer.getByRole("textbox").inputValue()) === "A draft that should survive a reload",
        "a reload brings the draft back on its moved range, L10–12",
      );
      await num(20).tap();
      check(await rangeIs("L10–20"), "L20 next: L10–20");
      await num(5).tap();
      check(await rangeIs("L5–10"), "then L5: L5–10, the first tap's line stays put");
      const clear = composer.getByRole("button", { name: "Clear range" });
      check((await clear.boundingBox()).height >= 44, "Clear range is there, big enough to tap");
      await clear.tap();
      check((await rangeIs("L10")) && !(await range()).includes("–"), "and takes it back to the first line, L10");
      await composer.getByRole("button", { name: "Cancel" }).tap();
      await composer.waitFor({ state: "detached" });

      // Dragging up into the sticky file header, and holding: the buffer scrolls and the range grows upward.
      await num(14).scrollIntoViewIfNeeded();
      const top = await p.evaluate((f) => {
        const buf = document.querySelector(".buffer.focused");
        const row = document.querySelector(`.buffer.focused [data-file-section]:has([data-path$="${f}"]) .num[data-side="new"][data-n="14"]`);
        buf.scrollTop += row.getBoundingClientRect().top - buf.getBoundingClientRect().top - 34;
        return buf.getBoundingClientRect().top;
      }, file);
      await sleep(300);
      const start = await num(14).boundingBox();
      const sx = start.x + start.width / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: sx, y: start.y + start.height / 2 }] });
      for (let i = 1; i <= 6; i++)
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: sx, y: start.y + start.height / 2 - ((start.y + start.height / 2 - (top + 8)) * i) / 6 }] });
      await sleep(900);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await composer.waitFor();
      const upward = (await range()).match(/L(\d+)–(\d+)/);
      check(upward && Number(upward[1]) < 12 && upward[2] === "14", `held over the header, the range grows upward past it (${await range()})`);
      await composer.getByRole("button", { name: "Cancel" }).tap();
      await composer.waitFor({ state: "detached" });
    } finally {
      await phone.close();
    }

    // Unfolded, portrait and landscape: the composer floats by the lines, its buttons still finger-sized.
    for (const [w, h] of [[884, 1050], [1050, 884]]) {
      const inner = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
      const q = await inner.newPage();
      q.on("pageerror", (e) => errors.push(e.message));
      const qcdp = await inner.newCDPSession(q);
      try {
        await q.goto(reviewUrl);
        await q.waitForSelector(".buffer.focused .row");
        const n = (k) => q.locator(`.buffer.focused [data-file-section]:has([data-path$="${file}"]) .num[data-side="new"][data-n="${k}"]`).first();
        await scrollUntil(q, `[data-file-section]:has([data-path$="${file}"]) .num[data-side="new"][data-n="9"]`);
        // Below the thread the phone left on lines 3–6.
        await n(7).scrollIntoViewIfNeeded();
        const [s0, s1] = [await n(7).boundingBox(), await n(9).boundingBox()];
        const x = s0.x + s0.width / 2;
        await qcdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: s0.y + 4 }] });
        for (let i = 1; i <= 6; i++) await qcdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: s0.y + 4 + ((s1.y - s0.y) * i) / 6 }] });
        await qcdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        const c = q.getByRole("dialog", { name: "Write a comment" });
        await c.waitFor();
        const box = await c.boundingBox();
        const btn = await c.getByRole("button", { name: "Comment", exact: true }).boundingBox();
        check(
          (await c.locator("[data-composer-range]").innerText()).includes("L7–9") && box.y >= 0 && box.y + box.height <= h && btn.height >= 44,
          `at ${w}×${h} a finger drag selects lines 7–9 and the composer is on screen with a 44px button`,
        );
      } finally {
        await inner.close();
      }
    }

    // With a mouse it's the same path: press on a line number, drag, release.
    await freshPage(page);
    await page.waitForSelector(".buffer.focused .row");
    const desk = (n) => page.locator(`.buffer.focused [data-file-section]:has([data-path$="${file}"]) .num[data-side="new"][data-n="${n}"]`).first();
    await scrollUntil(page, `[data-file-section]:has([data-path$="${file}"]) .num[data-side="new"][data-n="9"]`);
    await desk(7).scrollIntoViewIfNeeded();
    const a = await desk(7).boundingBox();
    const b = await desk(9).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    const deskComposer = page.getByRole("dialog", { name: "Write a comment" });
    await deskComposer.waitFor();
    const said = await deskComposer.locator("[data-composer-range]").innerText();
    check(said.includes("L7–9"), `a mouse drag over line numbers selects lines too (${said})`);
    await keys(page, "Escape");
  });

  check(errors.length === 0, "no errors " + errors.join(" | "));
} finally { await browser.close(); }
