# diffd: design

Status: **v1 is built.** This document describes the system as it is. §15
lists what's still open.

## 1. The product

diffd turns an agent's code changes into a **live code review in your browser**.

1. The agent opens a *magic diff* through MCP.
2. It annotates the tricky parts in plain language, marks test code, and folds
   mechanical changes behind a one-line summary.
3. It hands you a link.
4. You read the change in a viewer that's GitHub-quality, difftastic-powered
   and vim-driven. You select code and comment on it.
5. The agent answers inline and keeps working, and the diff updates as it
   edits.

**It all runs locally, from one Rust binary.**

## 2. The loop

```
 you                         browser (diffd page)          diffd server               Claude Code
  │ "refactor the parser"                                                                │
  │───────────────────────────────────────────────────────────────────────────────────▶ │ edits code
  │                                                           │◀── share_diff(repo,     │
  │                                                           │     title, summary,     │
  │                                                           │     annotations,        │
  │                                                           │     regions)            │
  │                                                           │── url ─────────────────▶│
  │ ◀──────────────────────────────────── "review it here: http://localhost:3433/r/k3f9"│
  │ open link ───────────────▶│ summary, file tree,           │                         │
  │                           │ multibuffer, Claude's notes   │                         │
  │ select L41–47, comment ──▶│── comment ───────────────────▶│── wait_for_feedback ───▶│ (§5.3)
  │ keep scrolling …          │                               │◀── reply(thread, body) ─│
  │                           │◀── reply (live) ──────────────│                         │ edits code
  │ subtle "Claude replied"   │                               │ files changed → rebuild │
  │ in the activity drawer    │◀── revision 2 (live) ─────────│                         │
  │ ]n jumps there, ctrl-o back                               │                         │
```

Step by step:

1. You ask for something, and Claude edits code.
2. Claude calls `share_diff`. diffd builds the diff and returns a URL, which
   Claude posts in the chat.
3. You open the link and see:
   - the summary on top, like a PR description
   - the file tree
   - the multibuffer
   - Claude's annotations next to the code they explain, which you can step
     through as a tour
   - test code marked with a line along its side, and folds with Claude's
     summary of what changed inside
4. You select a region and comment on it. The comment is sent as soon as you
   save it.
5. Claude, sitting in `wait_for_feedback`, receives the comment, answers
   inline, and maybe edits code.
6. Files change on disk. diffd rebuilds the review and pushes a new revision.
   The page updates in place without moving your scroll. Lines changed since
   the previous revision get a marker. Threads whose code changed say so.
7. Meanwhile you've kept reading. Replies show up as quiet entries in the
   activity drawer and as dots in the file tree. Nothing pops up or steals
   focus.
8. You can also talk to Claude in Claude Code and ask it to show you
   something ("where does the timeout get clamped?"). A small prompt appears on
   the page, "Claude wants to show you something", with **Show me** /
   **Later**. It never moves your scroll on its own.

There's no review-level "submit". **Every comment is anchored to a chunk of
code**, like a multi-line PR comment. Anything not about specific lines goes in
the chat box. The conversation just keeps going: Claude answers or edits as
you comment, and the diff keeps up.

## 3. Scope

**v1, built:** everything in §2, local, single user:

- MCP server
- live web UI, usable from several tabs at once
- SQLite storage
- live updates as files change
- annotations, test and fold regions, threads, chat and the activity drawer
- walking a review commit by commit
- opening any file in the repository, not just the diff
- language servers: definition, type definition, hover, diagnostics
- vim keys, splits, marks and text objects
- 100k-line diffs
- reading and commenting offline

What's still open is in §15.

## 4. Process model and setup

```sh
diffd                      # = diffd serve: one local server on localhost:3433
diffd setup claude         # claude mcp add --transport http --scope user diffd http://localhost:3433/mcp?agent=claude,
                           # plus the wake-up hooks in ~/.claude/settings.json (§5.3)
diffd setup codex          # codex mcp add diffd --url …, plus the hooks in ~/.codex/hooks.json
diffd setup claude --print # just prints what it would do
diffd config               # prints the default config, documented
```

`serve` takes `--port`, `--db` and `--config` (also `DIFFD_PORT`, `DIFFD_DB`,
`DIFFD_CONFIG`). The config file is `~/.config/diffd/config.toml`, merged over
the built-in defaults (`crates/diffd-server/config.default.toml`), so it only
needs what it changes. It holds the port, the database path and the language
servers (§7.5).

One long-running server handles everything:

| route | what |
|---|---|
| `/mcp` | MCP over Streamable HTTP (`rmcp`) |
| `/` | recent reviews, newest first: title, repo, `from → to`, revision, when, unread count, delete |
| `/r/{id}` | the review page: the single-file bundle with the review's state embedded |
| `/api/reviews` | the recent list, as JSON |
| `/api/reviews/{id}` | a review's full state (`GET`); `DELETE` removes it |
| `/api/reviews/{id}/range?from=&to=` | the diff between two points in the review's history (§8.8) |
| `/api/reviews/{id}/files` | every file in the repository on the review's `to` side (§8.9) |
| `/api/reviews/{id}/context?path=` | one file outside the diff, highlighted (§8.9) |
| `/api/reviews/{id}/ws` | the page's WebSocket (below) |

**The page talks to the server over one typed WebSocket.** Every message in
either direction is a tagged union defined in Rust (`diffd-core/src/protocol.rs`)
and generated into TS (§11):

- **Page → server (`ClientMsg`):** comment, reply, resolve, drafting on/off,
  chat, read watermark, and language-server questions (`Code`).
- **Server → page (`ServerMsg`):** full state on connect, new revision, thread,
  chat, activity, presence, regions, history, diagnostics, code answers, "show
  you something", acks and errors.

On every (re)connect the server sends the full state, so a page that was away
catches up in one message. If a page falls behind the event broadcast, it
gets the full state again.

**Comments, replies and chat messages carry ids the page makes up.** The
server stores each id once and acks it (`ServerMsg::Ack`). Sending the same
message twice, say after a reconnect, has no extra effect. §8.10 covers how
the page uses this.

**The socket is compressed** with permessage-deflate (RFC 7692). axum's own
WebSocket support can't negotiate extensions, so the upgrade is done by hand in
`adapters/http.rs`, and the socket runs on Signal's tungstenite fork, which
implements permessage-deflate. The fork is vendored in `vendor/tungstenite`
and patched in through `[patch.crates-io]`, so builds (Nix included) need no
network. Offers that ask things of the server are declined, and the socket
then stays uncompressed.

**The socket never resends what the page has.**
- On (re)connect the page says which revision it has (`/ws?revision=N`). If
  that's current, the server answers `resume`: everything in `state` but the
  snapshot.
- A new revision goes out as a `SnapshotDelta`: the new file order, the files
  that are new or differ in any way, and their definitions. The page builds
  the new snapshot from its own, keeping unchanged files as the same objects.
- A page that can't apply it (it missed a revision) reconnects and gets the
  whole `state`. The server does the same for a socket that fell behind.

**Why one HTTP server instead of a stdio MCP process per agent session:**

- Many agents share one server and one port.
- Review URLs and state survive agent restarts.
- MCP handlers and web pages share state in-process, with no IPC.

Run it in a terminal or as a user service.

**Security.**

- The server binds to `127.0.0.1` only.
- It rejects requests whose `Host` isn't `localhost`, `127.0.0.1` or `[::1]`
  (DNS rebinding).
- It rejects requests to the page and API whose `Origin` isn't its own (CSRF),
  WebSocket upgrades included. `/mcp` relies on rmcp's own loopback-only
  `Host` check.

This matters because **comments become LLM input**: a random website must not
be able to post comments to your agent. Agent-written Markdown is rendered with
raw HTML disabled and then sanitized (DOMPurify).

## 5. MCP interface

### 5.1 Server instructions

The MCP `initialize` result carries instructions that Claude Code puts in the
model's context. They teach the workflow:

- **When to share:** after a meaningful change, or when the user asks to review.
- **What to mark:** annotate what a reviewer would trip over; collapse
  generated files, lockfiles and vendored code.
- **Commits:** share the whole range when work spans commits, and write commit
  messages a reviewer can follow.
- **The link:** always give it to the user.
- **Listening:** call `wait_for_feedback`, and keep calling it while in a
  review conversation.
- **Replies:** answer each thread with `reply`, short, in the thread; say what
  changed when you changed code. Chat messages get `say`.
- **Showing:** use `show` to point at code, anywhere in the repository.

Every tool result also carries a `next_step` hint where one helps.

### 5.2 Tools

| tool | purpose |
|---|---|
| `share_diff` | open a review; returns `{ review_id, url, revision, files, added, removed, collapsed, live, next_step }` |
| `wait_for_feedback` | block until the user comments or chats and pauses (§5.3) |
| `reply` | reply in a thread; optionally resolve or reopen it |
| `annotate` | add annotations and regions to an open review |
| `refresh` | rebuild now (for reviews of fixed revisions, or to be sure an edit is in) |
| `say` | a message in the page's chat box |
| `show` | point the user at code: `{ file, lines, side?, message }`. Any file in the repository. The page shows a prompt, never an automatic jump. |
| `get_review` | current state: files, threads with messages, pending-feedback count |

Every tool except `share_diff` and `reply` takes an optional `review_id`,
defaulting to the review this MCP session shared last.

```ts
share_diff({
  repo_path: string,        // absolute path of the repo/worktree (the agent's cwd)
  from: string,             // any rev: a branch ("main"), tag, commit, "HEAD~3"
  to?: string,              // any rev; omitted = the working tree (uncommitted + untracked files), watched live
  merge_base?: boolean,     // default true when `from` names a branch (not HEAD, a tag or a commit): diff from merge-base(from, to), like a PR
  paths?: string[],         // limit to these pathspecs
  collapse?: { glob: string, reason: string }[],  // start these collapsed: generated code, lockfiles, vendored files
  title: string,            // like a PR title: at most 200 characters
  summary?: string,         // markdown: what changed and why, shown at the top
  annotations?: Annotation[],
  regions?: Region[],
})

Annotation = {
  file: string,
  lines: [number, number],  // 1-based inclusive, in the new version unless side = "old"
  side?: "new" | "old",
  body: string,             // markdown
  kind?: "explain" | "why" | "risk" | "question",
}                           // array order = tour order

Region = {
  file: string,
  lines?: [number, number], // omitted = the whole file (tests only)
  side?: "new" | "old",
  kind: "test" | "fold",
  summary?: string,         // required for folds: what changed in there, one plain sentence
}
```

Any two revisions can be compared: `from: "main"` with `to` omitted is "my
branch plus what I haven't committed"; `from: "v1.2.0", to: "v1.3.0"` compares
two tags. A review with a fixed `to` doesn't watch anything.

In a repository with no commits yet, `from: "HEAD"` compares against the empty
tree. An empty diff isn't an error, but the answer says so and suggests
swapping `from` and `to`.

**The base is pinned at share time.** `from` is resolved once (after the merge
base, if any) and stored. When the agent commits afterwards, the new commits
join the review instead of shrinking it.

**Regions.** A `test` region draws a line along the side of test code, so the
reader can tell tests from the change at a glance. A `fold` hides a mechanical
change (a rename across call sites, moved code, reformatting) behind the
agent's summary, so the interesting parts come first. Both follow their lines
across revisions the same way threads do (§6).

Everything is validated against the diff: a note or region on a file that
isn't there, or on lines that don't exist, comes back as a readable error
listing the files, so the agent can fix the call.

### 5.3 How your comments reach the agent

**`wait_for_feedback` long-polls.** It works with every MCP client.

- It returns as soon as there's feedback, or with no items after
  `timeout_seconds` (default and most: 50) with a hint. Agents give up on a
  tool call after their own timeout (60 s in Claude Code and Codex), so a
  longer wait could hand feedback to a call nobody is listening to any more.
  For the same reason a wait stops when the client cancels the call, and
  messages are marked delivered only as the very last step.
- It waits for the user to be idle for 1.5 s, and for any open comment draft to
  be saved, before returning. So writing three comments in a row wakes the
  agent once, not three times.
- Each thread item carries **what the agent needs to act without re-reading
  files**: path, side, line range, the exact code, a few lines of context with
  the anchored lines marked, the earlier messages, the new ones, and whether
  the code changed since. A comment made on part of the history also says
  which commits (`commented_on`), and whether that code is still in the whole
  diff.
- Chat messages come through as their own items.
- Delivery is tracked per message, so the page shows **Sending… / Queued
  offline → Sent → Seen by Claude → Claude replied**.
- While the agent waits, the page shows "Claude is listening". While it's off
  editing, "Claude is working". After 10 minutes without a tool call, "Claude
  hasn't checked in". Comments queue in the meantime.

**Waking an agent that isn't listening.** An agent in its terminal UI ends
its turn and waits for its user, so no `wait_for_feedback` is running when a
comment arrives. The MCP spec has no way to wake a model: servers can send
notifications, but clients don't turn them into turns (Codex logs them and
nothing more). Claude Code's research-preview "channels" can, but only for
stdio servers it spawns, behind a flag. So diffd uses each harness's hooks,
installed by `diffd setup claude|codex`:

- The hook (`diffd hook claude|codex`) runs in the background on
  SessionStart, UserPromptSubmit and Stop. It long-polls `GET /api/wake`
  with the session id and working directory. One waiter per session: each
  new one replaces the last (`DELETE /api/wake` on SessionEnd).
- The wait ends when there's feedback, on an open review of that repository
  touched in the last week, that no hook has woken anyone for yet, and once
  the user has paused (the same gate as `wait_for_feedback`). While hooks
  wait, the page shows the agent as listening.
- **Claude Code:** the hook is `async` with `asyncRewake`; exiting 2 wakes
  Claude with the notice on stderr.
- **Codex:** the hook is `async`; it runs `codex queue --thread <session>`,
  which adds the notice to the session's queue on Codex's shared app-server
  daemon (on by default): an idle session starts a turn, a busy one takes it
  after the current turn. Codex asks the user to trust new hooks once.
- The notice names the review (`review_id=…`), counts comments and chat
  messages, quotes the first few, and says to call `wait_for_feedback`.
- Either way the user can keep talking to the agent in its terminal. Once a
  hook has been seen for a repository, tool results tell the agent to end its
  turn when done instead of waiting in `wait_for_feedback`.
- Other agents: `diffd hook wait [--cwd] [--session] [--json]`.
- `scripts/e2e-wake.sh` tests both in their real terminal UIs, in tmux:
  Codex against a scripted stand-in for the OpenAI API
  (`scripts/mock-responses.py`, no network), Claude Code on a real model.

## 6. Data model and storage

We use **sqlx + SQLite** (`~/.local/share/diffd/diffd.db`, or `$XDG_DATA_HOME`).

- Migrations are embedded with `sqlx::migrate!`.
- Queries are compile-time checked (`query!`), with the offline data in `.sqlx/`
  checked in so Nix builds need no database.
- The SQL stays portable: no SQLite-only features in the schema logic.

```
reviews    id, title, summary, repo_path, repo_name, from_rev, to_rev (NULL = working tree),
           spec (json: pinned base, merge_base, paths, collapse rules, watch, regions),
           revision, status, created_at, updated_at
revisions  review_id, number, snapshot (zstd-compressed JSON), created_at   (the last 3 per review)
threads    id, review_id, kind (json: comment | note{kind, order}), anchor (json),
           resolved, changed_in, outdated, created_at
messages   id, review_id, thread_id (NULL = chat), author(user|agent), body, created_at, delivered_at
activity   seq (autoincrement), review_id, at, kind (json)
read_marks review_id, seq                                  (how far the user has read)
```

An **anchor** is a path, side, start and end line, the exact anchored text,
and, for comments made on part of the history, the commit range they were made
on.

Every review is kept, and the home page lists them. The only cleanup is an
explicit delete.

**The activity log** records what happened, in order: opened, user commented,
agent replied, agent noted, new revision, agent said, show request. Its `seq`
drives unread state: the page sends a read watermark, and the home page counts
agent activity past it. Undelivered user messages are simply rows with no
`delivered_at`, which is what `wait_for_feedback` reads.

**Viewed files and marks are per browser**, in localStorage (§8.10), not in the
database.

**Re-anchoring.** When a new revision arrives, each thread and region is
re-located (`diffd-core/src/anchor.rs`):

1. The exact anchored text, nearest to where it was. Same place: nothing
   changes. Elsewhere: the anchor moves.
2. Failing that, the old start line is mapped through the line alignment into
   the new file, the anchor keeps its length, and the thread is marked
   **changed in revision N**.
3. If the file's side is gone, the thread is marked **outdated**, as on GitHub.
   It stays visible.

## 7. Building a snapshot

A **snapshot** is one revision of a review: every changed file with full old
and new contents, the row alignment, novel-token ranges, syntax runs, and the
definitions found in them. It's built in Rust, in parallel across cores
(`rayon`).

### 7.1 Source: git

- **Which files:** `git diff --raw -z -M <base>`, plus untracked files
  (`git ls-files --others --exclude-standard`) when the review ends at the
  working tree. Agents create new files, and they must show up.
- **Contents:** read by blob id (so no path is ever misparsed) from one
  `git cat-file --batch` process; oversized blobs are skipped in the stream,
  never loaded. New sides are read from the worktree (the ids git prints for
  it can be hashes it never stored), or from `cat-file` for a fixed `to`.
  Worktree symlinks show their target path and are never followed; sizes are
  checked before reading.
- **Branch bases** use `git merge-base`, like a PR.
- **Commits:** `git log --first-parent` between the base and `to` (or `HEAD`),
  at most 300 of the newest.
- **Special files:**
  - Binary files, files over 3 MB and submodules are listed with the reason
    their contents aren't shown (`omitted`).
  - Changes the rows can't show are listed as `details` on the file: a mode
    change, CRLF ↔ LF, the newline at the end of the file, a submodule's
    commits.
  - Whitespace-only changes that difftastic ignores still show, via the line
    diff; plain text gets the line diff's word highlights, not whole lines.
  - Files matching the agent's `collapse` globs start collapsed, with its
    reason on the header.

We shell out to `git` itself rather than a reimplementation, so worktrees,
sparse checkouts, LFS pointers and config all behave exactly as in your shell.
The Nix package puts `git` on the binary's `PATH`.

### 7.2 Diff engine: difftastic, as a subprocess

difftastic runs as a separate program
(`crates/diffd-server/src/adapters/difft.rs`). For each modified file, diffd
writes both sides to a temp directory under the real file name (so difftastic
detects the language) and runs:

```sh
DFT_UNSTABLE=yes difft --display json --color never a/<name> b/<name>
```

`diffd-core/src/difft.rs` parses the JSON: the full line alignment
(`aligned_lines`) and, per changed line, the byte ranges of novel tokens.
Offsets are converted from bytes to UTF-16 for the browser.

The binary is found as `$DIFFD_DIFFT`, else `difft` on `PATH`. The Nix package
sets `DIFFD_DIFFT` to its own difftastic.

We started out planning to fork difftastic into a library. The subprocess won:
no fork to maintain, any installed difftastic works, and the JSON format,
though marked unstable, is small and easy to parse defensively.

**The line-diff fallback** (`diffd-core/src/linediff.rs`, patience diff via
`similar`, with word-level highlights on paired lines) is used when:

- difftastic isn't installed (the server logs a warning at startup),
- it times out (10 s) or its output can't be read,
- it reports no alignment (it does that for created and deleted files),
- the file is added, deleted or binary.

### 7.3 Syntax highlighting, baked on the backend

All language intelligence that doesn't need a language server is **baked on
the backend**, as Gitea does: parsing, highlighting and symbol extraction. The
browser never parses code. Each line ships as its text plus flat run lists:
`[start, end, class, …]` for syntax and `[start, end, …]` for novel tokens. A
small, tested function in the page merges them into non-overlapping spans.

We ship runs rather than ready-made HTML because:

- they're smaller;
- the page needs the plain text anyway (for search, anchors and the text sent to
  the agent), so there's one copy of it;
- escaping happens in exactly one place.

- **Engine:** `tree-sitter-highlight`, the same approach as GitHub, Zed, Helix
  and Neovim, with injections (e.g. code fences in Markdown).
- **Languages:** Rust, TypeScript, TSX, JavaScript, Python, Go, JSON, Bash,
  TOML, YAML, C, C++, CSS, HTML, Nix, Java, Ruby, Lua and Markdown, from the
  grammar crates in `diffd-core/Cargo.toml`. Others render as plain text.
- **Classes:** capture names map to 17 token classes (`SyntaxClass`, exported
  to the page by index), styled by Tailwind theme tokens, light and dark.
  Syntax colors stay clear of red and green so they never compete with the
  change colors.
- Files over 2 MB aren't highlighted.

Each line is drawn in three layers:

1. Syntax colors.
2. A strong red or green on difftastic's novel tokens.
3. A light tint on the changed line's number.

### 7.4 Symbols: tree-sitter tags

GitHub's search-based code navigation runs tree-sitter **tags queries**
(`@definition.function`, …) and looks symbols up by name. We do the same on
both sides of every file in the diff (`diffd-core/src/symbols.rs`). Each
definition carries its name, kind, position and the line span of the whole
definition, which the `if`/`af`/`ic`/`ac` text objects use (§8.12).

These ship in the snapshot, so they work offline. They're the fallback for
`gd` when there's no language server (§7.5). `grr` searches the diff's text
for the name.

### 7.5 Language servers

Language servers add go to definition, go to type definition, hover and
diagnostics (`crates/diffd-server/src/adapters/lsp/`).

- **Config:** `[lsp]` in the TOML config: on/off, request timeout, idle
  timeout, how many files to open per review, and one table per server with
  `command`, `args`, `languages` (LSP language id → file extensions),
  `root_markers`, and optional `env`, `initialization_options` and `settings`.
  The defaults configure rust-analyzer, typescript-language-server, pyright,
  gopls, nil and yaml-language-server. `diffd config` prints them.
- **Pool:** one process per (server, project root). The root is the nearest
  directory above the file with one of the server's root markers, else the
  repository root. Servers start on first use, stop when idle (15 min by
  default), and are restarted after a crash, up to three times (an exit is
  noticed as soon as its output ends, so nothing waits out a timeout). A server that
  isn't installed is remembered as broken, with the reason, and the page falls
  back quietly.
- **Only reviews of the working tree** get language servers: servers see files
  on disk, which is exactly the new side of such a review.
- **Files:** when a page connects, the review's new-side files are opened in
  their servers, and re-synced when a revision changes them. Files opened for
  context (§8.9) are opened too. Each server keeps at most `max_open_files`
  (300) open, closing the least recently synced first; deleted files are
  closed, so their diagnostics go away.
- **Over the page's WebSocket:** `ClientMsg::Code { request_id, query, path,
  line, col }` asks for a definition, type definition or hover, answered out of
  order by `ServerMsg::Code`. Diagnostics arrive as `ServerMsg::Diagnostics`
  per file, and are part of the full state.
- **On the page:** diagnostics are wavy underlines drawn with the CSS Custom
  Highlight API (no extra DOM in the rows), plus a gutter mark, and the status
  line shows the worst one on the cursor's line. `K` or hovering shows docs and
  errors. `gd` asks the server, but if the diff's own tags already know the
  name it waits at most 1.5 s before using them. Definitions outside the
  repository (a library's source) open as read-only context files; only paths a
  server pointed at can be opened that way.

`crates/diffd-server/tests/lsp.rs` runs real servers for each default language.

### 7.6 Rebuilds (watch)

Reviews of the working tree are watched with `notify`: one watcher per
repository, shared by its reviews, with a watch per directory. Directories that
never matter aren't watched at all (`.git/objects`, `.git/logs`,
`node_modules`, `target`, `.direnv`, `.venv`, and whatever the repository
ignores), which keeps big repositories within the system's limit on watches;
new directories are picked up as they appear. Only writes count: reads (a
rebuild reading the files, a language server opening them) are ignored, or
every rebuild would set off the next. Changes are debounced 300 ms, and a burst
during a rebuild leads to one more rebuild, not one per change. A rebuild:

1. re-reads the changed-file list and contents, and re-diffs them in parallel;
2. compares a fingerprint of all inputs with the last one, and stops if nothing
   changed;
3. marks the new-side lines that changed since the previous revision (`since`);
4. stores the revision, re-anchors threads and regions, re-reads the commit
   list, re-syncs language servers;
5. sends the new snapshot to open pages, and logs a "rev N · paths" activity
   item.

After a restart, reviews touched in the last week are watched again at once;
older ones when someone opens them. A new watch starts with one rebuild, to
catch edits made while it was being set up or while diffd wasn't running. Deleting a review stops its watch and tells
open pages, which stop reconnecting. `refresh` runs the same rebuild on demand.

## 8. The page

### 8.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ diffd · parser refactor · main → working tree · rev 3 · 12 files +340 −122  ● Claude listening │
├──────────────────┬───────────────────────────────────────────────────────┬───────────────┤
│ ⌕ filter files   │ Summary: Split the parser into lexer + parser…  ▾     │ Activity│Commits│
│ ▾ src            │ ▾ src/parser.rs                     M +40 −12  💬2  ☐ │ ● Claude      │
│   ▾ parser       │   38  fn parse(src) {         │  40  fn parse(src) {  │   replied     │
│     M lexer.rs  •│   39    let t = lex(src);     │  41    let t = Lexer::│   parser.rs:41│
│   M parser.rs 💬2│                               │  42    t.peek();      │ ○ rev 3 · 2   │
│   A tokens.rs    │  ┌ ✦ Claude · why ───────────────────────────────────┐│   files       │
│ ▸ tests          │  │ The lexer is now lazy so we can peek without…     ││               │
│                  │  └───────────────────────────────────────────────────┘│               │
│                  │   ┄┄┄┄┄┄┄┄ ↑5 · 84 lines · ↓5 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │               │
│                  │  ┌ you · L41–42 ───────────── Seen by Claude ────────┐│───────────────│
│                  │  │ why not keep this eager?                          ││ Marks         │
│                  │  │ ✦ Claude: peeking needs lookahead; eager lexing … ││ a parser.rs:41│
│                  │  └───────────────────────────────────────────────────┘│               │
├──────────────────┴───────────────────────────────────────────────────────┴───────────────┤
│ NORMAL  src/parser.rs:41 new  hunk 3/17                                   ]c hunk · ? keys│
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Header:** repo, `from → to`, revision, stats, agent presence and
  connection state. The summary (collapsible Markdown) sits above the diff.
- **Multibuffer (Zed):**
  - Every file is stacked in one scroll as excerpts.
  - File headers are sticky, and clicking one collapses that file.
  - **Split view only**, in difftastic's style: aligned old and new columns,
    line numbers tinted on changed lines, and color only on the tokens
    difftastic marks as novel. Unchanged code keeps plain syntax colors, even
    when it moved or was re-wrapped.
- **File tree (GitHub), in a drawer on the left:**
  - Drag its edge to resize it. Drag it to the edge to shrink it down to a
    thin handle; click the handle to bring it back.
  - Compact rows: collapsible folders, with single-child chains compacted.
  - Each file shows its status, a five-block `+/−` bar, comment count and an
    unread dot. Collapsed and viewed files are dimmed.
  - Each folder can also list its other files, the ones not in the diff
    (§8.9).
- **Right drawer:** the same kind of drawer, with two tabs and a panel.
  - **Activity:** a quiet, chronological feed: agent replies, new annotations,
    revisions ("rev 3 · 2 files"), chat, show requests. Unread items are
    marked. Clicking one, or `]n`, jumps there, and `ctrl-o` brings you back.
    When the drawer is shrunk to a handle, a small dot on it is the only
    signal.
  - **Commits:** the review's commits, when it spans any (§8.8).
  - **Marks**, underneath: your vim marks (§8.11).
- **Chat box**, docked under the diff, for anything not about specific lines.
  Claude answers there (`say`), and `path:line` references in its answers are
  links into the diff. `space i` focuses it.
- **Status line (vim):** mode, position, hunk n/m, the cursor line's worst
  diagnostic, key hints.

### 8.2 Selecting and commenting

- **Mouse:** select text across lines like in any editor. A small "Comment"
  button appears by the selection. You can also click a line number, and
  shift-click to extend.
- **The composer is a floating popover** right under the selection. Writing a
  comment never scrolls the page, and when the thread lands inline the line at
  the top of the screen stays where it was. Every DOM change above the
  viewport goes through one "keep the viewport pinned" helper
  (`state/dom.ts`).
- **Keyboard:** `V` or `v` starts a line selection, text objects grow it
  (§8.12), then `gc` (or `c`) to comment. `gcc` comments on the current line.
- **Anchors** store side, start and end line, and the selected lines' text.
  The agent gets exactly what you selected.
- **Threads** render inline under the last selected line:
  - Markdown, with fenced code highlighted.
  - Reply with `r` (the nearest thread) or the Reply button. Resolve and reopen
    with the button.
  - Delivery state shows as described in §5.3.
- Opening the composer tells the server you're drafting, which holds feedback
  back until you're done. A half-written comment survives a reload (§8.10).

### 8.3 Annotations, tests and folds

- **Annotations** have their own look (✦, a tinted card, and a label for their
  kind: explain / why / risk / question). `]a` / `[a` step through them in the
  agent's order. You can reply to one, and it becomes a thread.
- **Test regions** get a line along the far left of their rows. A whole-file
  test region marks the whole file.
- **Folds** start folded like context, but the gap row shows the agent's
  summary instead of a line count. Expanding one works like any other gap.
- **Generated files** start collapsed without the agent asking: lockfiles,
  `.sqlx` query data, minified bundles, protobuf output, and files with an
  `@generated` / `DO NOT EDIT` / `Code generated by` header
  (`diffd_core::kinds`). The agent's own `collapse` reason wins.
- **Labels.** Every file carries labels: `test` and `generated` found by
  path and contents, `test` from whole-file test regions, and the agent's
  (`labels: [{name: "frontend", files: ["web/**"]}]`). The files drawer shows
  one toggle per label; hiding one takes those files out of the buffer and
  the tree (and hiding `test` folds test line ranges too). Going to a hidden
  file (a thread on it, `show`) shows its labels again. Hidden labels are
  remembered per review.
- **Groups.** The agent can cluster the files into related changes (`groups:
  [{title, summary, files}]`, patterns in reading order). The Groups tab of
  the files drawer lists them; while it's open the buffer reads group by
  group with a header per group, `]f` follows that order, and files in no
  group come last under "Other changes". `annotate` replaces the groups.
  Patterns are paths, directories or globs, matched the same way on the
  server (which rejects one that names no file, as a typo) and the page.
- **The agent's name** is recorded when it shares, so the page says "Codex
  replied" to a Codex user. It comes from `?agent=` on the MCP URL (`diffd
  setup` registers `/mcp?agent=claude` or `?agent=codex`), else a known agent
  in the HTTP User-Agent, else the MCP client's name (`codex-mcp-client` →
  Codex). Library defaults (Claude Code's HTTP client says `rmcp`) are ignored.
- **New and deleted files** are one column of ordinary highlighted code,
  centred at the width of a split's side, with a coloured gutter line and a
  "New file" / "Deleted" badge, instead of a half-empty split in all green.
- **Reply toasts.** An answer that arrives while you read (in a thread or the
  chat) shows a small card in the corner of the code; clicking it goes to
  the reply. Toasts go when read, here or in another tab, or after 12 s.

### 8.4 Live updates

- **New revisions** patch the page in place. The reading position stays where
  it was, and files whose rows didn't change keep their folds.
- **Markers:** lines changed since the previous revision get a gutter marker and
  a brief highlight, and the status line says a revision arrived.
- **Threads** that moved follow their code; those whose code changed say so.
- **New commits** (the agent committed) update the Commits tab.

### 8.5 Offline

The page is one self-contained HTML document with the review's full state
embedded as JSON. **Everything about reading works without the server:**

- scrolling, expanding context, file view, search, symbol lookup within the diff
- existing threads and annotations
- the keymap

**Only the live parts need the server:**

- delivering comments, replies and chat (written offline, they wait in the
  outbox and are sent on reconnect; §8.10)
- agent replies and new revisions
- language servers, files outside the diff and other commits

The connection state is always visible, with the number of queued messages.

### 8.6 Context expansion, file view, Ctrl+F

- **Excerpts** start with 3 context lines. Gap rows offer `↑5 · all N · ↓5`,
  and `g e` expands whichever gap is nearest the cursor, growing toward it.
- **`g enter`** leaves the diff for **file view**: the plain file at the
  cursor, with no red and green. Thin marks in the gutter show what changed:
  green for added lines, yellow for changed lines, and a red notch where lines
  were removed. `ctrl-o` returns to the diff where you left it. `g space`
  opens the file view in a split instead (§8.11). You can comment in file view.
- **Ctrl+F (Cmd+F) opens our own search**, the same as `/`: every line of
  both sides, folded ones too, with the number of matches. Enter goes to the
  first match after the cursor (unfolding it if needed), `n` / `N` to the next
  and previous, wrapping around, and the status line says which match of how
  many. Matches on screen are highlighted (CSS Custom Highlight API); `esc`
  clears them. The diff is windowed (§10), so the browser's find could only
  see the rows near the screen. Nothing scrolls on its own.

### 8.7 When the agent wants to show you something

You talk to Claude in Claude Code as usual ("where does the timeout get
clamped?"). Claude calls `show`, and the page shows a small prompt at the bottom
of the diff:

> ✦ **Claude wants to show you something** · mcp.rs:35 · where the timeout gets
> clamped · **Show me** (`enter`) · **Later** (`esc`)

- **Show me** jumps there, with `ctrl-o` to come back. A file outside the diff
  opens for context (§8.9).
- **Later** leaves it in the activity drawer as unread.
- The page never scrolls by itself. What you're reading stays put.

### 8.8 Commit history

A review that spans commits lists them, oldest first along first parents, in
the Commits tab (`app/history.rs`, `web/src/lib/history.ts`). The points in
the history are the pinned base, each commit, and the working tree when the
review ends there ("Uncommitted changes").

- **Walk it:** `]r` / `[r` step one commit at a time; `space c` picks a commit;
  in the Commits tab, click a commit, shift-click another to take in the whole
  run between them. Going past either end returns to the whole review.
- **Any range:** `GET /api/reviews/{id}/range?from=<sha>&to=<sha>` (no `to` for
  the working tree) diffs exactly those two points, with the review's paths and
  collapse rules. The server checks that both are points in the review, and
  keeps the 24 most recently used range diffs in memory; a range asked for
  again while it's being diffed waits for that diff. Ranges ending at the
  working tree are dropped on every rebuild.
- **Walking is fast** because the next step is usually ready. After diffing
  one step, the server diffs the next one, the previous one and the one after
  next in the background (one at a time across reviews; a newer request takes
  over). The page keeps the 12 most recent ranges, fetches the step after the
  one shown (in the direction you're walking) when idle, keeps the old commit
  on screen until the new one is ready, and shows the commit it's loading in
  the header right away. Difftastic is most of the cost: typically 50–700 ms
  a step, up to its 10 s timeout on a pathological file.
- **Threads and regions** anchored in the whole diff are placed into the
  commit you're looking at by their text.
- **Comments on a commit** carry that range in their anchor. The server
  re-locates them in the whole diff by text, trying the same side first, then
  the other. If the code isn't in the whole diff any more (it only existed
  mid-history), the thread is marked outdated and the agent is told
  (`not_in_current_diff`).
- Expanded lines are remembered only for the whole review, not per commit.

### 8.9 Files outside the diff

Reviews often need code the change didn't touch.

- `GET /api/reviews/{id}/files` lists every file on the review's `to` side
  (tracked and untracked, minus ignored). The file tree uses it to show a
  folder's **neighbours**: files next to the changed ones.
- `GET /api/reviews/{id}/context?path=` returns one file, highlighted, as an
  unchanged "diff" (`FileStatus::Unchanged`). It opens in file view.
  Symlinks out of the repository aren't followed, files over 3 MB are listed
  but not opened, and binary files aren't rendered.
- **Comments work on any file**, not only the diff. The agent gets the code
  and context the same way.
- The agent's **`show` works for any repository file** (`app/context.rs`).
- Context files of working-tree reviews are opened in language servers, so
  they get diagnostics and `gd` too.

### 8.10 Tabs, the outbox and what a reload keeps

**The outbox** (`web/src/lib/socket.ts`). Comments, replies and chat messages
stay in an outbox, mirrored to localStorage, until the server acks their id.
Anything written offline, or lost with a dropped connection, is sent again on
reconnect, and the server ignores ids it already has, so resending is always
safe. Pending messages show inline as "Sending…" or "Queued offline". Other
messages only matter while connected: the latest resolve per thread and the
read watermark are kept; drafting and language-server questions are dropped.

**Several tabs** (`web/src/lib/tabs.ts`). Each tab has an id that survives
reloads (sessionStorage) and holds a Web Lock named after it while it's open.
Each tab has its own outbox, so tabs never overwrite each other's. When a tab
closes with messages unsent, the next tab to connect sees that no one holds
that id's lock and adopts its outbox. If two tabs adopt at once, idempotent ids
make the double send harmless. A duplicated tab gets a new id.

**Shared across tabs:** viewed files and marks live in localStorage and follow
`storage` events, so marking a file viewed in one tab marks it in all.

**Per tab, across reloads** (`web/src/state/persist.ts`): which lines are
expanded, which files are collapsed, the reading position, the cursor, and a
comment being written. This lives in sessionStorage, with the latest copy in
localStorage to start new tabs from. It's keyed by file path and checked
against each file's current shape before use, so a new revision never restores
nonsense.

### 8.11 Symbols, jumps, splits and marks

- **Symbol mode:** `w` / `b` put a cursor on the next / previous identifier on
  the line. `enter` or `gd` goes to its definition, and ctrl-click does the
  same with the mouse. Holding ctrl or cmd underlines everything that has a
  definition. `gt` goes to the type's definition and `K` shows hover docs
  (language servers, §7.5).
- **Jump list:** every jump (definition, hunk, note, file, activity, a link in
  chat, file view, show) goes onto a vim-style jump list. `ctrl-o` walks back
  and `ctrl-i` forward.
- **Splits:** `ctrl-\` splits the focused pane to the right, starting where it
  is; `ctrl-esc` closes it; `ctrl-h` / `ctrl-l` move focus. `g space` opens the
  plain file at the cursor in the next split, making one if there's only one
  pane. Each pane has its own cursor, mode
  and jump list; folds, threads and everything else are shared.
- **Marks:** `m{a-z}` sets a mark at the cursor; `'{a-z}` or `` `{a-z} `` jumps
  back. Marks are stored by path, side, line and the line's text, show as a
  letter in the gutter, and are listed in the right drawer's Marks panel.

### 8.12 Text objects

In visual mode, `i` / `a` plus a key grow the selection line-wise
(`web/src/lib/textObjects.ts`):

| keys | object |
|---|---|
| `ip` `ap` | paragraph: the run of non-blank lines, `a` with the blank lines after |
| `if` `af` | function, from the tree-sitter definitions (§7.4) |
| `ic` `ac` | class, struct, impl and the like, the same way |
| `i{` `a{` (`i}`, `iB`) | brace pair |
| `i(` `a(` (`i)`, `ib`) | paren pair |
| `i[` `a[` (`i]`) | bracket pair |
| `it` `at` | markup tag |
| `ih` `ah` | the hunk under the cursor |

`i` takes the inside, `a` includes the delimiting lines. Pairs and tags pick
the innermost one around the cursor.

## 9. Keymap

The leader key is `space`. Most bindings follow Zed's vim keymap. The whole
table is plain data in `web/src/state/bindings.ts`, which also generates the
`?` help screen.

| Keys | Action |
|---|---|
| `j` `k` `↓` `↑` (with counts) · `gg` `G` · `ctrl-d` `ctrl-u` | move |
| `tab` | switch old / new side (vim uses `ctrl-w h/l`, but browsers reserve `ctrl-w`) |
| `ctrl-o` / `ctrl-i` | jump back / forward |
| `w` / `b` | symbol mode: next / previous identifier on the line |
| `gd` / `ctrl-]` / `enter` (symbol mode) / ctrl-click | go to definition |
| `gt` | go to the type's definition (language server) |
| `K` | docs and errors here (or hover) |
| `grr` | find references |
| `gs` / `gS` | symbols in this file / in the diff |
| `]c` / `[c` | next / previous hunk, across files |
| `]f` / `[f` | next / previous file, skipping collapsed ones |
| `]a` / `[a` | Claude's notes, in order |
| `]t` / `[t` | next / previous thread |
| `]n` | next unread activity |
| `]r` / `[r` | next / previous commit, one at a time |
| `space c` | pick a commit to look at |
| `space v` | mark viewed, go to the next file |
| `g e` / `shift-enter` | expand the nearest folded lines |
| `za` · `zR` · `zM` | collapse / expand this file · show everything · back to hunks |
| `g enter` | file view: the plain file here |
| `g space` | the plain file here, in a split |
| `gcc` | comment on this line |
| `V` / `v` | select lines |
| `gc` / `c` (visual) | comment on the selection |
| `i…` / `a…` (visual) | text objects (§8.12) |
| `r` | reply to the nearest thread |
| `space i` | focus the chat box |
| `m{a-z}` · `'{a-z}` / `` `{a-z} `` | set a mark · jump to it |
| `ctrl-\` · `ctrl-esc` | split to the right · close this split |
| `ctrl-h` / `ctrl-l` | focus the split to the left / right |
| `space e` · `space n` | files drawer · activity drawer |
| `space f` / `ctrl-p` | go to file (fuzzy) |
| `/`, ctrl-f | search every line, hidden ones too; `n` / `N` next and previous match |
| `?` | key help |
| `esc` | close whatever is open, leave visual or symbol mode |

A small engine (`web/src/lib/keymap.ts`) runs the table, handling counts, modes
(normal, visual, symbol, file) and multi-key sequences. It's unit-tested.

## 10. Performance: 100k-line diffs

The target is a diff of 100k changed lines across many files, in Chromium on a
normal laptop: the first screen and keys working right away, cursor movement
and scrolling smooth, and the page as fast after an hour as after a minute.

How we get there:

- **A windowed multibuffer** (`web/src/components/Multibuffer.tsx`). Every
  file's header, rows, gaps, thread cards and end form one flat list of items
  (`web/src/state/layout.ts`), and only the items within a couple of screens
  of the viewport are in the DOM (a few hundred elements, whatever the diff's
  size), each file's in its own `<section>`. Rendering runs in the scroll
  event, before the frame is drawn, and reaches further ahead in the
  direction of scrolling (`web/src/components/WindowedList.tsx`). A list
  under ~12,000 px (a few hundred rows) is rendered whole.
- **Heights: estimated, then measured.** An item that hasn't been rendered is
  stood in for by its height: rows from how their code wraps in the current
  column width, the rest from typical sizes. Once rendered, items are
  measured, and an item above the viewport that differs from its estimate
  moves the scroll position by the difference, so nothing on screen moves.
  Heights are kept in a Fenwick tree (`web/src/lib/windower.ts`): the item at
  a scroll position and an item's offset are O(log n).
- **The reader's place is kept by the window.** Every layout change (a gap
  expanding, a file collapsing, a thread or a revision arriving) keeps the
  item at the top of the screen where it was. A collapsed file's header takes
  the place of its rows.
- **Sticky file headers** are one overlay showing the file at the top of the
  screen, pushed up by the end of its card.
- **Selections and the composer.** A text selection keeps the item it starts
  in rendered, and everything between, however far it's dragged. The comment
  composer follows its line from the window's heights when the line itself
  isn't rendered.
- **Keys work on the list, not the DOM.** The cursor, `j`/`k`, `]c`, `]f`,
  `G`, `]t` and jumps move through the list's row and hunk indices and then
  ask the window to reveal an item, which renders it right away.
- **Rows are HTML strings.** Rows are built by `web/src/lib/render.ts` as HTML
  and handed to the browser's parser. Everything around them is Solid.
- **Overlays, not per-row state.** The cursor, selections and diagnostics
  (CSS Custom Highlight API) don't re-render rows; they're painted again on
  the rows that come into the window.
- **Search is ours.** The browser's find can't see rows that aren't rendered,
  so Ctrl+F opens `/` (§8.6).
- **File view** is a windowed list too (one file's rows and its threads), so
  a huge file opens at once.
- **Compact wire.** The WebSocket is compressed (§4), and so are pages and
  JSON responses (zstd or gzip; a 9 MB review page is 1.3 MB). Reconnects and
  new revisions send only what the page doesn't have (§4). Snapshots are
  stored zstd-compressed.

There's no automated 100k-line benchmark yet (§15).

## 11. Frontend stack

**SolidJS.**

- **The workload fits Solid.** The hot path is 100k+ static rows plus tiny,
  frequent updates: the cursor at key-repeat speed, replies arriving, unread
  dots, presence. Solid updates exactly the DOM nodes involved, with no virtual
  DOM diff. The rows themselves drop to HTML strings (§10), which Solid lets us
  do without leaving the framework.
- **We don't need React's ecosystem.** This is a custom code viewer, not a form
  app.
- **It still looks familiar:** JSX and TypeScript.

**Type safety, end to end.**

- **One source of truth.** Every type the page shares with the server is
  defined once, in Rust (`diffd-core/src/model.rs`, `protocol.rs`): snapshot,
  state, WebSocket messages, boot data. The server describes them, and its
  JSON API, in OpenAPI (utoipa, utoipa-axum; served at `/api/openapi.json`,
  checked in as `web/openapi.json`), and hey-api generates the page's types
  and typed API client from that (`web/src/api/`, `just types`). The syntax
  class table is generated too (`web/src/gen/`). CI fails when any of them
  drift. MCP tool schemas come from Rust types too (`schemars`, via `rmcp`).
- **Messages are tagged unions** (`#[serde(tag = "type")]` becomes a TS
  discriminated union), handled with ts-pattern's exhaustive `match`, so
  adding a message type is a compile error until every consumer handles it.
- **IDs are newtypes** (`ReviewId`, `ThreadId`, `MessageId`) in Rust. In TS
  they're plain string aliases.
- **Strict at the boundaries:**
  - TS runs with `strict`, `noUncheckedIndexedAccess` and
    `exactOptionalPropertyTypes`, and Biome forbids `any` and non-null
    assertions.
  - Page messages and MCP inputs use `deny_unknown_fields`.
  - sqlx checks every query against the schema at compile time.

**Code style.** Exhaustive matching goes through **ts-pattern**
(`match(x).with(...).exhaustive()`). Data crossing a boundary is typed by the
generated Rust types, so there's nothing to cast.

**Styling.** Tailwind v4, with colors and sizes defined once as theme tokens,
light and dark. The diff rows are styled with plain classes in `styles.css`,
since they're HTML strings.

| purpose | tool |
|---|---|
| UI | SolidJS, Tailwind v4, Kobalte (dialogs) |
| pattern matching | ts-pattern |
| build | Vite, TypeScript (strict), `vite-plugin-singlefile` (one HTML document) |
| lint and format | Biome |
| unit tests | Vitest (jsdom) |
| end-to-end tests | Playwright |
| Markdown | markdown-it (raw HTML off) + DOMPurify |

The drawers, pickers, fuzzy matching and icons are small hand-written pieces.

## 12. Repo layout and quality bar

The server is laid out **hexagonally (ports and adapters)**:

- **Pure logic** lives in `diffd-core` and never touches IO: the model and
  protocol, turning old/new contents plus engine output into a snapshot,
  highlighting, tags, the line diff, anchoring, and feedback batching.
- **Ports** (`diffd-server/src/ports.rs`) are small traits: `RepoSource` (git),
  `DiffEngine` (difftastic), `CodeIntel` (language servers), `Clock`.
- **Use cases** (`diffd-server/src/app/`) are written once against them:
  share, conversation (comment, reply, resolve, notes, regions, chat, show),
  feedback, rebuild, history, context, code.
- **Adapters** (`diffd-server/src/adapters/`): git CLI, difftastic subprocess,
  sqlx store, notify watcher, LSP pool, axum HTTP + WebSocket, rmcp MCP.

```
diffd/
├── Cargo.toml                   workspace: shared deps, lints, release profile, tungstenite patch
├── crates/
│   ├── diffd-core/              pure: model + protocol (→ OpenAPI → TS), snapshot building,
│   │                            tree-sitter highlighting + tags, line diff, anchoring, feedback gate
│   ├── diffd-server/            app: use cases over ports, adapters, config
│   │   ├── src/app/             share, conversation, feedback, rebuild, history, context, code
│   │   ├── src/adapters/        git, difft, store, watch, lsp/, http, mcp
│   │   ├── config.default.toml  the documented default config
│   │   ├── migrations/
│   │   └── tests/               integration tests
│   └── diffd/                   the binary: CLI (serve, setup, config), wiring; embeds the web build
├── vendor/tungstenite/          Signal's tungstenite fork (permessage-deflate)
├── .sqlx/                       sqlx offline query data
├── web/                         SolidJS + TypeScript + Vite
│   ├── src/{gen,lib,state,components}
│   └── e2e/full.mjs             the end-to-end run
├── scripts/                     demo repo, demo share, a small MCP client
├── nix/package.nix              web build → rust build (page baked in) → one binary, git + difftastic on hand
├── flake.nix                    packages, app, devShell
├── justfile                     setup · web · build · dev · dev-web · check · lint · test · types · sqlx · demo · e2e
└── docs/DESIGN.md
```

**The web build is baked into the binary.** Vite produces one HTML document,
which `crates/diffd/build.rs` embeds at compile time (from `web/dist`, or
`$DIFFD_WEB_DIST`). The server fills in the review's state when serving it.
Without a web build, a placeholder page says how to build one. You install one
file.

**Packaging.** `nix build` (or `nix run github:404wolf/diffd`) builds the page
with `buildNpmPackage` and `importNpmLock` (no separate dependency hash to
maintain), then the Rust binary with the page baked in, wrapped with `git` on
`PATH` and `DIFFD_DIFFT` pointing at difftastic. The devShell has the Rust and
Node toolchains, sqlx-cli, difftastic, just and python.

**Quality bar:**

- **Rust:** `clippy -D warnings`, `rustfmt`, `forbid(unsafe_code)`; unit tests
  in the core modules; sqlx compile-checked queries.
- **TypeScript:** strict mode; Biome; typecheck.
- **CI** (GitHub Actions) runs `just lint` and `just test`, the end-to-end run
  with difftastic and real language servers installed, and `nix build`.

## 13. Testing

- **Rust unit tests** in `diffd-core` and the server: difftastic JSON parsing,
  line diff, highlighting, tags, text offsets, anchoring, the feedback gate,
  config merging, the git adapter, LSP conversions.
- **Rust integration tests** (`crates/diffd-server/tests/`) run the app
  against throwaway git repos:
  - `review_loop.rs`: share → comment → wait → reply → edit → revision.
  - `http_mcp.rs`: the real server with an `rmcp` client as the agent and a
    WebSocket as the page.
  - `history.rs`: walking commits, diffing any two, re-locating comments made
    on a commit, new commits after a rebuild.
  - `context.rs`: listing and opening files outside the diff, not following
    symlinks out of the repository, comments and `show` on those files.
  - `lsp.rs`: real language servers (rust-analyzer, typescript-language-server,
    pyright, gopls, nil, yaml-language-server) for definition, type definition,
    hover and diagnostics, and several at once. A test is skipped when its
    server isn't installed.
- **Vitest unit tests** (`web/src/lib/lib.test.ts`) on the page's pure logic:
  line rendering, excerpts and gaps, the keymap engine, the file tree (with
  neighbours), the jump list, Markdown links, regions, history spans and text
  objects.
- **End to end** (`web/e2e/full.mjs`, `just e2e`): Playwright plays the user
  while a small MCP client plays the agent, against a real server and the demo
  repository (`scripts/demo-repo.py`). It walks the whole product: navigation,
  symbols and the jump list, file view, folds and tests, commenting by keys
  and mouse, the agent's replies, chat, show, live revisions, late notes and
  regions, pickers and search, drawers and viewed files, splits, files outside
  the diff, marks, text objects, offline comments (it stops and restarts the
  server), several tabs, walking commits, language servers, and the home page.
  Screenshots are kept when it fails.
- **Trying it by hand:** `just dev`, then `just demo` shares a multi-language
  demo change and prints the link. For the agent side, `diffd setup claude`.

## 14. Dropped plans

For the record, things the earlier draft planned that we didn't do:

- **Forking difftastic into a library.** It's a subprocess (§7.2).
- **Event-log resume by `seq`.** Pages get the full state on connect instead,
  and idempotent ids make resending safe (§4, §8.10).
- **Revisions as deltas.** A new revision sends the whole snapshot; the socket
  is compressed.
- **A repo-wide tree-sitter symbol index.** Language servers cover symbols
  outside the diff.
- **Automatic collapse of lockfiles and `linguist-generated` files.** The
  agent's `collapse` rules do this.
- **A columnar, gzip-in-page snapshot encoding.** The state is embedded as
  JSON.
- **corvu, fzf and Octicons** in the frontend; the few pieces they'd cover are
  hand-written.
- **Pushing feedback into Claude Code** instead of long-polling; there's no
  such channel to rely on, and `wait_for_feedback` works everywhere.

## 15. Still open

- **Pipe input and static export:** `git diff | diffd` and `diffd -o
  review.html`. The page is already self-contained, so this is mostly a CLI
  command plus a way to build a snapshot from a patch.
- **CI → Gitea links:** open a review from a CI run or a Gitea PR.
- **herdr plugin.** herdr plugins declare actions, event hooks and panes in
  `herdr-plugin.toml`, and drive herdr through its CLI. Start a review from a
  worktree; the plugin finds that workspace's agent pane and bridges it to
  diffd.
- **Postgres**, then hosted and multi-user. The SQL is kept portable for this.
- **Past revisions and interdiff:** every revision is stored, but the page
  only shows the latest. A revision picker and "what changed since rev N"
  would build on that.
- **A 100k-line benchmark** in CI, measuring time to first screen, time to
  full render and keypress latency.
- **Staging and restoring hunks** from the page (Zed's `du` / `dp`).
- **Highlighting the long tail of languages** (e.g. syntect with bat's
  grammars).
- **Unified view**, alongside split view.
- **Language servers for fixed-revision reviews**, which would need the old
  and new sides materialized on disk.
- **User keymap overrides.** The keymap is data, so this is mostly loading it.
