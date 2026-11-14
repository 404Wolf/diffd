// End-to-end run of a Showing board against a live diffd: an MCP client plays
// the agent presenting files, Playwright plays the user reading them on a
// Pixel Fold (cover 412×915 and inner 884×1050 / 1050×884, touch) and on a
// desktop.
//
//   node web/e2e/board.mjs <diffd-url> <scratch-dir> <screenshot-dir>
//
// Every step asserts what it expects; the first failure stops the run.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const [base, scratch, shots = "/tmp/diffd-board-e2e"] = process.argv.slice(2);
if (!base || !scratch) throw new Error("usage: board.mjs <diffd-url> <scratch-dir> <screenshot-dir>");
mkdirSync(shots, { recursive: true });

// -- The agent: a minimal MCP client (Streamable HTTP) -------------------------
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
      const msgs = text
        .split("\n")
        .filter((l) => l.startsWith("data:") && l.slice(5).trim())
        .map((l) => JSON.parse(l.slice(5)));
      return msgs.filter((m) => "id" in m).at(-1);
    }
    return JSON.parse(text);
  }
  async init() {
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "0" } });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async rpc(method, params) {
    const res = await this.post({ jsonrpc: "2.0", id: ++this.id, method, params });
    if (!res || res.error) throw new Error(`${method}: ${JSON.stringify(res)}`);
    return res.result;
  }
  async present(args) {
    const r = await this.rpc("tools/call", { name: "present", arguments: args });
    const text = r.content[0].text;
    if (r.isError) throw new Error(`present: ${text}`);
    return JSON.parse(text);
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
async function shot(page, name) {
  await page.screenshot({ path: join(shots, `${name}.png`) });
}
/** No sideways scrolling of the page itself (tables and code scroll in their own boxes). */
async function noPageOverflow(page) {
  const [doc, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  return doc <= inner;
}
/** Every visible control matching `selector` is at least `min` px tall and wide. */
async function bigEnough(page, selector, min = 44) {
  const sizes = await page.$$eval(selector, (els) =>
    els
      .filter((e) => e.offsetParent !== null)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      }),
  );
  return sizes.length > 0 && sizes.every(([w, h]) => w >= min && h >= min) ? true : sizes;
}
/** The board asks for news when it's shown again; the test doesn't wait 30 s for the timer. */
async function nudge(page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

// -- The files the agent presents ------------------------------------------------
rmSync(scratch, { recursive: true, force: true });
const repo = join(scratch, "repo");
mkdirSync(join(repo, "reports/shots"), { recursive: true });
mkdirSync(join(repo, "src"), { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", repo]);
const report = (version) => `# Item 31: present a file (v${version})

A report the way agents write them: a table, some code and a screenshot. This paragraph is long enough to
wrap on a phone, so the measure and the line height show.

| Piece | Effort | Status |
|---|--:|---|
| Server: storage, policy, MCP and CLI | 1 day | in review |
| Board page: tray, reader, documents | 1 day | in review |
| Cross-machine forwarding over Herdr | 1-2 days | later |

\`\`\`rust
fn present(file: &Path) -> Result<Url> {
    let item = snapshot(file)?;
    Ok(board.url(&item))
}
\`\`\`

- [x] design note
- [ ] e2e on the Fold

![the board on the cover screen](shots/cover.png)

See [the plan](PLAN.md) and [diffd](https://github.com/404Wolf/diffd).
`;
writeFileSync(join(repo, "reports/item-31.md"), report(1));
writeFileSync(
  join(repo, "src/stop.rs"),
  Array.from({ length: 80 }, (_, i) =>
    i === 40 ? "fn clear(&mut self) {" : i === 41 ? "    self.orders.clear();" : `// line ${i + 1}`,
  ).join("\n"),
);

const browser = await chromium.launch(process.env.DIFFD_E2E_CHROMIUM ? { executablePath: process.env.DIFFD_E2E_CHROMIUM } : {});
const errors = [];
try {
  // A real PNG for the report to show: a screenshot of a small page.
  {
    const p = await browser.newPage({ viewport: { width: 320, height: 180 } });
    await p.setContent('<body style="margin:0;background:#4f46e5;color:#fff;font:24px sans-serif;display:grid;place-items:center;height:100vh">cover screen</body>');
    await p.screenshot({ path: join(repo, "reports/shots/cover.png") });
    await p.close();
  }

  const agent = new Agent(`${base}/mcp`);
  await agent.init();
  let doc;
  let code;
  let image;

  await section("The agent presents a report, some code and an image", async () => {
    doc = await agent.present({ file: "reports/item-31.md", cwd: repo, message: "needs your OK" });
    check(doc.url.includes(`/show/${doc.scope}/${doc.id}`) && doc.revision === 1, `the report gets a link (${doc.url})`);
    check(!doc.skipped, "its image was bundled");
    code = await agent.present({ file: join(repo, "src/stop.rs"), lines: [41, 42], message: "the race" });
    image = await agent.present({ file: join(repo, "reports/shots/cover.png") });
    check(code.scope === doc.scope && image.scope === doc.scope, "all three on the same board");
    const refused = await agent.present({ file: join(repo, ".git/config") }).catch((e) => e.message);
    check(String(refused).includes("looks private"), "a private file is refused");
  });

  const board = `${base}/show/${doc.scope}`;

  /** The same checks at each screen size, with the same component. */
  async function onScreen(name, options) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    const narrow = options.viewport.width < 760;
    const touch = Boolean(options.hasTouch);
    const tap = (locator) => (touch ? locator.tap() : locator.click());
    try {
      await page.goto(board);
      await page.waitForSelector(".tray-item");
      check((await page.locator(".tray-list > .tray-item").count()) === 3, `${name}: the tray lists the three items`);
      check(await noPageOverflow(page), `${name}: the list doesn't scroll sideways`);
      if (touch) {
        const sizes = await bigEnough(page, ".tray-open, .icon-btn");
        check(sizes === true, `${name}: tray rows and buttons are big enough to tap (${JSON.stringify(sizes)})`);
      }
      await shot(page, `${name}-list`);

      // The report: rendered, with its table, code and image.
      await tap(page.locator(".tray-open", { hasText: "Item 31" }));
      await page.waitForSelector(".doc h1");
      check(new URL(page.url()).pathname === `/show/${doc.scope}/${doc.id}`, `${name}: the address names the open item`);
      check((await page.locator(".doc .doc-table table tr").count()) === 4, `${name}: the table is there, in its own box`);
      await page.waitForSelector(".doc pre code .s-keyword");
      check(true, `${name}: fenced code is highlighted`);
      const img = page.locator(".doc img");
      await img.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector(".doc img")?.naturalWidth > 0);
      check(true, `${name}: the screenshot loads from the board`);
      check((await page.locator(".doc li.task input:checked").count()) === 1, `${name}: task lists are checkboxes`);
      check((await page.locator(".doc .doc-path").innerText()) === "the plan", `${name}: a link to a local file is just text`);
      check(await noPageOverflow(page), `${name}: the report doesn't scroll sideways`);
      if (narrow) {
        check(await page.locator(".board-back").isVisible(), `${name}: a back button returns to the list`);
        check((await page.locator(".tray-item .tray-meta").first().isVisible()) === false, `${name}: the other items are chips`);
      } else {
        check(await page.locator(".tray-item .tray-meta").first().isVisible(), `${name}: the tray stays a list beside the report`);
      }
      if (touch) {
        const sizes = await bigEnough(page, ".reader-actions button");
        check(sizes === true, `${name}: minimise and hide are big enough to tap (${JSON.stringify(sizes)})`);
      }
      const fontSize = await page.$eval(".doc p", (p) => Number.parseFloat(getComputedStyle(p).fontSize));
      check(fontSize >= 16, `${name}: body text is ${fontSize}px`);
      await page.evaluate(() => document.querySelector(".board-reader")?.scrollTo({ top: 0 }));
      await shot(page, `${name}-report`);
      await page.locator(".doc .doc-table").scrollIntoViewIfNeeded();
      await shot(page, `${name}-report-table`);

      // Code: the lines the agent named are lit and in view.
      await tap(page.locator(".tray-open", { hasText: "stop.rs" }));
      await page.waitForSelector(".board-code .cl.lit");
      check((await page.locator(".board-code .cl.lit").count()) === 2, `${name}: lines 41-42 are lit`);
      check(await page.locator('.board-code .cl[data-line="41"]').isVisible(), `${name}: and scrolled into view`);
      check(await noPageOverflow(page), `${name}: code scrolls in its own box`);
      await shot(page, `${name}-code`);

      // Minimise: out of the way, still in the tray.
      await tap(page.locator(".reader-actions button", { hasText: "Minimise" }));
      await page.waitForSelector('.tray-item[data-state="minimised"]');
      check(true, `${name}: minimised, it stays in the tray`);
      if (narrow) check(!(await page.locator(".board-reader").isVisible()), `${name}: and the list is back`);
      // Hide the image, then bring it back.
      await tap(page.locator(".tray-open", { hasText: "cover.png" }));
      await page.waitForSelector(".board-image img");
      await page.waitForFunction(() => document.querySelector(".board-image img")?.naturalWidth > 0);
      await shot(page, `${name}-image`);
      await tap(page.locator(".reader-actions button", { hasText: "Hide" }));
      await page.waitForSelector(".tray-hidden-toggle");
      check((await page.locator(".tray-hidden-toggle").innerText()).includes("Hidden (1)"), `${name}: hidden, it moves under Hidden`);
      // A reload shows the board as it was left: the server keeps it.
      await page.reload();
      await page.waitForSelector(".tray-hidden-toggle");
      check((await page.locator('.tray-list > .tray-item[data-state="minimised"]').count()) === 1, `${name}: after a reload, still minimised`);
      await tap(page.locator(".tray-hidden-toggle"));
      await tap(page.locator(".tray-hidden .icon-btn"));
      await page.waitForFunction(() => !document.querySelector(".tray-hidden-toggle"));
      check((await page.locator(".tray-list > .tray-item").count()) === 3, `${name}: brought back`);
      await shot(page, `${name}-restored`);

      // News: the agent presents the report again; the board marks it and the open copy offers the new version.
      await tap(page.locator(".tray-open", { hasText: "Item 31" }));
      await page.waitForSelector(".doc h1");
      writeFileSync(join(repo, "reports/item-31.md"), report(2));
      const again = await agent.present({ file: "reports/item-31.md", cwd: repo });
      check(again.id === doc.id && again.replaced, `${name}: presenting it again updates the same item`);
      await nudge(page);
      await page.waitForSelector(".reader-stale");
      await tap(page.locator(".reader-stale"));
      await page.waitForFunction(() => document.querySelector(".doc h1")?.textContent?.includes("v2"));
      check(true, `${name}: the new version shows when asked, not under your finger`);

      // Put things back for the next screen.
      for (const it of [doc, code, image]) {
        await fetch(`${base}/api/board/${it.id}/state`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "open", seen: null }),
        });
      }
      writeFileSync(join(repo, "reports/item-31.md"), report(1));
    } finally {
      await context.close();
    }
  }

  await section("On the Fold's cover screen (412×915, touch)", () =>
    onScreen("cover", { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }),
  );
  await section("On the Fold's inner screen, portrait (884×1050, touch)", () =>
    onScreen("inner-portrait", { viewport: { width: 884, height: 1050 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }),
  );
  await section("On the Fold's inner screen, landscape (1050×884, touch)", () =>
    onScreen("inner-landscape", { viewport: { width: 1050, height: 884 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }),
  );
  await section("On a desktop (1440×900, mouse)", () => onScreen("desktop", { viewport: { width: 1440, height: 900 } }));

  await section("Keys on a desktop: j/k, m, x, H, Esc", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`keys: ${e.message}`));
    try {
      await page.goto(board);
      await page.waitForSelector(".tray-item");
      await page.keyboard.press("j");
      await page.waitForSelector(".reader-title");
      const first = await page.locator(".reader-title").innerText();
      await page.keyboard.press("j");
      await page.waitForFunction((t) => document.querySelector(".reader-title")?.textContent !== t, first);
      check(true, "j opens the next item");
      await page.keyboard.press("k");
      await page.waitForFunction((t) => document.querySelector(".reader-title")?.textContent === t, first);
      check(true, "k the one before");
      await page.keyboard.press("m");
      await page.waitForSelector('.tray-item[data-state="minimised"]');
      check((await page.locator(".board-pick").count()) === 1, "m minimises it and closes the reader");
      await page.keyboard.press("j");
      await page.waitForSelector(".reader-title");
      await page.keyboard.press("x");
      await page.waitForSelector(".tray-hidden-toggle");
      check(true, "x hides it");
      await page.keyboard.press("H");
      await page.waitForSelector(".tray-hidden .tray-item");
      check(true, "H shows the hidden ones");
      await page.locator(".tray-open").first().click();
      await page.keyboard.press("Escape");
      await page.waitForSelector(".board-pick");
      check(new URL(page.url()).pathname === `/show/${doc.scope}`, "esc closes the item, and the address follows");
    } finally {
      await context.close();
    }
  });

  await section("Every board at /show, and a missing item", async () => {
    const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
    try {
      await page.goto(`${base}/show`);
      await page.waitForSelector(".tray-item");
      check((await page.locator(".tray-meta").first().innerText()).includes(doc.scope), "rows name their board");
      const missing = await page.goto(`${base}/show/${doc.scope}/s-missing`);
      check(missing.status() === 404, "a missing item is a 404 page");
    } finally {
      await page.close();
    }
  });

  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
  console.log("\nAll board checks passed.");
} finally {
  await browser.close();
}
