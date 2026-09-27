// A review with a real agent: Claude Code (headless) does a small task in a
// repository, shares it through diffd's MCP server, and then talks with
// "you" (Playwright) on the page until you say you're done.
//
//   node web/e2e/agent.mjs <repo> <port> <screenshot-dir>
//
// Needs `claude` (Claude Code) signed in, and diffd running on <port>. Takes
// a few minutes and uses real model calls.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const [repo, port = "3433", shots = "/tmp/diffd-agent"] = process.argv.slice(2);
const base = `http://localhost:${port}`;
mkdirSync(shots, { recursive: true });

const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);
let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 300_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const json = (path) => fetch(`${base}${path}`).then((r) => r.json());

// -- The agent ------------------------------------------------------------------
const config = `${shots}/mcp.json`;
writeFileSync(config, JSON.stringify({ mcpServers: { diffd: { type: "http", url: `${base}/mcp` } } }));
const task = `You're working in this repository (the Python "requests" library).

1. Make a small, real improvement in two commits:
   - commit 1: in src/requests/utils.py, give \`get_encoding_from_headers\` type hints and a clearer docstring;
   - commit 2: add a test for it in tests/test_utils.py (one or two cases are enough).
2. Share your work for review with diffd's share_diff: from "HEAD~2", with a title and a short summary.
   Add a note on the part a reviewer should look at, and mark the test code as a test region.
3. Then keep calling wait_for_feedback, and answer everything the reviewer says:
   comments with reply (in the thread), chat messages with say. If they ask where something is,
   use show. If a comment asks for a code change, make the change (the review updates by itself)
   and reply saying what you changed.
4. When the reviewer writes "done" in the chat, say "Bye!" with say, and stop.`;
const before = new Set((await json("/api/reviews")).map((r) => r.review.id));
log("starting Claude Code");
const agent = spawn(
  "claude",
  [
    "-p",
    task,
    "--mcp-config",
    config,
    "--allowedTools",
    "mcp__diffd Edit Write Read Glob Grep Bash(git:*) Bash(python:*) Bash(python3:*)",
    "--permission-mode",
    "acceptEdits",
    "--max-turns",
    "80",
  ],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
);
let agentOut = "";
agent.stdout.on("data", (d) => (agentOut += d));
agent.stderr.on("data", (d) => (agentOut += d));
const agentDone = new Promise((r) => agent.on("exit", r));

// -- You ---------------------------------------------------------------------------
const browser = await chromium.launch(process.env.DIFFD_E2E_CHROMIUM ? { executablePath: process.env.DIFFD_E2E_CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const status = async () => (await page.locator("footer").innerText()).replace(/\s+/g, " ");
const keys = async (...ks) => {
  for (const k of ks) await page.keyboard.press(k);
  await sleep(60);
};
const state = async (id) => json(`/api/reviews/${id}`);
const agentReplies = (s) => s.threads.filter((t) => t.kind.type === "comment" && t.messages.some((m) => m.author === "agent")).length;

try {
  const review = await until("the agent to share a review", async () => {
    const list = await json("/api/reviews");
    return list.find((r) => !before.has(r.review.id));
  }, 600_000);
  const id = review.review.id;
  log(`review shared: ${review.review.title}`);
  let s = await state(id);
  check(s.snapshot.files.some((f) => f.path.endsWith("utils.py")), "the diff has the change to utils.py");
  check(s.history.commits.length === 2, `and its two commits (${s.history.commits.length})`);
  check(s.threads.some((t) => t.kind.type === "note"), "Claude left a note");
  check(s.regions.some((r) => r.kind === "test"), "and marked the tests");

  await page.goto(`${base}/r/${id}`);
  await page.waitForSelector("[data-file-section]");
  await page.locator(".buffer.focused").focus();
  await page.screenshot({ path: `${shots}/1-shared.png` });

  // A question on a changed line.
  const utils = s.snapshot.files.findIndex((f) => f.path.endsWith("utils.py"));
  const changed = page.locator(`section[data-file-section="${utils}"] .row[data-chg="1"] .code[data-side="new"]`).first();
  await changed.scrollIntoViewIfNeeded();
  await changed.click({ position: { x: 4, y: 4 } });
  await keys("g", "c", "c");
  await page.keyboard.type("Why is this the right default when there's no charset? Answer briefly.");
  await keys("Control+Enter");
  log("asked a question");
  await until("Claude's answer", async () => agentReplies(await state(id)) >= 1);
  await page.waitForFunction(() => document.body.textContent.includes("Claude replied"));
  check(true, "Claude answered the question in the thread");

  // A request for a change.
  const rev = (await state(id)).review.revision;
  const test = s.snapshot.files.findIndex((f) => f.path.endsWith("test_utils.py"));
  const testRow = page.locator(`section[data-file-section="${test}"] .row[data-chg="1"] .code[data-side="new"]`).first();
  await testRow.scrollIntoViewIfNeeded();
  await testRow.click({ position: { x: 4, y: 4 } });
  await keys("g", "c", "c");
  await page.keyboard.type("Please add one more case: a header with an explicit charset=utf-8. Don't commit it.");
  await keys("Control+Enter");
  log("asked for a change");
  await until("the change to arrive", async () => (await state(id)).review.revision > rev, 600_000);
  check(true, "the code changed and the review updated live");
  await until("a reply about it", async () => agentReplies(await state(id)) >= 2, 600_000);
  check(true, "and Claude said what it changed");
  await page.screenshot({ path: `${shots}/2-changed.png` });

  // "Show me."
  await keys("Space", "i");
  await page.keyboard.type("Where is get_encoding_from_headers called from? Show me one place.");
  await keys("Enter");
  await page.keyboard.press("Escape");
  log("asked where something is");
  await page.waitForSelector("text=wants to show you something", { timeout: 600_000 });
  check(true, "Claude offered to show something");
  await page.screenshot({ path: `${shots}/3-show.png` });
  await keys("Enter");
  await sleep(1500);
  check(/\.py:\d+/.test(await status()), `and it opens there (${(await status()).slice(0, 60)})`);

  // Walk the commits, then finish.
  await page.locator(".buffer.focused").focus();
  await keys("Control+o");
  await keys("]", "r");
  await page.waitForFunction(() => document.querySelector("header").innerText.includes("×"));
  check(true, "the review can be read commit by commit");
  await keys("[", "r");
  await keys("Space", "i");
  await page.keyboard.type("done");
  await keys("Enter");
  await page.waitForFunction(() => document.body.textContent.includes("Bye"), null, { timeout: 300_000 });
  check(true, "Claude says bye");
  await Promise.race([agentDone, sleep(120_000)]);
  check(agent.exitCode === 0, `and stops (exit ${agent.exitCode})`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  await page.screenshot({ path: `${shots}/4-done.png` });
} catch (e) {
  failures++;
  console.log(`  ✗ ${e.message}`);
  await page.screenshot({ path: `${shots}/failure.png` }).catch(() => {});
  console.log(`--- agent output (tail) ---\n${agentOut.slice(-3000)}`);
} finally {
  agent.kill();
  await browser.close();
}
console.log(failures ? `\n${failures} problem(s).` : "\nThe whole conversation worked.");
process.exitCode = failures ? 1 : 0;
