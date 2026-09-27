// End-to-end run of a whole review conversation against a live diffd:
// Playwright plays the user in the browser, an MCP client plays the agent.
//
//   node web/e2e/full.mjs <review-url> <repo-path> <screenshot-dir>
//
// Every step asserts what it expects; the first failure stops the run.
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const [reviewUrl, repo, shots = "/tmp/diffd-e2e"] = process.argv.slice(2);
/** Shell commands that stop and start the server, for the offline section. */
const serverControl = { stop: process.env.DIFFD_E2E_STOP, start: process.env.DIFFD_E2E_START };
const base = new URL(reviewUrl).origin;
const reviewId = new URL(reviewUrl).pathname.split("/").pop();
mkdirSync(shots, { recursive: true });

// -- A minimal MCP client (Streamable HTTP) playing the agent ------------------
class Agent {
  /** `client` is the MCP client's name, which the page names the agent after. */
  constructor(url, client = "claude-code") {
    this.url = url;
    this.client = client;
    this.id = 0;
    this.session = null;
  }
  async post(body) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.session) headers["mcp-session-id"] = this.session;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    this.session = res.headers.get("mcp-session-id") ?? this.session;
    const text = await res.text();
    if (!text.trim()) return null;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const msgs = text.split("\n").filter((l) => l.startsWith("data:") && l.slice(5).trim()).map((l) => JSON.parse(l.slice(5)));
      return msgs.filter((m) => "id" in m).at(-1);
    }
    return JSON.parse(text);
  }
  async init() {
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: this.client, version: "0" } });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async rpc(method, params) {
    const res = await this.post({ jsonrpc: "2.0", id: ++this.id, method, params });
    if (!res || res.error) throw new Error(`${method}: ${JSON.stringify(res)}`);
    return res.result;
  }
  async call(name, args) {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = r.content[0].text;
    if (r.isError) throw new Error(`${name}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

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

// -- The run ---------------------------------------------------------------------
// DIFFD_E2E_CHROMIUM: a Chromium to use instead of Playwright's own (e.g. one preinstalled elsewhere).
const browser = await chromium.launch(process.env.DIFFD_E2E_CHROMIUM ? { executablePath: process.env.DIFFD_E2E_CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// Connection failures are expected while the offline section has the server stopped.
page.on(
  "console",
  (m) =>
    m.type() === "error" &&
    !m.text().includes("ERR_CONNECTION_REFUSED") &&
    // Failed requests are reported below, with their URL.
    !m.text().startsWith("Failed to load resource") &&
    errors.push(m.text()),
);
page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.request().method()} ${r.url()}`));
let agent = new Agent(`${base}/mcp`);
await agent.init();

try {
  await section("The review page loads", async () => {
    // Watch the WebSocket handshake to see what compression the browser and server agree on.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const handshakes = [];
    cdp.on("Network.webSocketHandshakeResponseReceived", (e) => handshakes.push(e.response.headers));
    await page.goto(reviewUrl);
    await page.waitForSelector("[data-file-section]");
    await sleep(400);
    check((await page.locator("header").innerText()).includes("Add burst capacity"), "title in the top bar");
    const sections = await page.$$eval("[data-file-section] [data-path]", (els) => els.map((e) => e.dataset.path));
    const tree = await page.$$eval("[data-tree-file]", (els) => els.map((e) => e.dataset.treeFile));
    check(JSON.stringify(sections) === JSON.stringify(tree), "the diff lists files in tree order");
    check((await page.locator(".nv-add").count()) > 20, "novel tokens are highlighted");
    check((await page.locator(".s-keyword").count()) > 20, "syntax is highlighted");
    check((await status(page)).includes("NORMAL"), "status line shows NORMAL mode");
    await page.waitForFunction(() => /listening|working|checked in/.test(document.getElementById("presence")?.innerText ?? ""));
    const ext = handshakes.map((h) => h["Sec-WebSocket-Extensions"] ?? h["sec-websocket-extensions"] ?? "").join(" ");
    check(ext.includes("permessage-deflate"), `the page's WebSocket is compressed (${ext || "no extensions"})`);
    await shot(page, "loaded");
  });

  await section("Hunks, files and the note tour", async () => {
    await keys(page, "g", "g");
    const before = await status(page);
    await keys(page, "]", "c");
    await keys(page, "]", "c");
    const after = await status(page);
    check(before !== after && /hunk 2\//.test(after), `]c walks hunks (${after.match(/hunk \S+/)?.[0]})`);
    const visited = [];
    for (let i = 0; i < 20; i++) {
      await keys(page, "]", "f");
      const s = await status(page);
      visited.push(await at(page));
      if (s.includes("No more open files")) break;
    }
    check(!visited.includes("quota.ts") && !visited.includes("Cargo.lock"), `]f skips collapsed files (${[...new Set(visited)].join(", ")})`);
    await keys(page, "g", "g", "]", "a");
    check((await status(page)).includes("lib.rs:54"), "]a starts the tour at Claude's first note");
    await keys(page, "]", "a");
    check((await status(page)).includes("lib.rs:62"), "]a goes to the next note");
    await shot(page, "tour");
  });

  await section("Symbol mode, go to definition, jump list", async () => {
    await cursorTo(page, "src/lib.rs", 60);
    for (let i = 0; i < 12 && !(await status(page)).includes("· clamp"); i++) await keys(page, "w");
    check((await status(page)).includes("SYMBOL") && (await status(page)).includes("· clamp"), "w walks symbols to `clamp`");
    await keys(page, "Enter");
    check(await statusSoon(page, "bucket.rs:2"), "enter jumps to clamp's definition in bucket.rs");
    await shot(page, "definition");
    await keys(page, "Control+o");
    check((await status(page)).includes("lib.rs:60"), "ctrl-o comes back");
    await keys(page, "Control+i");
    check((await status(page)).includes("bucket.rs:2"), "ctrl-i goes forward again");
    await keys(page, "Control+o");
    await keys(page, "g", "r", "r");
    await page.locator('section[aria-label="Quickfix list"]').getByText(/references to clamp/).waitFor({ timeout: 20000 });
    check(true, "grr lists references under the code");
    await keys(page, "Space", "q");
  });

  await section("File view and back", async () => {
    await cursorTo(page, "src/lib.rs", 50);
    const before = await viewport(page);
    await keys(page, "g", "Enter");
    check(await page.getByText("no diff").isVisible(), "g enter shows the plain file");
    check((await page.locator(".fv .mark.add").count()) > 5 && (await page.locator(".fv .mark.mod").count()) > 0, "gutter marks added and changed lines");
    await shot(page, "file-view");
    await keys(page, "Control+o");
    const after = await viewport(page);
    check(await page.locator("[data-file-section]").first().isVisible(), "ctrl-o returns to the diff");
    check(before && after && before.key === after.key && Math.abs(before.y - after.y) < 3, "and to the same place");
  });

  await section("Folds, expanding context, tests", async () => {
    await page.locator('[data-file-section]:has([data-path="web/src/badge.css"])').scrollIntoViewIfNeeded();
    check(await page.getByText("Adds a .low style (amber)").isVisible(), "Claude's fold shows its summary");
    const routes = page.locator('[data-file-section]:has([data-path="src/routes.rs"])');
    // Folded rows aren't in the page (it's windowed): each gap says how many it holds.
    const hidden = () => routes.locator(".gap").evaluateAll((els) => els.reduce((n, e) => n + Number(e.textContent.match(/(\d+) hidden line/)?.[1] ?? 0), 0));
    const hiddenBefore = await hidden();
    await cursorTo(page, "src/routes.rs", 23);
    const vp = await viewport(page);
    await keys(page, "g", "e");
    const hiddenAfter = await hidden();
    check(hiddenBefore - hiddenAfter === 5, `g e reveals 5 lines (${hiddenBefore} → ${hiddenAfter} hidden)`);
    const vp2 = await viewport(page);
    check(vp.key === vp2.key && Math.abs(vp.y - vp2.y) < 3, "without moving the page");
    // `space /` searches every line: it sees folded lines too.
    await keys(page, "Space", "/");
    check(await page.getByText("Search every line, hidden ones too").isVisible(), "/ opens the page's search, which sees folded lines");
    await keys(page, "Escape");
    check((await page.locator('[data-file-section]:has([data-path="src/lib.rs"]) .row.test').count()) >= 20, "test code is marked along its side");
    await page.locator('[data-file-section]:has([data-path="tests/limiter.rs"])').scrollIntoViewIfNeeded();
    check(await page.locator('[data-file-section]:has([data-path="tests/limiter.rs"])').getByText("test file").isVisible(), "whole test files get a chip");
    await page.locator('[data-file-section]:has([data-path="tests/limiter.rs"]) .row.test').first().scrollIntoViewIfNeeded();
    await shot(page, "tests");
  });

  let threadsBefore = 0;
  await section("Commenting: gcc, visual lines, mouse selection", async () => {
    threadsBefore = await page.locator("[data-thread]").count();
    await cursorTo(page, "web/src/api.ts", 16);
    const vp = await viewport(page);
    await keys(page, "g", "c", "c");
    check(await page.getByRole("dialog", { name: "Write a comment" }).isVisible(), "gcc opens the comment popover");
    await page.keyboard.type("Should an aborted request count against the quota?");
    await shot(page, "composer");
    await keys(page, "Control+Enter");
    await page.waitForFunction((n) => document.querySelectorAll("[data-thread]").length > n, threadsBefore);
    const vp2 = await viewport(page);
    check(vp.key === vp2.key && Math.abs(vp.y - vp2.y) < 3, "the comment lands inline without moving the page");

    await cursorTo(page, "cmd/probe/main.go", 11);
    await keys(page, "V", "j", "j");
    check((await status(page)).includes("VISUAL") && (await page.locator(".row.vsel").count()) === 3, "V j j selects three lines");
    await keys(page, "g", "c");
    await page.keyboard.type("Five seconds is long for a probe; make it a flag?");
    await keys(page, "Control+Enter");

    const cell = page.locator('[data-file-section]:has([data-path="db/schema.sql"]) .row[data-nl="4"] .code[data-side="new"]');
    await cell.scrollIntoViewIfNeeded();
    const box = await cell.boundingBox();
    const end = await page.locator('[data-file-section]:has([data-path="db/schema.sql"]) .row[data-nl="5"] .code[data-side="new"]').boundingBox();
    await page.mouse.move(box.x + 5, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(end.x + 120, end.y + 8, { steps: 8 });
    await page.mouse.up();
    await sleep(200);
    check(await page.getByRole("button", { name: /^Comment/ }).first().isVisible(), "a mouse selection offers a Comment button");
    const bubble = await page.getByRole("button", { name: /^Comment/ }).first().boundingBox();
    check(
      Math.abs(bubble.x - (end.x + 120)) < 60 && bubble.y > end.y && bubble.y < end.y + end.height + 40,
      `it sits just below where the selection ends (${Math.round(bubble.x - end.x - 120)}px off)`,
    );
    await page.getByRole("button", { name: /^Comment/ }).first().click();
    await page.keyboard.type("Do we need a default for reset_at?");
    await keys(page, "Control+Enter");
    await page.waitForFunction((n) => document.querySelectorAll("[data-thread]").length >= n + 3, threadsBefore);
    check(true, "three threads were created");
    check((await page.getByText("Sent").count()) >= 1, "they show as Sent");
  });

  let batch;
  await section("The agent hears the comments and answers inline", async () => {
    batch = await agent.call("wait_for_feedback", { review_id: reviewId, timeout_seconds: 20 });
    check(batch.items.length === 3, `wait_for_feedback returned all three comments in one batch`);
    const probe = batch.items.find((i) => i.path === "cmd/probe/main.go");
    check(probe && probe.lines[0] === 11 && probe.lines[1] === 13 && probe.code.includes("client"), "with the exact lines and code");
    await page.waitForFunction(() => document.body.innerText.includes("Seen by Claude"));
    check(true, "the page shows the comments were seen");
    for (const item of batch.items) {
      await agent.call("reply", { thread_id: item.thread_id, body: `Good point about \`${item.path.split("/").pop()}\`. I'll handle it; see web/src/api.ts:16.` });
    }
    await page.waitForFunction(() => document.body.innerText.includes("Claude replied"));
    check(true, "replies appear inline, marked Claude replied");
    const unread = await page.locator("[role=tab] span.rounded-full").first().innerText();
    check(Number(unread) >= 3, `the activity feed counts ${unread} unread`);
    await shot(page, "replies");
    await keys(page, "]", "n");
    check((await status(page)).match(/api\.ts|main\.go|schema\.sql/), "]n jumps to the oldest unread reply");
    const link = page.locator('[data-thread] a[data-go]').first();
    await link.click();
    await sleep(200);
    check((await status(page)).includes("api.ts:16"), "path:line links in replies jump to the code");
  });

  await section("Chat with the agent", async () => {
    await keys(page, "Space", "i");
    await page.keyboard.type("Why keep the fixed-window limiter at all?");
    await page.keyboard.press("Enter");
    const chatBatch = await agent.call("wait_for_feedback", { review_id: reviewId, timeout_seconds: 20 });
    check(chatBatch.items.length === 1 && chatBatch.items[0].type === "chat", "the chat message reaches the agent");
    await agent.call("say", { review_id: reviewId, body: "It's gone now: I deleted it in src/legacy.rs:1. The token bucket covers both uses." });
    await page.waitForFunction(() => document.body.innerText.includes("covers both uses"));
    check(true, "the agent's answer shows in the chat");
    await page.locator('section[aria-label="Chat with Claude"] a[data-go]').click();
    await sleep(200);
    await shot(page, "chat");
  });

  await section("The agent shows you something", async () => {
    await page.locator(".buffer.focused").focus();
    await agent.call("show", { review_id: reviewId, file: "src/lib.rs", lines: [60, 62], message: "where refill is clamped" });
    await page.waitForSelector("text=wants to show you something");
    check(true, "a prompt appears instead of a jump");
    await shot(page, "nudge");
    await keys(page, "Enter");
    check((await status(page)).includes("lib.rs:60"), "enter takes you there");
    await keys(page, "Control+o");
  });

  await section("Live updates while you read", async () => {
    await cursorTo(page, "web/src/api.ts", 3);
    const vp = await viewport(page);
    const path = `${repo}/web/src/api.ts`;
    writeFileSync(path, readFileSync(path, "utf8").replace("resetAt: number;\n}", "resetAt: number;\n  /** Seconds until reset, from the server. */\n  retryAfter?: number;\n}"));
    const lib = `${repo}/src/lib.rs`;
    writeFileSync(lib, readFileSync(lib, "utf8").replace("// comment-free", ""));
    await page.waitForFunction(() => document.querySelector("header").innerText.includes("rev 2"), null, { timeout: 15000 });
    check(true, "the edit arrives as revision 2");
    const vp2 = await viewport(page);
    check(vp.key === vp2.key && Math.abs(vp.y - vp2.y) < 3, "the page didn't move");
    check((await page.locator(".num.since").count()) >= 2, "changed lines are marked since the last revision");
    check(await page.getByText("Revision 2").first().isVisible(), "the activity feed notes the revision");
    await shot(page, "live-update");
  });

  await section("The agent adds notes, a fold and test marks later", async () => {
    await agent.call("annotate", {
      review_id: reviewId,
      annotations: [{ file: "tools/logreport.py", lines: [14, 19], body: "Counter keeps the top offenders cheap even for big logs.", kind: "explain" }],
      regions: [{ file: "src/routes.rs", lines: [206, 206], kind: "fold", summary: "Adds the /api/v2/stream route at 100 req/s" }],
    });
    await page.waitForSelector("text=Adds the /api/v2/stream route");
    check(true, "a new fold appears with its summary");
    check((await page.getByText("Counter keeps the top offenders").count()) === 1, "and the new note appears inline");
  });

  await section("Pickers, search, help", async () => {
    await keys(page, "Space", "f");
    await page.keyboard.type("badge");
    await keys(page, "Enter");
    check((await status(page)).match(/QuotaBadge\.tsx|badge\.css/), "space f opens a file");
    await keys(page, "Space", "/");
    await page.keyboard.type("Retry-After");
    await sleep(150);
    check((await page.locator("[role=dialog] li").count()) >= 1, "space / finds text anywhere, hidden lines included");
    await keys(page, "Enter");
    check((await status(page)).includes("main.go"), "and jumps to it");
    check((await status(page)).includes("Retry-After · 1 of"), "saying which match of how many");
    check(await page.evaluate(() => (CSS.highlights.get("search-current")?.size ?? 0) === 1), "the match is highlighted");
    await keys(page, "n");
    check(/Retry-After · \d+ of/.test(await status(page)), "n goes to the next match");
    // `/`: like vim, from the cursor in this file, as you type; enter goes back to the code.
    await keys(page, "Escape", "/");
    check(await page.getByRole("search", { name: "Find" }).isVisible(), "/ opens the find bar");
    await page.keyboard.type("err");
    await sleep(150);
    check((await status(page)).includes("main.go"), "and finds the nearest match in this file as you type");
    await keys(page, "Enter");
    check(!(await page.getByRole("search", { name: "Find" }).isVisible()), "enter closes it, staying on the match");
    const at = await status(page);
    await keys(page, "n");
    check((await status(page)) !== at && (await status(page)).includes("main.go"), "n goes to the next one in the file");
    await keys(page, "Shift+N");
    check((await status(page)).startsWith(at.slice(0, 20)), "N back");
    await keys(page, "Escape");
    check(await page.evaluate(() => (CSS.highlights.get("search")?.size ?? 0) === 0), "esc clears the highlights");
    await keys(page, "g", "S");
    await page.keyboard.type("Limiter");
    check((await page.locator("[role=dialog] li").count()) >= 1, "gS lists symbols across the diff");
    await keys(page, "Escape", "?");
    check(await page.getByText("Keys").first().isVisible(), "? shows every key");
    await shot(page, "help");
    await keys(page, "Escape");
  });

  await section("Drawers, viewed files, resolving", async () => {
    const handle = page.locator('[role=separator][aria-label="Resize files"]');
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + 3, hb.y + 200);
    await page.mouse.down();
    await page.mouse.move(40, hb.y + 200, { steps: 6 });
    await page.mouse.up();
    check(!(await page.locator("nav[aria-label='Changed files']").isVisible()), "dragging the tree to the edge leaves only a handle");
    await shot(page, "drawer-closed");
    await handle.click();
    check(await page.locator("nav[aria-label='Changed files']").isVisible(), "clicking the handle brings it back");
    const viewed = page.locator('[data-file-section]:has([data-path="db/schema.sql"]) input[type=checkbox]');
    await viewed.check();
    check((await page.locator('[data-file-section]:has([data-path="db/schema.sql"]) .row').count()) === 0, "marking a file viewed collapses it");
    await page.locator("[data-thread] button", { hasText: "Resolve" }).first().click();
    await page.waitForFunction(() => document.body.innerText.includes("RESOLVED") || document.body.innerText.toLowerCase().includes("resolved"));
    check(true, "resolving a thread marks it resolved");
  });

  await section("Splits", async () => {
    const panes = () => page.locator(".buffer").count();
    const inPane = (n, sel) => page.locator(`.buffer >> nth=${n}`).locator(sel);
    await cursorTo(page, "src/lib.rs", 50);
    const left = await at(page);
    const vp = await viewport(page);
    await keys(page, "Control+Backslash");
    check((await panes()) === 2, "ctrl-\\ splits the view in two");
    check((await page.locator(".buffer.focused").getAttribute("data-pane")) !== "0", "the new split has focus");
    const vp2 = await viewport(page);
    check(vp && vp2 && vp.key === vp2.key && Math.abs(vp.y - vp2.y) < 3, "and opens at the same place");
    check((await at(page)) === left, "with the same cursor");

    await keys(page, "]", "f");
    const right = await at(page);
    check(right !== left, `]f moves only this split's cursor (${right})`);
    await keys(page, "Control+h");
    check((await at(page)) === left, "ctrl-h focuses the left split, with its own cursor");
    await keys(page, "Control+l");
    check((await at(page)) === right, "ctrl-l back to the right one");

    // g space: the file itself, in the split beside this one.
    await keys(page, "Control+h");
    await keys(page, "g", "Space");
    check((await status(page)).includes("FILE"), "g space opens the plain file");
    check((await inPane(1, ".fv").count()) === 1 && (await inPane(0, ".fv").count()) === 0, "in the other split; this one keeps the diff");
    check((await at(page)) === left, "at the same line");
    await shot(page, "split-file");
    await keys(page, "Control+o");
    check(!(await status(page)).includes("FILE") && (await inPane(1, ".fv").count()) === 0, "ctrl-o takes that split back to its diff");

    // Commenting in one split shows the thread in both and moves neither.
    await keys(page, "Control+h");
    /** The other split's scroll position and the row at its top. */
    const other = () =>
      page.evaluate(() => {
        const buf = document.querySelectorAll(".buffer")[1];
        const top = buf.getBoundingClientRect().top + 34;
        const row = [...buf.querySelectorAll(".row")].find((r) => r.getBoundingClientRect().bottom > top);
        return { scroll: buf.scrollTop, row: row && `${row.dataset.f}:${row.dataset.r}@${Math.round(row.getBoundingClientRect().top)}` };
      });
    const otherBefore = await other();
    await cursorTo(page, "src/bucket.rs", 3);
    await keys(page, "g", "c", "c");
    await page.keyboard.type("Commented from the left split.");
    await keys(page, "Control+Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".buffer")].every((b) => b.textContent.includes("Commented from the left split.")));
    check(true, "a comment in one split shows up in both");
    const otherAfter = await other();
    check(otherAfter.row === otherBefore.row, `and the other split didn't move (${JSON.stringify(otherBefore)} → ${JSON.stringify(otherAfter)})`);
    const heard = await agent.call("wait_for_feedback", { review_id: reviewId, timeout_seconds: 20 });
    check(heard.items.some((i) => i.path === "src/bucket.rs" && i.new[0] === "Commented from the left split."), "the agent hears it");

    // Clicking a split focuses it.
    const second = await page.locator(".buffer").nth(1).getAttribute("data-pane");
    await cursorTo(page, "src/lib.rs", 45, "new", `.buffer[data-pane="${second}"]`);
    check((await page.locator(".buffer.focused").getAttribute("data-pane")) === second, "clicking in a split focuses it");
    check((await at(page)).startsWith("lib.rs"), "and puts the cursor there");

    await keys(page, "Control+Escape");
    check((await panes()) === 1, "ctrl-esc closes the focused split");
    await keys(page, "Control+Escape");
    check((await status(page)).includes("only split"), "the last split stays");

    // With one split, g space makes the second.
    await cursorTo(page, "web/src/api.ts", 16);
    await keys(page, "g", "Space");
    check((await panes()) === 2 && (await inPane(1, ".fv").count()) === 1, "g space splits when there's only one");
    await keys(page, "Control+Escape");
    check((await panes()) === 1, "and closes again");
  });

  await section("Files outside the diff", async () => {
    await page.locator('[data-tree-file="web/src/api.ts"]').click();
    await page.waitForSelector('[data-neighbour="web/src/format.ts"]');
    check(true, "opening a file in the tree lists the other files in its folder");
    check((await page.locator('[data-neighbour="web/src/api.ts"]').count()) === 0, "files in the diff aren't listed twice");

    await page.locator('[data-neighbour="web/src/format.ts"]').click();
    await page.waitForFunction(() => document.querySelector(".buffer.focused .fv")?.textContent.includes("formatSeconds"));
    check((await status(page)).includes("FILE"), "clicking one opens it as a plain file");
    check(await page.getByText("opened for context").isVisible(), "marked as not part of the diff");
    check((await page.locator(".buffer.focused .fv .s-keyword").count()) > 3, "highlighted like the rest");
    check((await page.locator('[data-tree-file="web/src/format.ts"]').count()) === 1, "and it joins the tree");

    await page.locator('.buffer.focused .fv .row[data-nl="3"] .code').click({ position: { x: 4, y: 4 } });
    await keys(page, "g", "c", "c");
    await page.keyboard.type("Should hours get their own unit?");
    await keys(page, "Control+Enter");
    await page.waitForFunction(() => document.querySelector(".buffer.focused .fv [data-thread]")?.textContent.includes("own unit"));
    check(true, "comments work on it, and show inline");
    const got = await agent.call("wait_for_feedback", { review_id: reviewId, timeout_seconds: 20 });
    const item = got.items.find((i) => i.path === "web/src/format.ts");
    check(item && item.lines[0] === 3 && item.code.includes("if (total < 60)"), `the agent gets the file, line and code (${item?.code})`);
    await agent.call("reply", { thread_id: item.thread_id, body: "Not yet: the badge never shows more than an hour." });
    await page.waitForFunction(() => document.body.textContent.includes("never shows more than an hour"));
    check(true, "and its reply shows there too");
    check((await page.locator('[data-tree-file="web/src/format.ts"]').innerText()).includes("◆1"), "the tree counts the thread");

    await agent.call("show", { review_id: reviewId, file: "src/clock.rs", lines: [7, 9], message: "The Clock trait limiters take" });
    await page.getByText("The Clock trait limiters take").waitFor();
    await keys(page, "Enter");
    await page.waitForFunction(() => document.querySelector(".buffer.focused .fv")?.textContent.includes("pub trait Clock"));
    check((await at(page)) === "clock.rs", "the agent can show a file that isn't in the diff");
    check((await status(page)).includes("clock.rs:7"), "at the lines it chose");
    await keys(page, "Control+o");
    await keys(page, "Control+o");
    check(!(await status(page)).includes("FILE"), "ctrl-o walks back to the diff");

    const probe = page.locator('[aria-label="Other files in cmd/probe/"]');
    await probe.click({ force: true });
    await page.waitForSelector('[data-neighbour="cmd/probe/flags.go"]');
    check(true, "a folder's ⋯ lists everything in it");
    await probe.click({ force: true });
    check((await page.locator('[data-neighbour="cmd/probe/flags.go"]').count()) === 0, "and hides them again");

    const seen = new Set();
    await keys(page, "g", "g");
    for (let i = 0; i < 25; i++) {
      await keys(page, "]", "f");
      seen.add(await at(page));
    }
    check(!seen.has("format.ts") && !seen.has("clock.rs"), "]f only walks the diff");
  });

  await section("Marks", async () => {
    await cursorTo(page, "cmd/probe/main.go", 11);
    await keys(page, "m", "a");
    check((await page.locator("section[aria-label='Marks']").innerText()).includes("main.go:11"), "m a lists the mark");
    check((await page.locator(".mk").count()) >= 1, "and shows its letter in the gutter");
    await keys(page, "g", "g");
    await keys(page, "'", "a");
    check((await status(page)).includes("main.go:11"), "'a jumps back to it");
    await keys(page, "g", "g");
    await keys(page, "`", "a");
    check((await status(page)).includes("main.go:11"), "`a too");
    await keys(page, "'", "z");
    check((await status(page)).includes("No mark z"), "an unset mark says so");
  });

  await section("Text objects", async () => {
    const lineOf = (path, needle) => readFileSync(`${repo}/${path}`, "utf8").split("\n").findIndex((l) => l.includes(needle)) + 1;
    const selected = () => page.locator(".buffer.focused .row.vsel").count();
    const take = lineOf("src/lib.rs", "self.tokens -= 1;");
    const acquire = lineOf("src/lib.rs", "pub fn acquire");
    const acquireEnd = lineOf("src/lib.rs", "fn refill") - 2;

    await cursorTo(page, "src/lib.rs", take);
    await keys(page, "v", "a", "f");
    check((await selected()) === acquireEnd - acquire + 1, `vaf selects the whole function (${await selected()} lines)`);
    await keys(page, "g", "c");
    const quote = await page.getByRole("dialog", { name: "Write a comment" }).locator("pre").innerText();
    check(quote.trim().startsWith("pub fn acquire"), "and gc comments on it");
    await keys(page, "Escape");
    await keys(page, "Escape");

    await cursorTo(page, "src/lib.rs", take);
    await keys(page, "v", "i", "{");
    check((await selected()) === 2, `vi{ selects inside the braces (${await selected()} lines)`);
    await keys(page, "Escape");
    await cursorTo(page, "src/lib.rs", take);
    await keys(page, "v", "a", "B");
    check((await selected()) === 4, "vaB takes the braces' lines too");
    await keys(page, "Escape");

    await cursorTo(page, "src/lib.rs", take);
    await keys(page, "v", "i", "p");
    check((await selected()) === acquireEnd - acquire + 2, `vip selects the paragraph (${await selected()} lines)`);
    await keys(page, "Escape");

    const badge = lineOf("web/src/QuotaBadge.tsx", "left (+");
    await cursorTo(page, "web/src/QuotaBadge.tsx", badge);
    await keys(page, "v", "a", "t");
    check((await selected()) === 4, `vat selects the enclosing element (${await selected()} lines)`);
    await keys(page, "Escape");

    await cursorTo(page, "src/lib.rs", 1);
    await keys(page, "v", "i", "h");
    check((await selected()) >= 1 && (await status(page)).includes("VISUAL"), "vih selects the hunk");
    await keys(page, "Escape");
  });

  await section("Offline comments queue and send on reconnect", async () => {
    const { stop, start } = serverControl;
    if (!stop || !start) {
      log("(skipped: set DIFFD_E2E_STOP and DIFFD_E2E_START to test a server restart)");
      return;
    }
    execSync(stop);
    const presence = page.locator("#presence");
    await page.waitForFunction(() => document.getElementById("presence")?.innerText.startsWith("Offline"));
    check(true, "the page notices the server is gone");

    await cursorTo(page, "web/src/api.ts", 18);
    const vp = await viewport(page);
    await keys(page, "g", "c", "c");
    await page.keyboard.type("Written while the server was down.");
    await keys(page, "Control+Enter");
    await page.waitForFunction(() => document.body.innerText.includes("Written while the server was down."));
    const vp2 = await viewport(page);
    check(vp.key === vp2.key && Math.abs(vp.y - vp2.y) < 3, "an offline comment shows inline without moving the page");
    check(await page.getByText("Queued offline").first().isVisible(), "it is marked Queued offline");
    await keys(page, "Space", "i");
    await page.keyboard.type("Are you still there?");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    check((await presence.innerText()).includes("2 queued"), `the top bar counts what's queued: "${await presence.innerText()}"`);
    const stored = await page.evaluate(
      (id) =>
        Object.keys(localStorage)
          .filter((k) => k.startsWith(`diffd:outbox:${id}:`))
          .map((k) => localStorage.getItem(k))
          .join(""),
      reviewId,
    );
    check(stored.includes("Written while the server was down.") && stored.includes("Are you still there?"), "the outbox is saved to localStorage");
    await shot(page, "offline");

    execSync(start);
    await page.waitForFunction(() => !/Offline|Connecting|queued/.test(document.getElementById("presence")?.innerText ?? ""), null, { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-pending]").length === 0, null, { timeout: 10_000 });
    check(true, "on reconnect everything is sent and confirmed");
    agent = new Agent(`${base}/mcp`);
    await agent.init();
    const got = await agent.call("wait_for_feedback", { review_id: reviewId, timeout_seconds: 20 });
    const kinds = got.items.map((i) => i.type).sort().join(",");
    check(got.items.length === 2 && kinds === "chat,thread", `the agent receives the queued comment and chat (${kinds})`);

    // Leave a comment half-written, then reload.
    await cursorTo(page, "cmd/probe/main.go", 12);
    await keys(page, "g", "c", "c");
    await page.keyboard.type("Half-written thought");
    const before = await at(page);
    const shownRows = () => page.locator("[data-file-section]:has([data-path='src/routes.rs']) .row:not(.gap-body[hidden] .row)").count();
    const routesBefore = await shownRows();
    const rowTop = () =>
      page.evaluate(() => document.querySelector("[data-file-section]:has([data-path='cmd/probe/main.go']) .row[data-nl='12']")?.getBoundingClientRect().top ?? -1);
    const topBefore = await rowTop();
    await sleep(600);
    await page.reload();
    await page.waitForSelector("[data-thread]");
    await sleep(300);
    check((await at(page)) === before, `the cursor comes back to ${before}`);
    const topAfter = await rowTop();
    check(Math.abs(topAfter - topBefore) < 4, `and the page is where you were reading (${topBefore} → ${topAfter})`);
    const draft = page.getByRole("dialog", { name: "Write a comment" }).locator("textarea");
    check((await draft.inputValue()) === "Half-written thought", "the half-written comment is still there");
    check((await shownRows()) === routesBefore, `lines you expanded stay expanded (${routesBefore} → ${await shownRows()} rows of routes.rs)`);
    await keys(page, "Escape");
    await keys(page, "Escape");
    const copies = await page.getByText("Written while the server was down.").count();
    check(copies === 1, "after a reload the comment exists exactly once");
    check((await page.locator("section[aria-label='Marks']").innerText()).includes("main.go:11"), "marks survive a reload");
    await page.waitForSelector('[data-tree-file="web/src/format.ts"]');
    check(true, "files outside the diff with threads come back after a reload");
  });

  await section("Several tabs at once", async () => {
    const other = await page.context().newPage();
    other.on("pageerror", (e) => errors.push(`tab 2: ${e.message}`));
    await other.goto(reviewUrl);
    await other.waitForSelector("[data-file-section]");
    await other.waitForFunction(() => !/Offline|Connecting/.test(document.getElementById("presence")?.innerText ?? ""));
    const tabIds = await Promise.all([page, other].map((p) => p.evaluate(() => sessionStorage.getItem("diffd:tab"))));
    check(tabIds[0] && tabIds[1] && tabIds[0] !== tabIds[1], "each tab gets its own id");

    // A comment in one tab shows in the other, live.
    await other.bringToFront();
    await cursorTo(other, "src/bucket.rs", 6);
    await keys(other, "g", "c", "c");
    await other.keyboard.type("From the second tab.");
    await keys(other, "Control+Enter");
    await page.waitForFunction(() => document.body.textContent.includes("From the second tab."));
    check(true, "a comment in one tab appears in the other");
    await agent.call("wait_for_feedback", { review_id: reviewId, timeout_seconds: 20 });

    // Marks and viewed files are shared between tabs, without clobbering.
    await page.bringToFront();
    await cursorTo(page, "src/bucket.rs", 2);
    await keys(page, "m", "b");
    await other.waitForFunction(() => document.querySelector("section[aria-label='Marks']")?.textContent.includes("bucket.rs:2"));
    check(true, "a mark set in one tab shows in the other");
    await other.bringToFront();
    await cursorTo(other, "src/bucket.rs", 3);
    await keys(other, "m", "c");
    await page.waitForFunction(() => document.querySelector("section[aria-label='Marks']")?.textContent.includes("bucket.rs:3"));
    const marksText = await page.locator("section[aria-label='Marks']").innerText();
    check(marksText.includes("bucket.rs:2") && marksText.includes("bucket.rs:3"), "and neither tab's marks overwrite the other's");

    // A duplicated tab (same sessionStorage) doesn't share the original's id.
    const dup = await page.context().newPage();
    await dup.addInitScript((id) => sessionStorage.setItem("diffd:tab", id), tabIds[0]);
    await dup.goto(reviewUrl);
    await dup.waitForSelector("[data-file-section]");
    await dup.waitForFunction((id) => sessionStorage.getItem("diffd:tab") !== id, tabIds[0]);
    check(true, "a duplicated tab picks a new id");
    await dup.close();

    // Offline in both tabs; one closes before the server's back. Nothing is lost.
    const { stop, start } = serverControl;
    if (!stop || !start) return log("(offline part skipped: no server control)");
    execSync(stop);
    for (const p of [page, other]) await p.waitForFunction(() => document.getElementById("presence")?.innerText.startsWith("Offline"));
    await page.bringToFront();
    await cursorTo(page, "src/bucket.rs", 7);
    await keys(page, "g", "c", "c");
    await page.keyboard.type("Offline in tab one.");
    await keys(page, "Control+Enter");
    await other.bringToFront();
    await cursorTo(other, "src/bucket.rs", 8);
    await keys(other, "g", "c", "c");
    await other.keyboard.type("Offline in tab two, which then closes.");
    await keys(other, "Control+Enter");
    await other.waitForFunction(() => document.body.textContent.includes("Queued offline"));
    await sleep(300);
    await other.close();
    await page.bringToFront();
    execSync(start);
    await page.waitForFunction(
      () => document.body.textContent.includes("which then closes") && document.querySelectorAll("[data-pending]").length === 0,
      null,
      { timeout: 20_000 },
    );
    check(true, "the open tab sends its own queued comment and the closed tab's");
    agent = new Agent(`${base}/mcp`);
    await agent.init();
    const got = await agent.call("wait_for_feedback", { review_id: reviewId, timeout_seconds: 20 });
    const bodies = got.items.flatMap((i) => i.new ?? []);
    check(bodies.includes("Offline in tab one.") && bodies.includes("Offline in tab two, which then closes."), "the agent gets both");
    const left = await page.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith(`diffd:outbox:${id}`)).length, reviewId);
    check(left === 0, "and no outbox is left behind");
  });

  await section("Walking the commits one at a time", async () => {
    await page.getByRole("tab", { name: /Commits/ }).click();
    const commits = page.locator("nav[aria-label='Commits'] li button");
    check((await commits.count()) === 5, "the commits panel lists all changes, three commits and uncommitted changes");
    const paths = () => page.$$eval("[data-file-section] [data-path]", (els) => els.map((e) => e.dataset.path));
    const chip = () => page.locator("header").innerText();
    const all = (await paths()).length;

    await page.locator(".buffer.focused").focus();
    await keys(page, "]", "r");
    // The chip shows the commit at once; its diff follows.
    await page.waitForFunction(() => document.querySelector("header").innerText.includes("×"));
    await spanReady(page);
    await page.waitForFunction((all) => document.querySelectorAll("[data-file-section] [data-path]").length < all, all);
    let shown = await paths();
    check(
      JSON.stringify(shown) === JSON.stringify(["src/bucket.rs", "src/legacy.rs", "src/lib.rs", "tests/limiter.rs", "Cargo.lock"]),
      `]r shows only the first commit's files: ${shown.join(", ")}`,
    );
    check((await page.locator("[data-tree-file]:not([data-context])").count()) === 5, "the file tree follows");
    check((await page.locator("[data-thread]").count()) > 0, "Claude's notes on that code still show");
    await shot(page, "commit-1");

    await keys(page, "]", "r");
    await page.waitForFunction(() => document.querySelector("[data-path='web/src/api.ts']"));
    shown = await paths();
    check(shown.every((p) => p.startsWith("web/")), "]r again shows the second commit");
    check(await page.getByText("Should an aborted request count").first().isVisible().catch(() => false) || (await page.getByText("Should an aborted request count").count()) > 0,
      "an earlier comment shows where its code is in this commit");

    await cursorTo(page, "web/src/api.ts", 3);
    await keys(page, "g", "c", "c");
    await page.keyboard.type("Commented while looking at just this commit.");
    await keys(page, "Control+Enter");
    await page.waitForFunction(() => document.body.innerText.includes("Commented while looking at just this commit."));
    const got = await agent.call("wait_for_feedback", { review_id: reviewId, timeout_seconds: 20 });
    const item = got.items.find((i) => i.type === "thread");
    check(item && /\.\./.test(item.commented_on ?? "") && item.path === "web/src/api.ts", `the agent hears which commit it was on (${item?.commented_on})`);
    await agent.call("reply", { thread_id: item.thread_id, body: "Noted, that's from the badge commit." });
    await page.waitForFunction(() => document.body.innerText.includes("from the badge commit"));
    check(true, "the reply shows up while you're still on that commit");

    await commits.nth(3).click({ modifiers: ["Shift"] });
    await page.waitForFunction(() => document.querySelector("[data-path='cmd/probe/main.go']"));
    shown = await paths();
    check(shown.some((p) => p.startsWith("web/")) && shown.includes("db/schema.sql"), "shift-click takes in the next commit too");
    check((await chip()).includes(".."), "the top bar shows the range");

    await keys(page, "]", "r");
    await keys(page, "]", "r");
    await page.waitForFunction(() => document.querySelector("header").innerText.includes("Uncommitted"));
    await spanReady(page);
    shown = await paths();
    check(shown.includes("flake.nix") && !shown.includes("cmd/probe/main.go"), "the last step is the uncommitted changes");
    await shot(page, "uncommitted");

    await keys(page, "]", "r");
    await page.waitForFunction(() => !document.querySelector("header").innerText.includes("×"));
    await spanReady(page);
    check((await paths()).length === all, "past the last step it's all changes again");

    // The agent commits: the review's diff stays the same, the history grows.
    execFileSync("git", ["-C", repo, "commit", "-q", "-am", "Tidy up the README and flake"]);
    await page.waitForFunction(() => document.querySelectorAll("nav[aria-label='Commits'] li button").length === 6, null, { timeout: 15000 });
    check(true, "a new commit appears in the panel by itself");
    check((await paths()).length === all, "and the whole diff is unchanged");

    await keys(page, "Space", "c");
    check(await page.getByText("Tidy up the README and flake").last().isVisible(), "space c picks from the commits");
    await keys(page, "Escape");
  });

  await section("Language servers: diagnostics, go to definition, hover", async () => {
    const servers = ["rust-analyzer", "typescript-language-server", "pyright-langserver", "gopls", "nil", "yaml-language-server"];
    const missing = servers.filter((s) => {
      try {
        execSync(`command -v ${s}`, { stdio: "ignore", shell: "/bin/sh" });
        return false;
      } catch {
        return true;
      }
    });
    if (missing.length > 0) return log(`(skipped: ${missing.join(", ")} not installed)`);
    // Like any TypeScript project, the web app has its own `typescript` (ignored by git).
    const ts = execSync("npm root -g").toString().trim() + "/typescript";
    mkdirSync(`${repo}/web/node_modules`, { recursive: true });
    try {
      symlinkSync(ts, `${repo}/web/node_modules/typescript`);
    } catch {}
    const append = (path, text) => writeFileSync(`${repo}/${path}`, readFileSync(`${repo}/${path}`, "utf8") + text);
    const lines = (path) => readFileSync(`${repo}/${path}`, "utf8").split("\n").length;
    // The agent keeps working, and breaks something in every language.
    const apiLine = lines("web/src/api.ts");
    append("web/src/api.ts", 'import { formatSeconds } from "./format";\nexport const waitLabel = (q: Quota): string => formatSeconds(q.resetAt);\nexport const broken: number = "not a number";\n');
    append("src/bucket.rs", '\npub fn broken() -> u32 {\n    "not a number"\n}\n');
    append("cmd/probe/main.go", '\nfunc broken() int {\n\treturn "not a number"\n}\n');
    append("tools/logreport.py", "\nBROKEN = undefined_name\n");
    writeFileSync(`${repo}/flake.nix`, "{\n  outputs = { self }: {\n    broken = missingName;\n  };\n}\n");
    append(".github/workflows/ci.yml", "  bad: [\n");
    const broken = ["web/src/api.ts", "src/bucket.rs", "cmd/probe/main.go", "tools/logreport.py", "flake.nix", ".github/workflows/ci.yml"];
    for (const path of broken) {
      await page.waitForSelector(`[data-problems="${path}"]`, { timeout: 90_000 });
      log(`✓ ${path}: ${await page.locator(`[data-problems="${path}"]`).innerText()}`);
    }
    check(true, "every language's errors show in the tree");
    const squiggles = await page.evaluate(() => CSS.highlights.get("diag-error")?.size ?? 0);
    check(squiggles >= 4, `errors are underlined in the code (${squiggles} ranges)`);
    await shot(page, "diagnostics");

    await page.locator('[data-tree-file="web/src/api.ts"]').click();
    await cursorTo(page, "web/src/api.ts", apiLine + 2);
    await page.waitForSelector("[data-line-diagnostic]");
    check((await page.locator("[data-line-diagnostic]").innerText()).includes("not assignable"), "the status bar shows the error on the cursor's line");
    const word = page.locator('[data-file-section]:has([data-path="web/src/api.ts"]) .row[data-nl="' + (apiLine + 2) + '"] .code[data-side="new"]');
    const at = await word.evaluate((el) => {
      const text = el.firstChild ? el.textContent : "";
      const i = text.indexOf("broken");
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (i < seen + n.textContent.length) {
          const r = document.createRange();
          r.setStart(n, i - seen + 2);
          r.setEnd(n, i - seen + 3);
          const b = r.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }
        seen += n.textContent.length;
      }
      return null;
    });
    await page.mouse.move(at.x, at.y);
    await page.waitForSelector("[data-hover]", { timeout: 10_000 });
    check((await page.locator("[data-hover]").innerText()).toLowerCase().includes("error"), "hovering the error explains it");
    await page.mouse.move(5, 5);
    await keys(page, "Escape");

    // gd through the language server reaches a file that isn't in the diff.
    await cursorTo(page, "web/src/api.ts", apiLine + 1);
    for (let i = 0; i < 12 && !(await status(page)).includes("· formatSeconds"); i++) await keys(page, "w");
    await keys(page, "g", "d");
    await page.waitForFunction(() => document.querySelector(".buffer.focused .fv")?.textContent.includes("export function formatSeconds"), null, { timeout: 30_000 });
    check((await status(page)).includes("format.ts:2"), "gd goes where the language server says, even outside the diff");
    await keys(page, "Control+o");

    // Into a library outside the repository (Go's standard library), and to a type's definition.
    await cursorTo(page, "cmd/probe/main.go", 11);
    for (let i = 0; i < 12 && !(await status(page)).includes("· Client"); i++) await keys(page, "w");
    await keys(page, "g", "d");
    await page.waitForFunction(() => document.querySelector(".buffer.focused .fv")?.textContent.includes("type Client struct"), null, { timeout: 30_000 });
    check(true, "gd opens library code outside the repository");
    await keys(page, "Control+o");
    await cursorTo(page, "cmd/probe/main.go", 12);
    for (let i = 0; i < 6 && !(await status(page)).includes("· resp"); i++) await keys(page, "w");
    await keys(page, "g", "t");
    await page.waitForFunction(() => document.querySelector(".buffer.focused .fv")?.textContent.includes("type Response struct"), null, { timeout: 30_000 });
    check(true, "gt goes to the type's definition");
    await keys(page, "Control+o");

    // K: docs from the language server.
    const fetchLine = readFileSync(`${repo}/web/src/api.ts`, "utf8").split("\n").findIndex((l) => l.includes("function fetchQuota")) + 1;
    await cursorTo(page, "web/src/api.ts", fetchLine);
    for (let i = 0; i < 12 && !(await status(page)).includes("· fetchQuota"); i++) await keys(page, "w");
    await keys(page, "K");
    await page.waitForSelector("[data-hover]", { timeout: 20_000 });
    check((await page.locator("[data-hover]").innerText()).includes("fetchQuota"), "K shows the language server's docs");
    await keys(page, "Escape");

    // The old side has no language server: gd uses the diff's own symbols.
    await cursorTo(page, "web/src/api.ts", 6, "old");
    for (let i = 0; i < 12 && !(await status(page)).includes("· fetchQuota"); i++) await keys(page, "w");
    await keys(page, "g", "d");
    check(await statusSoon(page, "Definition of fetchQuota"), "on the old side, gd falls back to the diff's symbols");
  });

  await section("Right-click menu, context around a hunk, chat panel, tree neighbours", async () => {
    await page.keyboard.press("Escape");
    // Right-click a symbol: the language-server actions for it.
    const ref = page.locator('.buffer.focused [data-file-section]:has([data-path$="bucket.rs"]) .code[data-side="new"] .ref').first();
    await ref.scrollIntoViewIfNeeded();
    const name = (await ref.textContent()).trim();
    await ref.click({ button: "right" });
    const menu = page.getByRole("menu");
    check(await menu.isVisible(), "right-clicking code opens a menu");
    check((await menu.innerText()).includes(name), `it's about the symbol clicked (${name})`);
    const labels = await menu.getByRole("menuitem").allInnerTexts();
    check(["Go to definition", "Go to type definition", "Find references", "Docs and errors"].every((l) => labels.some((x) => x.startsWith(l))), "with go to definition, type definition, references and docs");
    await page.keyboard.press("Escape");
    check(!(await menu.isVisible()), "escape closes it");
    await ref.click({ button: "right" });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForSelector('section[aria-label="Quickfix list"]', { timeout: 20000 });
    check(true, "arrow keys and enter pick an item (find references lists them under the code, not in a popup)");
    await page.locator(".buffer.focused").focus();
    await keys(page, "Space", "q");

    // Ctrl+Enter: more lines above and below the hunk; Ctrl+Shift+Enter: fewer again.
    const shown = () =>
      page.evaluate(() => {
        const sec = document.querySelector('.buffer.focused [data-file-section]:has([data-path$="routes.rs"])');
        return [...sec.querySelectorAll(".row")].filter((r) => !r.closest(".gap-body[hidden]")).length;
      });
    const changed = page.locator('.buffer.focused [data-file-section]:has([data-path$="routes.rs"]) .row[data-chg="1"] .code[data-side="new"]').first();
    await changed.scrollIntoViewIfNeeded();
    await changed.click({ position: { x: 4, y: 4 } });
    const before = await shown();
    await keys(page, "Control+Enter");
    const grown = await shown();
    check(grown > before, `ctrl+enter shows more lines around the hunk (${before} → ${grown})`);
    await keys(page, "Control+Shift+Enter");
    check((await shown()) < grown, "ctrl+shift+enter shows fewer again");

    // The chat sits at the bottom of the right panel, at a fixed share of it.
    const chat = page.getByRole("region", { name: /Chat with/ });
    const [panel, box] = await Promise.all([page.locator("#tabpanel-right").evaluate((e) => e.parentElement.getBoundingClientRect().height), chat.boundingBox()]);
    check(Math.abs(box.height / panel - 0.3) < 0.05, `the chat is 30% of the side panel (${Math.round((100 * box.height) / panel)}%)`);

    // Clicking a file in the tree shows its folder's other files; clicking it again hides them.
    const file = page.locator('[data-tree-file$="bucket.rs"]');
    await file.click();
    await page.waitForSelector("[data-neighbour]", { timeout: 5000 });
    check((await page.locator("[data-neighbour]").count()) > 0, "opening a file lists its neighbours");
    await file.click();
    await sleep(200);
    check((await page.locator("[data-neighbour]").count()) === 0, "clicking it again hides them");

    // The whole project, a click away; folders collapse and expand all at once.
    await page.getByRole("tab", { name: /^Project/ }).click();
    await page.waitForSelector('[data-neighbour="web/src/format.ts"], [data-tree-dir]', { timeout: 5000 });
    check((await page.getByRole("navigation", { name: "Project files" }).count()) === 1, "the Project tab lists the whole repository");
    await page.getByRole("button", { name: "Collapse all folders" }).click();
    check((await page.locator("[data-tree-file], [data-neighbour]").count()) === 0 || (await page.locator('[data-tree-dir][aria-expanded="true"]').count()) === 0, "collapse all closes every folder");
    await page.getByRole("button", { name: "Expand all folders" }).click();
    check((await page.locator('[data-tree-dir][aria-expanded="false"]').count()) === 0, "expand all opens them");
    check((await page.locator('[data-tree-file$="bucket.rs"]').count()) === 1, "changed files are marked in the project tree");
    await page.getByRole("tab", { name: /^Diff/ }).click();
    check((await page.getByRole("navigation", { name: "Changed files" }).count()) === 1, "and the Diff tab is back to the changes");

    // The files drawer is as wide as you drag it.
    const drawer = page.getByRole("complementary", { name: "Files" });
    const width = (await drawer.boundingBox()).width;
    const grip = page.getByRole("separator", { name: "Resize files" });
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + 3, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + 3 + 300, g.y + g.height / 2, { steps: 5 });
    await page.mouse.up();
    const wider = (await drawer.boundingBox()).width;
    check(wider > width + 250, `dragging its edge widens the files drawer (${Math.round(width)} → ${Math.round(wider)}px)`);
    await page.mouse.move(g.x + 303, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + 3, g.y + g.height / 2, { steps: 5 });
    await page.mouse.up();

    // "Claude replied" in the activity feed lands on the reply itself.
    const replied = page.locator("#tabpanel-right li", { hasText: "Claude replied" }).first();
    if (await replied.count()) {
      await page.getByRole("tab", { name: /^Activity/ }).click();
      await replied.click();
      await sleep(600);
      const onScreen = await page.evaluate(() => {
        const buf = document.querySelector(".buffer.focused").getBoundingClientRect();
        return [...document.querySelectorAll("[data-thread] [data-message]")].some((m) => {
          const r = m.getBoundingClientRect();
          return m.textContent.includes("Claude") && r.top >= buf.top && r.bottom <= buf.bottom;
        });
      });
      check(onScreen, "clicking “Claude replied” shows the reply");
    }
    await page.locator(".buffer.focused").focus();
  });

  await section("Codex: groups of related changes, labels, generated files, reply toasts", async () => {
    // Another agent shares the same changes, grouped and labelled.
    const codex = new Agent(`${base}/mcp`, "codex-mcp-client");
    await codex.init();
    const shared = await codex.call("share_diff", {
      repo_path: repo,
      from: "main",
      title: "Burst capacity, grouped",
      groups: [
        { title: "The limiter", summary: "Burst capacity and how long to wait.", files: ["src/lib.rs", "src/bucket.rs"] },
        { title: "The web badge", files: ["web/**"] },
        { title: "Storage", files: ["db"] },
      ],
      labels: [{ name: "frontend", files: ["web"] }],
    });
    check(shared.collapsed.includes("Cargo.lock"), "a lockfile starts collapsed without being asked");
    const overview = await codex.call("get_review", { review_id: shared.review_id });
    check(overview.tour.length === 3 && overview.labels[0].name === "frontend", "get_review gives the agent back its tour and labels");
    check(overview.files.find((f) => f.path === "tests/limiter.rs").kinds.includes("test"), "and what diffd found each file to be");
    await page.goto(shared.url);
    await page.waitForSelector(".buffer.focused [data-file-section]");
    check((await page.getByRole("region", { name: "Chat with Codex" }).count()) === 1, "the page calls the agent Codex");
    check(!(await page.locator("body").innerText()).includes("Claude"), "and never Claude");

    // New and deleted files: one column of ordinary code, centred, with a coloured header.
    const solo = await page.evaluate(() => {
      const secs = [...document.querySelectorAll(".buffer.focused [data-file-section]")];
      const added = secs.find((s) => s.querySelector("[data-file-head]").textContent.includes("New file"));
      const deleted = secs.find((s) => s.querySelector('[data-path="src/legacy.rs"]'));
      const rows = added?.querySelector(".solo");
      const sec = added?.getBoundingClientRect();
      const r = rows?.getBoundingClientRect();
      return {
        path: added?.querySelector("[data-path]").dataset.path,
        solo: rows?.classList.contains("solo-new"),
        oldCells: added?.querySelectorAll('[data-side="old"], .empty').length,
        novel: added?.querySelectorAll(".nv-add").length,
        centred: r && Math.abs(r.left - sec.left - (sec.right - r.right)) < 4 && r.width < sec.width * 0.7,
        deleted: deleted?.querySelector("[data-file-head]").textContent.includes("Deleted"),
      };
    });
    check(solo.path && solo.solo && solo.oldCells === 0, `a new file (${solo.path}) is one column, without an empty old side`);
    check(solo.novel === 0, "its code is highlighted as code, not all green");
    check(solo.centred, "centred, as wide as the new side of a split");
    check(solo.deleted, "a deleted file says so in its header");

    // Labels: tests (found by path), generated (found by path) and the agent's frontend.
    const chip = (label) => page.locator(`[data-label="${label}"]`);
    check((await chip("test").innerText()).includes("2"), "a test toggle counts the two test files");
    check((await chip("frontend").count()) === 1 && (await chip("generated").count()) === 1, "with frontend and generated toggles");
    const sections = () => page.locator(".buffer.focused [data-file-section] [data-path]").evaluateAll((els) => els.map((e) => e.dataset.path));
    const all = await sections();
    await chip("test").click();
    let now = await sections();
    check(!now.includes("tests/limiter.rs") && !now.includes("web/src/api.test.ts") && now.length === all.length - 2, "hiding tests takes their files out of the buffer");
    check((await page.locator('[data-tree-file="tests/limiter.rs"]').count()) === 0, "and out of the tree");
    await chip("frontend").click();
    now = await sections();
    check(!now.some((p) => p.startsWith("web/")), "hiding frontend takes out the web files");
    await chip("frontend").click();
    await chip("test").click();
    check((await sections()).length === all.length, "showing them again brings everything back");

    // The tour: a review the agent made one for opens on it, chapter by chapter, and ]f follows.
    check((await page.getByRole("tab", { name: /^Tour/ }).getAttribute("aria-selected")) === "true", "a review with a tour opens on it");
    const groups = await page.locator("[data-tree-group]").evaluateAll((els) => els.map((e) => e.dataset.treeGroup));
    check(JSON.stringify(groups) === JSON.stringify(["The limiter", "The web badge", "Storage", "Other changes"]), `the Tour tab lists the chapters, then the rest (${groups.join(", ")})`);
    const headers = await page.locator(".buffer.focused header[data-group]").evaluateAll((els) => els.map((e) => e.dataset.group));
    check(headers.length === 4 && headers[0] === "The limiter", "the buffer has a header per group");
    const order = await sections();
    check(order[0] === "src/lib.rs" && order[1] === "src/bucket.rs" && order[2].startsWith("web/"), `files follow the groups (${order.slice(0, 3).join(", ")})`);
    check(order.indexOf("db/schema.sql") < order.indexOf("Cargo.lock"), "ungrouped files come last");
    await page.locator(".buffer.focused").focus();
    await page.locator(".buffer.focused").evaluate((b) => b.scrollTo({ top: 0 }));
    await keys(page, "g", "g");
    await keys(page, "]", "f");
    check((await status(page)).includes("bucket.rs"), "]f goes to the next file in the group");
    await keys(page, "]", "f");
    const next = await status(page);
    check(/quota\.ts|QuotaBadge\.tsx|api\.ts|badge\.css/.test(next), `and on into the next group (${next.slice(0, 40)})`);
    check((await page.locator("[data-chapter-status]").innerText()) === "ch 2/4", "the status line says which chapter");
    await keys(page, "[", "g");
    check((await status(page)).includes("lib.rs"), "[g goes back to the start of the previous chapter");
    await keys(page, "]", "g");
    await keys(page, "]", "g");
    check((await status(page)).includes("schema.sql"), "]g steps chapter by chapter");
    const contents = await page.locator("nav[aria-label=Tour] [data-chapter]").allInnerTexts();
    check(contents.length === 4 && contents[1].includes("The web badge"), "the summary lists the chapters");
    await page.locator('nav[aria-label=Tour] [data-chapter="1"]').click();
    check((await page.locator("[data-chapter-status]").innerText()) === "ch 2/4", "and each one goes to its chapter");
    check((await page.locator('.buffer.focused header[data-group="The limiter"]').innerText()).includes("Burst capacity and how long to wait."), "a chapter starts with what it's about");
    await page.locator(".buffer.focused").focus();
    await keys(page, "Space", "t", "g");
    check((await page.locator(".buffer.focused header[data-group]").count()) === 0, "space t g goes back to the plain diff, in tree order");
    check((await page.getByRole("tab", { name: /^Diff/ }).getAttribute("aria-selected")) === "true", "on the Diff tab");

    // Codex answers a comment: a toast in the corner, which goes to the reply.
    await cursorTo(page, "src/bucket.rs", 1);
    await keys(page, "g", "c", "c");
    await page.keyboard.type("Is the burst per client?");
    await page.keyboard.press("Control+Enter");
    const got = await codex.call("wait_for_feedback", { review_id: shared.review_id, timeout_seconds: 20 });
    check(got.items.length === 1, "Codex receives the comment");
    await page.locator(".buffer.focused").evaluate((b) => b.scrollTo({ top: 0 }));
    await codex.call("reply", { thread_id: got.items[0].thread_id, body: "Yes: each client has its own bucket, burst included." });
    const toast = page.locator("[data-toast]").first();
    await toast.waitFor({ timeout: 5000 });
    check((await toast.innerText()).includes("Codex replied"), "a toast says Codex replied");
    check((await toast.innerText()).includes("each client has its own bucket"), "with the start of the reply");
    const box = await toast.boundingBox();
    const vp = page.viewportSize();
    check(box.x + box.width > vp.width * 0.5 && box.y + box.height > vp.height * 0.6, "in the bottom right");
    await shot(page, "reply-toast");
    await toast.getByRole("button", { name: /Go to the reply|Codex replied/ }).first().click();
    await sleep(600);
    const onScreen = await page.evaluate(() => {
      const buf = document.querySelector(".buffer.focused").getBoundingClientRect();
      return [...document.querySelectorAll("[data-thread] [data-message]")].some((m) => {
        const r = m.getBoundingClientRect();
        return m.textContent.includes("each client has its own bucket") && r.top >= buf.top && r.bottom <= buf.bottom;
      });
    });
    check(onScreen, "clicking the toast shows the reply");
    check((await page.locator("[data-toast]").count()) === 0, "and the toast goes");
    await codex.call("say", { review_id: shared.review_id, body: "I'll add a test for it." });
    await page.locator('[data-toast="agentSaid"]').waitFor({ timeout: 5000 });
    check((await page.locator('[data-toast="agentSaid"]').innerText()).includes("in the chat"), "chat answers get a toast too");
  });

  await section("Vim screen motions: zz zt zb, H M L, ctrl-e ctrl-y, 12G, '', uppercase marks", async () => {
    await freshPage(page);
    await page.waitForSelector(".buffer.focused .row");
    await cursorTo(page, "src/lib.rs", 45);
    const cur = () =>
      page.evaluate(() => {
        const buf = document.querySelector(".buffer.focused").getBoundingClientRect();
        const row = document.querySelector(".buffer.focused .row.cur")?.getBoundingClientRect();
        return row ? { top: row.top - buf.top, bottom: buf.bottom - row.bottom, mid: row.top + row.height / 2 - (buf.top + buf.height / 2) } : null;
      });
    await keys(page, "z", "z");
    await sleep(150);
    check(Math.abs((await cur()).mid) < 40, "zz puts the cursor's line in the middle");
    await keys(page, "z", "t");
    await sleep(150);
    check((await cur()).top < 70, "zt puts it at the top, under the file header");
    await keys(page, "z", "b");
    await sleep(150);
    check((await cur()).bottom < 40, "zb puts it at the bottom");
    await keys(page, "H");
    check((await cur()).top < 80, "H goes to the top line on screen");
    await keys(page, "L");
    check((await cur()).bottom < 60, "L to the bottom one");
    await keys(page, "M");
    check(Math.abs((await cur()).mid) < 60, "M to the middle one");
    const before = await page.locator(".buffer.focused").evaluate((b) => b.scrollTop);
    await keys(page, "5", "Control+e");
    const after = await page.locator(".buffer.focused").evaluate((b) => b.scrollTop);
    check(after - before > 60, `5 ctrl-e scrolls five lines down (${Math.round(after - before)}px)`);
    await keys(page, "5", "Control+y");
    check(Math.abs((await page.locator(".buffer.focused").evaluate((b) => b.scrollTop)) - before) < 3, "ctrl-y scrolls back");
    const here = await status(page);
    await keys(page, "m", "Shift+T");
    await keys(page, "g", "g");
    check(!(await status(page)).includes(here.match(/\S+:\d+/)[0]), "gg moves away");
    await keys(page, "'", "Shift+T");
    check((await status(page)).includes(here.match(/\S+:\d+/)[0]), "an uppercase mark (mT, 'T) comes back");
    await keys(page, "1", "2", "Shift+G");
    check((await status(page)).includes("lib.rs:12 "), "12G goes to line 12 of this file");
    await keys(page, "'", "'");
    check((await status(page)).includes(here.match(/\S+:\d+/)[0]), "'' goes back to where the jump came from");
    // More of vim: paragraphs, first / last word, the word under the cursor, gv and o.
    await cursorTo(page, "src/lib.rs", 45);
    const line = async () => Number((await status(page)).match(/lib\.rs:(\d+)/)?.[1]);
    const from = await line();
    await keys(page, "}");
    check((await line()) > from, `} goes down to the next blank line (${from} → ${await line()})`);
    await keys(page, "{");
    check((await line()) < from + 1, "{ back up");
    await cursorTo(page, "src/lib.rs", 45);
    await keys(page, "$");
    check((await status(page)).includes(" · "), "$ puts the cursor on the last word");
    await keys(page, "0");
    check(!(await status(page)).includes(" · "), "0 back on the whole line");
    await keys(page, "_");
    const word = (await status(page)).split(" · ")[1]?.split(" ")[0];
    await keys(page, "*");
    check((await status(page)).includes(`/${word} ·`), `* searches this file for the word under the cursor (${word})`);
    await keys(page, "Escape", "Escape", "Shift+V", "j", "j", "Escape", "g", "v");
    check((await page.locator(".buffer.focused .row.vsel").count()) === 3, "gv selects the last selection again");
    await keys(page, "o");
    check((await page.locator(".buffer.focused .row.vsel").count()) === 3, "o goes to its other end, keeping it");
    await keys(page, "Escape");

    // Ctrl+H / Ctrl+L move across the page: files, the code, activity, and back.
    await keys(page, "Control+h");
    check(await page.evaluate(() => !!document.activeElement?.closest('aside[data-drawer="left"]')), "ctrl-h from the code goes to the files drawer");
    await keys(page, "j");
    check(await page.evaluate(() => !!document.activeElement?.closest('aside[data-drawer="left"]')), "j moves through it");
    await keys(page, "Control+l");
    check(await page.evaluate(() => !!document.activeElement?.closest(".buffer.focused")), "ctrl-l back to the code");
    await keys(page, "Control+l");
    check(await page.evaluate(() => !!document.activeElement?.closest('aside[data-drawer="right"]')), "and on to the activity drawer");
    await keys(page, "Control+h");
    check(await page.evaluate(() => !!document.activeElement?.closest(".buffer.focused")), "ctrl-h from there back to the code");
  });

  await section("Find bar, replying, gc, keeping the selection, marks anywhere, shift+click to a split", async () => {
    await freshPage(page);
    await page.waitForSelector(".buffer.focused .row");
    await cursorTo(page, "src/lib.rs", 45);
    // Ctrl+F: a small bar in the corner, finding in this file as you type.
    await keys(page, "Control+f");
    const bar = page.getByRole("search", { name: "Find" });
    check(await bar.isVisible(), "Ctrl+F opens the find bar");
    check((await page.getByRole("dialog").count()) === 0, "not a popup");
    const box = await bar.boundingBox();
    check(box.y < 120 && box.x + box.width > page.viewportSize().width * 0.5, "in the top right");
    await page.keyboard.type("burst");
    await sleep(200);
    const count = await page.locator("[data-find-count]").innerText();
    check(/^\d+\/\d+$/.test(count), `it counts the matches in this file (${count})`);
    check((await status(page)).includes("lib.rs"), "and goes to the first one");
    const first = await status(page);
    await page.keyboard.press("Enter");
    await sleep(150);
    check((await status(page)) !== first, "enter goes to the next");
    await page.keyboard.press("Escape");
    check(!(await bar.isVisible()), "esc closes it");
    await keys(page, "n");
    check((await status(page)).includes("lib.rs"), "and n keeps going");
    await keys(page, "Escape");

    // gc comments on the line (no third c needed), and gcc doesn't type a c.
    await keys(page, "g", "c");
    check(await page.getByRole("dialog", { name: "Write a comment" }).isVisible(), "gc opens the comment popover");
    await keys(page, "Escape");
    await keys(page, "g", "c", "c");
    await page.keyboard.type("x");
    check((await page.getByRole("dialog", { name: "Write a comment" }).locator("textarea").inputValue()) === "x", "gcc's last c isn't typed into the comment");
    await keys(page, "Escape", "Escape");

    // Lines picked with V stay picked while the comment is written.
    await keys(page, "Shift+V", "j", "j", "g", "c");
    await sleep(150);
    check((await page.locator(".buffer.focused .row.vsel").count()) >= 3, "V … gc keeps the selected lines highlighted while commenting");
    await keys(page, "Escape");

    // grr: every use, listed under the code (no popup), stepped through with ]q.
    await cursorTo(page, "src/lib.rs", 45);
    await keys(page, "w");
    await keys(page, "g", "r", "r");
    await page.waitForSelector('section[aria-label="Quickfix list"]', { timeout: 20000 });
    check((await page.getByRole("dialog").count()) === 0, "grr lists references without a popup");
    const refs = await page.locator("[data-quickfix]").count();
    check(refs >= 1, `with every use (${refs})`);
    await keys(page, "]", "q");
    check((await page.locator('[data-quickfix][aria-current="true"]').count()) === 1, "]q goes to the first");
    await keys(page, "Space", "q");
    check((await page.locator('section[aria-label="Quickfix list"]').count()) === 0, "space q closes the list");

    // The chat box grows with what's typed, instead of scrolling sideways.
    const chat = page.locator("#chat-input");
    const h1 = (await chat.boundingBox()).height;
    await chat.fill("A long question about the limiter that wraps onto another line, and then another one after that, and more.");
    await chat.dispatchEvent("input");
    const h2 = (await chat.boundingBox()).height;
    check(h2 > h1 + 10, `the chat box grows to fit (${Math.round(h1)} → ${Math.round(h2)}px)`);
    await chat.fill("");
    await chat.dispatchEvent("input");
    await page.locator(".buffer.focused").focus();

    // r answers a thread on screen, and goes to one first when none is.
    await keys(page, "G");
    await keys(page, "r");
    await sleep(400);
    const composer = await page.getByRole("dialog", { name: "Write a comment" }).boundingBox();
    check(composer && composer.y >= 0 && composer.y + composer.height <= page.viewportSize().height, "r opens the reply on screen, next to its thread");
    await keys(page, "Escape");

    // Marks work in file view and in files outside the diff.
    await cursorTo(page, "src/bucket.rs", 6);
    await keys(page, "g", "Enter", "j", "j");
    const inFile = (await status(page)).match(/\S+:\d+/)[0];
    await keys(page, "m", "Shift+F", "g", "g");
    await keys(page, "'", "Shift+F");
    check((await status(page)).includes(inFile), "a mark set in file view comes back");
    await keys(page, "Control+o");

    // Shift+click a path:line link: the file opens in a split beside.
    const link = page.locator('section[aria-label^="Chat with"] a[data-go]').first();
    await link.scrollIntoViewIfNeeded();
    await link.click({ modifiers: ["Shift"] });
    await sleep(400);
    check((await page.locator(".buffer").count()) === 2, "shift+click on a link opens it in a split");
    check((await status(page)).startsWith("FILE"), "in file view");
    await keys(page, "Control+Escape");
  });

  await section("A reload puts everything back: splits, file view, the commit, the cursor", async () => {
    await freshPage(page);
    await page.waitForSelector(".buffer.focused .row");
    await cursorTo(page, "src/lib.rs", 45);
    await keys(page, "Control+Backslash");
    await cursorTo(page, "src/bucket.rs", 6);
    await keys(page, "g", "Enter", "j", "j");
    const before = await status(page);
    await page.reload();
    await page.waitForSelector(".buffer.focused .row");
    await sleep(800);
    check((await page.locator(".buffer").count()) === 2, "both splits come back");
    const after = await status(page);
    check(after.startsWith("FILE") && after.includes(before.match(/\S+:\d+/)[0]), `the focused one is still the file view, on the same line (${after.slice(0, 30)})`);
    await keys(page, "Control+Escape");
    await keys(page, "]", "r");
    await spanReady(page);
    await page.waitForFunction(() => document.querySelector("header").innerText.includes("×"));
    await spanReady(page);
    const chip = await page.locator("[data-span-chip]").innerText();
    await page.reload();
    await page.waitForSelector(".buffer.focused .row");
    await spanReady(page);
    await sleep(500);
    check((await page.locator("[data-span-chip]").innerText()) === chip, "the commit being looked at comes back");
    const x = page.locator("[data-span-chip] button");
    if (await x.count()) await x.first().click();
    await spanReady(page);
  });

  await section("Home page", async () => {
    await page.goto(base);
    check(await page.getByText("Add burst capacity to the limiter").isVisible(), "recent reviews are listed");
    await shot(page, "home");
  });

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("\nAll checks passed.");
} catch (e) {
  await shot(page, "failure").catch(() => {});
  console.error(`\n${e.message}`);
  if (errors.length) console.error("console errors:", errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
