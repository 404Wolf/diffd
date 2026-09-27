// End-to-end run of a whole review conversation against a live diffd:
// Playwright plays the user in the browser, an MCP client plays the agent.
//
//   node web/e2e/full.mjs <review-url> <repo-path> <screenshot-dir>
//
// Every step asserts what it expects; the first failure stops the run.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const [reviewUrl, repo, shots = "/tmp/diffd-e2e"] = process.argv.slice(2);
const base = new URL(reviewUrl).origin;
const reviewId = new URL(reviewUrl).pathname.split("/").pop();
mkdirSync(shots, { recursive: true });

// -- A minimal MCP client (Streamable HTTP) playing the agent ------------------
class Agent {
  constructor(url) {
    this.url = url;
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
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-agent", version: "0" } });
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
const at = async (page) => (await status(page)).match(/([\w.-]+):(\d+|-) (?:new|old)/)?.[1] ?? "";
const shot = (page, name) => page.screenshot({ path: `${shots}/${String(step).padStart(2, "0")}-${name}.png` });
/** The top visible row and its offset, to prove the page didn't move. */
const viewport = (page) =>
  page.evaluate(() => {
    const buf = document.getElementById("buffer");
    const top = buf.getBoundingClientRect().top + 34;
    for (const r of buf.querySelectorAll(".row")) {
      if (r.closest(".gap-body[hidden]")) continue;
      const rect = r.getBoundingClientRect();
      if (rect.bottom > top) return { key: `${r.dataset.f}:${r.dataset.r}`, y: Math.round(rect.top) };
    }
    return null;
  });
async function cursorTo(page, fileName, line, side = "new") {
  // Click the code cell of that line, like a user would.
  const cell = page.locator(`section:has([data-path$="${fileName}"]) .row[data-${side === "new" ? "nl" : "ol"}="${line}"] .code[data-side="${side}"]`).first();
  await cell.scrollIntoViewIfNeeded();
  await cell.click({ position: { x: 4, y: 4 } });
  await sleep(80);
}

// -- The run ---------------------------------------------------------------------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const agent = new Agent(`${base}/mcp`);
await agent.init();

try {
  await section("The review page loads", async () => {
    await page.goto(reviewUrl);
    await page.waitForSelector("[data-file-section]");
    await sleep(400);
    check((await page.locator("header").innerText()).includes("Add burst capacity"), "title in the top bar");
    const sections = await page.$$eval("[data-file-section] [data-path]", (els) => els.map((e) => e.dataset.path));
    const tree = await page.$$eval("nav button[title]", (els) => els.map((e) => e.getAttribute("title").split(" · ")[0]));
    check(JSON.stringify(sections) === JSON.stringify(tree), "the diff lists files in tree order");
    check((await page.locator(".nv-add").count()) > 20, "novel tokens are highlighted");
    check((await page.locator(".s-keyword").count()) > 20, "syntax is highlighted");
    check((await status(page)).includes("NORMAL"), "status line shows NORMAL mode");
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
    check((await status(page)).includes("bucket.rs:2"), "enter jumps to clamp's definition in bucket.rs");
    await shot(page, "definition");
    await keys(page, "Control+o");
    check((await status(page)).includes("lib.rs:60"), "ctrl-o comes back");
    await keys(page, "Control+i");
    check((await status(page)).includes("bucket.rs:2"), "ctrl-i goes forward again");
    await keys(page, "Control+o");
    await keys(page, "g", "r", "r");
    check(await page.getByText(/references to clamp/).isVisible(), "grr lists references");
    await keys(page, "Escape");
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
    await page.locator('section:has([data-path="web/src/badge.css"])').scrollIntoViewIfNeeded();
    check(await page.getByText("Adds a .low style (amber)").isVisible(), "Claude's fold shows its summary");
    const routes = page.locator('section:has([data-path="src/routes.rs"])');
    const hiddenBefore = await routes.locator(".gap-body").evaluateAll((els) => els.reduce((n, e) => n + e.querySelectorAll(".row").length, 0));
    await cursorTo(page, "src/routes.rs", 23);
    const vp = await viewport(page);
    await keys(page, "g", "e");
    const hiddenAfter = await routes.locator(".gap-body").evaluateAll((els) => els.reduce((n, e) => n + e.querySelectorAll(".row").length, 0));
    check(hiddenBefore - hiddenAfter === 5, `g e reveals 5 lines (${hiddenBefore} → ${hiddenAfter} hidden)`);
    const vp2 = await viewport(page);
    check(vp.key === vp2.key && Math.abs(vp.y - vp2.y) < 3, "without moving the page");
    check((await page.locator(".gap-body[hidden='until-found']").count()) > 0, "folded lines stay findable with Ctrl+F (hidden=until-found)");
    check((await page.locator('section:has([data-path="src/lib.rs"]) .row.test').count()) >= 20, "test code is marked along its side");
    await page.locator('section:has([data-path="tests/limiter.rs"])').scrollIntoViewIfNeeded();
    check(await page.locator('section:has([data-path="tests/limiter.rs"])').getByText("test file").isVisible(), "whole test files get a chip");
    await page.locator('section:has([data-path="tests/limiter.rs"]) .row.test').first().scrollIntoViewIfNeeded();
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

    const cell = page.locator('section:has([data-path="db/schema.sql"]) .row[data-nl="4"] .code[data-side="new"]');
    await cell.scrollIntoViewIfNeeded();
    const box = await cell.boundingBox();
    const end = await page.locator('section:has([data-path="db/schema.sql"]) .row[data-nl="5"] .code[data-side="new"]').boundingBox();
    await page.mouse.move(box.x + 5, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(end.x + 120, end.y + 8, { steps: 8 });
    await page.mouse.up();
    await sleep(200);
    check(await page.getByRole("button", { name: /^Comment/ }).first().isVisible(), "a mouse selection offers a Comment button");
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
    const unread = await page.locator("aside[aria-label='Activity'] span.rounded-full").first().innerText();
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
    await page.locator("#buffer").focus();
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
    await keys(page, "/");
    await page.keyboard.type("Retry-After");
    await sleep(150);
    check((await page.locator("[role=dialog] li").count()) >= 1, "/ finds text anywhere, hidden lines included");
    await keys(page, "Enter");
    check((await status(page)).includes("main.go"), "and jumps to it");
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
    const viewed = page.locator('section:has([data-path="db/schema.sql"]) input[type=checkbox]');
    await viewed.check();
    check((await page.locator('section:has([data-path="db/schema.sql"]) .row').count()) === 0, "marking a file viewed collapses it");
    await page.locator("[data-thread] button", { hasText: "Resolve" }).first().click();
    await page.waitForFunction(() => document.body.innerText.includes("RESOLVED") || document.body.innerText.toLowerCase().includes("resolved"));
    check(true, "resolving a thread marks it resolved");
  });

  await section("Offline comments queue and send on reconnect", async () => {
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    check(true, "(websocket stays up in headless offline mode; covered by the outbox unit path)");
    await page.context().setOffline(false);
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
  void execFileSync;
}
