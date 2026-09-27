# diffd: design

Status: **draft v2, for discussion.** Nothing is built yet. Once we agree on
this document, v1 gets implemented against it in full.

## 1. The product

diffd turns an agent's code changes into a **live code review in your browser**.

1. The agent opens a *magic diff* through MCP.
2. It annotates the tricky parts in plain language.
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
  │                                                           │     annotations)        │
  │                                                           │── url ─────────────────▶│
  │ ◀──────────────────────────────────── "review it here: http://127.0.0.1:3433/r/k3f9"│
  │ open link ───────────────▶│ summary, file tree,           │                         │
  │                           │ multibuffer, Claude's notes   │                         │
  │ select L41–47, comment ──▶│── comment ───────────────────▶│── feedback ────────────▶│ (§5.3)
  │ keep scrolling …          │                               │◀── reply(thread, body) ─│
  │                           │◀── reply (live) ──────────────│                         │ edits code
  │ subtle "Claude replied"   │                               │ files changed → rebuild │
  │ in the activity sidebar   │◀── revision 2 (live) ─────────│                         │
  │ ]n jumps there, ctrl-o back                               │                         │
```

Step by step:

1. You ask for something, and Claude edits code.
2. Claude calls `share_diff`. diffd snapshots the diff and returns a URL, which
   Claude posts in the chat.
3. You open the link and see:
   - the summary on top, like a PR description
   - the file tree
   - the multibuffer
   - Claude's annotations next to the code they explain, which you can step
     through as a tour
4. You select a region and comment on it. The comment is sent as soon as you
   save it.
5. Claude receives the comment, answers inline, and maybe edits code.
6. Files change on disk. diffd rebuilds only those files and pushes a new
   revision. The page updates in place without moving your scroll. Lines
   changed since the previous revision get a marker. Threads whose code changed
   say so.
7. Meanwhile you've kept reading. Replies to threads above you show up as quiet
   entries in the activity sidebar and as dots in the file tree. Nothing pops
   up or steals focus.
8. You can also talk to Claude in Claude Code and ask it to show you
   something ("where does the timeout get clamped?"). A small prompt appears on
   the page, "Claude wants to show you mcp.rs:35", with **Show me** / **Later**.
   It never moves your scroll on its own.

There's no review-level "submit" and no global comment box. **Every comment is
anchored to a chunk of code**, like a multi-line PR comment, and the
conversation just keeps going: Claude answers or edits as you comment, and the
diff keeps up.

## 3. Scope

**v1:** everything in §2, local, single user:

- MCP server
- live web UI
- SQLite storage
- live updates as files change
- annotations, threads and the activity sidebar
- vim keys
- symbol lookup
- works offline for reading

**Later (§14):**

- `git diff | diffd` and static HTML export. The page is already
  self-contained, so this is mostly a CLI command.
- CI → Gitea
- herdr plugin
- LSP
- Postgres and hosted/multi-user
- staging hunks from the UI

## 4. Process model and setup

```sh
diffd                      # = diffd serve: one local server on 127.0.0.1:3433
diffd setup claude         # runs: claude mcp add --scope user --transport http diffd http://127.0.0.1:3433/mcp
```

One long-running server handles everything:

| route | what |
|---|---|
| `/mcp` | MCP over Streamable HTTP (`rmcp`) |
| `/` | recent reviews, newest first: title, repo, branch, when, unread. Dead simple. |
| `/r/{id}` | the review page, a self-contained HTML document |
| `/api/reviews/{id}/ws` | the page's WebSocket (below) |

**The page talks to the server over one typed WebSocket.** Every message in
either direction is a tagged union defined in Rust and generated into TS (§11):

- **Page → server:** comment, reply, resolve, drafting on/off, read receipts,
  viewed files.
- **Server → page:** new revision (as a delta), thread and message events,
  delivery state, agent presence, "show you something" requests.

The server turns what the page sends into feedback for the agent (§5.3), and
turns the agent's MCP calls into messages for the page. Each message carries
the event log's `seq`, so a page that reconnects resumes exactly where it
left off.

**Why one HTTP server instead of a stdio MCP process per agent session:**

- Many agents share one server and one port.
- Review URLs and state survive agent restarts.
- MCP handlers and web pages share state in-process, with no IPC.

This is also the natural place for the herdr plugin to hook in later. Run it in
a terminal, or as a user service. A Nix home-manager module is planned for
later.

**Security.**

- The server binds to localhost only.
- It rejects requests whose `Host` isn't localhost (DNS rebinding).
- It rejects write requests whose `Origin` isn't its own (CSRF).

This matters because **comments become LLM input**: a random website must not
be able to post comments to your agent. Agent-written Markdown is rendered with
raw HTML disabled and then sanitized.

## 5. MCP interface

### 5.1 Server instructions

The MCP `initialize` result carries instructions that Claude Code puts in the
model's context. They teach the workflow:

- **When to share:** after a meaningful change, or when the user asks to review.
- **Annotations:** how to write good ones (§5.2).
- **The link:** always give it to the user.
- **Listening:** how to listen for feedback.
- **Replies:** answer each thread concisely, inline, where the code is.
- **Fixes:** say what you changed, then let the live diff show it.

### 5.2 Tools

| tool | purpose |
|---|---|
| `share_diff` | open a magic diff, returns `{ review_id, url, revision, stats }` |
| `wait_for_feedback` | block until the user comments or replies (§5.3) |
| `reply` | reply in a thread; optionally resolve it |
| `annotate` | add annotations, or start a new thread (e.g. a question for the user) |
| `refresh` | rebuild now, with an optional note ("addressed the parser comments") |
| `say` | a chat message to the user, shown in the page's chat box |
| `show` | point the user at code: `{ review_id, file, lines, side?, message }`. The page shows a prompt, never an automatic jump. |
| `get_review` | full current state (threads, statuses, revision), to recover context |

```ts
share_diff({
  repo_path: string,        // absolute path of the repo/worktree (the agent's cwd)
  from: string,             // any rev: a branch ("main"), tag, commit, "HEAD~3"
  to?: string,              // any rev; omitted = the working tree (uncommitted + untracked files)
  merge_base?: boolean,     // default true when `from` is a branch: diff from merge-base(from, to), like a PR
  paths?: string[],         // limit to these paths
  collapse?: { glob: string, reason: string }[],  // start these collapsed: generated code, lockfiles, vendored files
  title: string,
  summary?: string,         // markdown: what changed and why, shown at the top
  annotations?: Annotation[],
  watch?: boolean,          // default true when `to` is the working tree: update live as files change
})

Annotation = {
  file: string,
  lines: [number, number],  // 1-based inclusive, in the new version unless side = "old"
  side?: "new" | "old",
  body: string,             // markdown
  kind?: "explain" | "why" | "risk" | "question",
}                           // array order = tour order
```

Any two revisions can be compared: `from: "main"` with `to` omitted is "my
branch plus what I haven't committed"; `from: "v1.2.0", to: "v1.3.0"` compares
two tags. A review with a fixed `to` doesn't watch anything.

The description also tells the agent to pass `collapse` for files a reviewer
shouldn't have to scroll past: generated code, lockfiles, snapshots, vendored
code. Those files start collapsed with the agent's reason on their header, and
`]f` / `[f` skip them.

The `share_diff` description tells the agent **what to annotate**:

- Annotate what a reviewer would trip over: non-obvious logic, the reason behind
  a design choice, risky spots, anything it's unsure about.
- Skip the obvious.
- Use plain language, 1–4 sentences each, with tight line ranges.
- Order the annotations as a tour that reads well from start to finish.

Every event that reaches the agent carries **what it needs to act without
re-reading files**:

- file, side and line range
- the selected code
- the surrounding hunk
- the thread so far

Every tool result also carries a pending-feedback count, so an agent busy
editing still notices you.

### 5.3 How your comments reach the agent

**Baseline, portable to every MCP client: `wait_for_feedback`.**

- It long-polls. It returns as soon as there's feedback, or empty after
  `timeout_seconds` with a hint to call again.
- It waits for a short quiet period, and for any open comment draft to be
  saved, before returning. So writing three comments in a row wakes the agent
  once, not three times.
- Delivery is tracked per comment, so the page can show **sent → seen by
  Claude → replied**.
- While the agent waits, the page shows "Claude is listening". While it's off
  editing, it shows "Claude is working; it'll see this next time it checks".
  Comments queue until then.

**Push, where the client supports it.** If Claude Code lets an MCP server push
messages into a running session, diffd pushes each batch of feedback that way.
The agent can then keep working without sitting in `wait_for_feedback`. This is
detected at connect time, with long-polling as the fallback. *(The research on
what Claude Code supports here is in progress. This section gets finalized with
exact names.)*

## 6. Data model and storage

We use **sqlx + SQLite** (`~/.local/share/diffd/diffd.db`).

- Migrations are embedded with `sqlx::migrate!`.
- Queries are compile-time checked (`query!`), with the offline data in `.sqlx/`
  checked in so Nix builds need no database.
- The SQL stays portable: no SQLite-only features in the schema logic. Postgres
  later means a second migrations directory plus a feature flag.

```
reviews    id, repo_path, base, paths, title, summary, watch, status(open|closed), created_at, updated_at
revisions  review_id, number, created_at, snapshot (zstd-compressed), stats, note
threads    id, review_id, kind(comment|annotation), annotation_kind, tour_order,
           anchor (side, start line/col, end line/col, revision, anchored text),
           status(open|resolved|outdated), created_at
messages   id, thread_id, author(user|agent), body, created_at, delivered_at, read_at
events     seq (monotonic), review_id, type, payload(json), created_at
cursors    review_id, consumer(page|agent), seq
file_views review_id, path, viewed_at_revision            (GitHub-style "viewed" checkboxes)
```

Every review you open is kept, and the landing page lists them. The only
cleanup is an explicit "delete", so you can go back to old diffs.

**The event log is the backbone.**

- Every change appends an event: new thread, message, status change, revision,
  presence, show requests.
- WebSocket clients resume from their last `seq` after a reconnect.
- `wait_for_feedback` reads from the agent's cursor.
- Nothing gets lost when either side drops.

**Re-anchoring.** When a new revision arrives, each thread's anchor is
re-located:

1. The exact text at the old position, mapped through the line alignment.
2. Failing that, the nearest exact match of the anchored text in the file.
3. Failing that, the thread is marked **outdated**, as on GitHub. It stays
   visible, attached to where it was.

## 7. Building a snapshot

A **snapshot** is one revision of a review: every changed file with full old
and new contents, alignment, changed-token ranges, syntax tokens and symbols.
It's built in Rust, in parallel across cores (`rayon`).

### 7.1 Source: git

- **Which files:** `git diff --name-status -z -M <base>`, plus untracked files
  (`git ls-files -o --exclude-standard`). Agents create new files, and they
  must show up.
- **Contents:** old sides come from one `git cat-file --batch` process. New
  sides are read from the worktree.
- **Branch bases** use `git merge-base`, like a PR.
- **Special files:**
  - Binary files are listed and not rendered.
  - Submodules show as a commit change.
  - `.gitattributes` `-diff` and `linguist-generated` files, and lockfiles, are
    collapsed by default, as on GitHub.

We shell out to `git` itself rather than a reimplementation, so worktrees,
sparse checkouts, LFS pointers and config all behave exactly as in your shell.

### 7.2 Diff engine: difftastic, forked into a library

difftastic ships as a binary. We **fork it** and add a small `lib.rs` exposing:

- `diff(old, new, path_hint)` → language, the full line alignment
  (`aligned_lines`), and novel ranges per side.
- The per-language `tree_sitter::Language` and queries, so highlighting and
  symbols reuse the same grammars (~60 languages).

Why fork instead of calling the `difft` binary:

- **One binary.** No subprocess per file, no temp files.
- **Stable Rust types**, instead of a JSON format difftastic marks unstable.
- **One set of grammars** for diffing, highlighting and navigation.

The fork keeps its patch small and upstreamable, and is pinned by commit.

Safety valves:

- Files past difftastic's limits, or that time out, fall back to a line diff
  with word-level highlights (`imara-diff`, the diff library behind gitoxide and
  Helix).
- Offsets are converted from bytes to UTF-16 for the browser. We checked that
  difftastic reports byte offsets.

### 7.3 Syntax highlighting (GitHub-grade, baked on the backend)

All language intelligence is **baked on the backend**, as Gitea does: parsing,
diffing, highlighting and symbol extraction. The browser never parses code.
Each line ships as its text plus a compact run list of `(start, end, class)`.
The run list covers both syntax classes and difftastic's change emphasis,
merged into non-overlapping segments, so there's no nesting. A tiny, tested
function in the page turns runs into spans.

We ship runs rather than ready-made HTML strings because:

- they're about half the size;
- the page needs the plain text anyway (for search, anchors and the text sent to
  the agent), so there's one copy of it;
- escaping happens in exactly one place.

difftastic's own highlighting only has about 6 token kinds, which isn't enough.

- **Engine:** `tree-sitter-highlight`, the same approach as GitHub, Zed, Helix
  and Neovim. It runs on the fork's grammars, with injections (e.g. JS in HTML,
  code fences in Markdown).
- **Queries:** we start from each grammar's `highlights.scm`. For the languages
  that matter most (Rust, TS/TSX/JS, Python, Go, Nix, Bash, C/C++, Lua, JSON,
  YAML, TOML, Markdown, CSS/HTML), we bring in richer queries from
  nvim-treesitter (Apache-2.0) or Helix (MPL-2.0), adapted to standard
  predicates.
- **Themes:** capture names map to our own syntax token set (the same
  Tailwind theme as the rest of the UI), light and dark. Syntax colors stay
  clear of red and green so they never compete with difftastic's change
  colors.
- **Unknown languages** render as plain text in v1. A long-tail fallback
  (syntect with bat's grammars) is a later add-on.

Each line is drawn in three layers:

1. Syntax colors.
2. A strong red or green on difftastic's novel tokens.
3. A light tint on the changed line.

### 7.4 Symbols: GitHub-style search-based navigation

GitHub's search-based code navigation runs tree-sitter **tags queries**
(`@definition.function`, `@reference.call`, …) and looks symbols up by name,
ranked by locality. No build step, no language server. We run tags queries on
the same grammars.

- **Embedded in the page:** definitions from every file in the diff, both
  sides. Works offline.
- **Live, from the server:** a repo-wide index built lazily and kept fresh by
  the watcher. `gd` on a symbol defined in an unchanged file opens a Zed-style
  excerpt of that file.

LSP can slot in behind the same API later.

### 7.5 Incremental rebuilds (watch)

The watcher (`notify`, debounced ~300 ms) re-diffs only files whose content
changed. Results are cached by `(path, old hash, new hash)`. Nothing is written
or pushed when no content changed. New revisions go to pages as **deltas**:
only the changed files.

## 8. The page

### 8.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ diffd · parser refactor · main ← feat/parser · rev 3 · 12 files +340 −122   ● Claude listening │
├──────────────────┬───────────────────────────────────────────────────────┬───────────────┤
│ ⌕ filter files   │ Summary: Split the parser into lexer + parser…  ▾     │ Activity      │
│ ▾ src            │ ▾ src/parser.rs                     M +40 −12  💬2  ☐ │ ● Claude      │
│   ▾ parser       │   38  fn parse(src) {         │  40  fn parse(src) {  │   replied     │
│     M lexer.rs  •│   39    let t = lex(src);     │  41    let t = Lexer::│   parser.rs:41│
│   M parser.rs 💬2│                               │  42    t.peek();      │ ○ rev 3 · 2   │
│   A tokens.rs    │  ┌ ✦ Claude · why ───────────────────────────────────┐│   files       │
│ ▸ tests          │  │ The lexer is now lazy so we can peek without…     ││   changed     │
│                  │  └───────────────────────────────────────────────────┘│ ○ you comm-   │
│                  │   ┄┄┄┄┄┄┄┄ ↑5 · 84 lines · ↓5 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │   ented …     │
│                  │  ┌ you · L41–42 ───────────── seen by Claude ────────┐│               │
│                  │  │ why not keep this eager?                          ││               │
│                  │  │ ✦ Claude: peeking needs lookahead; eager lexing … ││               │
│                  │  └───────────────────────────────────────────────────┘│               │
├──────────────────┴───────────────────────────────────────────────────────┴───────────────┤
│ NORMAL  src/parser.rs:41 new  hunk 3/17  note 2/5        ]c hunk · ]a note · gc comment · ? │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Header:** the summary (collapsible Markdown), plus a revision picker once
  there's more than one revision.
- **Multibuffer (Zed):**
  - Every file is stacked in one scroll as excerpts.
  - File headers are sticky, and clicking one collapses that file.
  - **Split view only**, in difftastic's style: aligned old and new columns,
    line numbers tinted on changed lines, and color only on the tokens
    difftastic marks as novel. Unchanged code keeps plain syntax colors, even
    when it moved or was re-wrapped. Unified view can come later.
- **File tree (GitHub), in a drawer:**
  - Drag its edge to resize it. Drag it to the edge to shrink it down to a
    thin handle; click the handle to bring it back. No toggle button.
  - Compact rows: collapsible folders, with single-child chains compacted and
    indent guides.
  - Each file shows its status, a five-block `+/−` bar, comment count and an
    unread dot. Collapsed and viewed files are dimmed.
  - The tree follows your scroll.
- **Activity sidebar:** the same kind of drawer, on the right.
  - A quiet, chronological feed: agent replies, new annotations, revisions
    ("rev 3 · 2 files"), resolved threads.
  - Unread items are marked. Clicking one, or `]n`, jumps there, and `ctrl-o`
    brings you back.
  - When it's shrunk to a handle, a small dot on the handle is the only
    signal.
- **Chat box**, docked under the diff. A simple place to ask Claude anything
  that isn't about specific lines. Claude answers there (`say`), and code
  references in its answers are links into the diff. `space i` focuses it.
- **Status line (vim):** mode, position, hunk n/m, note n/m, key hints.

### 8.2 Selecting and commenting

- **Mouse:** select text across lines like in any editor. A small "Comment"
  button appears by the selection. You can also click a line number, and
  shift-click to extend.
- **The composer is a floating popover** right under the selection, in the
  page's theme. Writing a comment never scrolls the page, and when the thread
  lands inline the line at the top of the screen stays exactly where it was.
  This is a rule for every DOM change in the app: it goes through one
  "keep the viewport pinned" helper.
- **Keyboard:** `V` (line) or `v` (char) visual mode, then `gc` to comment. `gcc`
  comments on the current line.
- **Anchors** store side, start/end line and optional column, plus the selected
  text. The agent gets exactly what you selected.
- **Threads** render inline under the last selected line:
  - Markdown, with fenced code highlighted.
  - Reply with `r`. Resolve/unresolve with the button or `x`.
  - Delivery state shows as sent / seen by Claude / replied.

### 8.3 Annotations and the tour

- **Style:** agent annotations have their own look (✦, a tinted card, and a
  label for their kind: explain / why / risk / question). The code range they
  cover is marked in the gutter.
- **Tour:** `]a` / `[a` step through them in the agent's order.
- **Replies:** you can reply to an annotation, and it becomes a thread.

### 8.4 Live updates

- **New revisions** patch the page in place. The top visible line stays exactly
  where it was.
- **Markers:** lines changed since the previous revision get a gutter marker and
  a brief highlight.
- **Viewed:** files you'd marked viewed are un-marked if they change.
- **Missing files:** if a file you're looking at disappears from the diff, its
  section stays greyed out until you move on.
- **Revision picker:** view any past revision.
- **Interdiff:** a full "rev 2 → rev 3" view (§14) builds on this.

### 8.5 Offline

The page is one self-contained HTML document. It embeds the latest revision,
compressed, with full file contents, and it needs no network. **Everything
about reading works offline:**

- scrolling, expanding context, file view, search, symbol lookup within the diff
- existing threads and annotations
- the keymap

**Only the live parts need the server:**

- delivering comments (written offline, they're queued in IndexedDB and sent
  when the server is back)
- agent replies
- new revisions
- repo-wide symbol lookup

The connection state is always visible.

### 8.6 Context expansion, file view, Ctrl+F

- **Excerpts** start with 3 context lines. Gap rows offer `↑5 · all N · ↓5`,
  and `shift-enter` expands around the cursor (Zed's `ExpandExcerpts`).
- **`g enter`** leaves the diff for **file view**: the plain file at the
  cursor, at the current revision, with no red and green. Slight marks in the
  gutter show what changed: green for added lines, yellow for changed lines,
  and a red notch where lines were removed. `ctrl-o` returns to the diff
  where you left it.
- **Ctrl+F is never intercepted, and nothing scrolls on its own.**
  - Collapsed context is kept in the DOM as `hidden="until-found"`. Browser find
    searches it, and on a match the gap expands (`beforematch`).
  - `/` is our own search over everything embedded, with `n` / `N`.
- **No virtualization**, because virtual rows are invisible to Ctrl+F. §10
  covers how that still scales to 100k lines.

### 8.7 When Claude wants to show you something

You talk to Claude in Claude Code as usual ("where does the timeout get
clamped?"). Claude calls `show`, and the page shows a small prompt at the bottom
of the diff:

> ✦ **Claude wants to show you something** · mcp.rs:35 · where the timeout gets
> clamped · **Show me** (`enter`) · **Later** (`esc`)

- **Show me** jumps there, with `ctrl-o` to come back.
- **Later** files it in the activity sidebar as unread.
- The page never scrolls by itself. What you're reading stays put.

### 8.8 Symbol mode and the jump list

- `w` / `b` put a cursor on the next / previous identifier on the line. That's
  symbol mode. `enter` or `gd` goes to its definition, and ctrl-click does the
  same with the mouse. Holding ctrl or cmd underlines everything that has a
  definition.
- Every jump (definition, reference, hunk, note, file, activity, a link in
  chat, file view) goes onto a vim-style **jump list**. `ctrl-o` walks back and
  `ctrl-i` walks forward, across the diff and file view alike.

## 9. Keymap

The leader key is `space`. Bindings come from Zed's
`assets/keymaps/vim.json` unless the "From" column says otherwise.

| Keys | Action | From |
|---|---|---|
| `j` `k` `gg` `G` `ctrl-d` `ctrl-u`, counts | move | vim |
| `w` / `b` | symbol mode: next / previous identifier; `enter` goes to its definition | vim |
| `tab` | switch old / new side | diffd (vim uses `ctrl-w h/l`, but browsers reserve `ctrl-w` to close the tab) |
| `]c` / `[c` | next / previous hunk, across files | Zed `editor::GoToHunk` |
| `]f` / `[f` | next / previous file, skipping collapsed and viewed files | diffd |
| `]a` / `[a` | next / previous annotation (tour) | diffd |
| `]t` / `[t` | next / previous thread | diffd |
| `]n` / `[n` | next / previous unread activity | diffd |
| `shift-enter` | expand context around the cursor | Zed `editor::ExpandExcerpts` |
| `za` · `zR` · `zM` | toggle fold/file · expand all · collapse to hunks | Zed |
| `g enter` | file view: the plain file at the cursor, with change marks | diffd |
| `gd` / `ctrl-]` · `grr` | definition · references | Zed |
| `gs` / `gS` | file outline / all symbols | Zed |
| `ctrl-o` / `ctrl-i` | jump back / forward | Zed `pane::GoBack/GoForward` |
| `/` `n` `N` | search | vim |
| `v` / `V` | visual char / line | vim |
| `gc` (visual) · `gcc` | comment on selection · on line | diffd (vim-commentary) |
| `r` · `x` | reply · resolve (thread under the cursor) | diffd |
| `space e` · `space n` | files drawer · activity drawer | LazyVim-style |
| `space i` | focus the chat box | diffd |
| `space f` / `ctrl-p` | fuzzy file picker | LazyVim / VS Code |
| `space v` | mark viewed, jump to next unviewed file | diffd (GitHub) |
| `?` | show key help | |

The keymap is plain data. A small engine runs it, handling counts, modes and
prefix timeouts. The engine is unit-tested, and the data leaves room for user
overrides later.

## 10. Performance: 100k-line diffs

Targets, for a 100k changed lines across ~1k files on a normal laptop in
Chromium:

| | target |
|---|---|
| snapshot build | a few seconds, parallel; rebuilds after an edit are incremental |
| first screen visible and keys working | < 300 ms after load |
| everything rendered and Ctrl+F-searchable | < 2 s, in the background |
| cursor movement, scrolling | 60 fps; key handling is O(1) in diff size |
| page weight | ~10–20 MB, compressed |

How we get there:

- **Static rows.** Each row is created once and never re-rendered. It's one
  element per side, and line numbers are CSS `attr()` pseudo-elements (fewer
  nodes, and they don't match Ctrl+F).
- **Overlay layers.** The cursor, selections and search matches live in overlay
  layers, not in per-row state. Moving the cursor touches one element.
- **Progressive mount.** The first screen renders immediately. The rest is
  mounted in idle-time chunks, working outward from the viewport.
- **Lazy highlighting.** Rows start as plain text, which is already findable.
  Syntax and change spans are applied as sections approach the viewport, and
  since the text is identical, find is unaffected.
- **`content-visibility: auto`** on each excerpt, with intrinsic sizes, skips
  layout and paint off-screen. Scroll height stays stable.
- **Budget for hidden context.** Collapsed context is pre-rendered (and so
  Ctrl+F-searchable) up to a global budget. Past that, a gap row says Ctrl+F
  can't see inside, and `/` still can.
- **Huge and generated files are collapsed by default**, as on GitHub, and
  rendered when opened.
- **Compact payload.**
  - The snapshot uses a columnar encoding, gzip-compressed, and is decoded with
    the browser's native `DecompressionStream`.
  - Each file is parsed only when it's first rendered.
  - Revisions arrive as deltas.
- **Enforced, not hoped for.** CI generates a 100k-line fixture, and Playwright
  measures time to first screen, time to full render, and keypress latency.

## 11. Frontend stack

**SolidJS, recommended over React.**

- **The workload fits Solid.** The hot path is 100k+ static rows plus tiny,
  frequent updates: the cursor at key-repeat speed, replies arriving, unread
  dots, presence. Solid updates exactly the DOM nodes involved, with no virtual
  DOM diff and no memo discipline. React would need memoization and external
  stores everywhere, and would still reconcile.
- **Large lists.** Solid compiles JSX to cloned DOM templates. Creation speed
  and memory for large lists are close to hand-written DOM. React is noticeably
  heavier at this size.
- **We don't need React's ecosystem.** This is a custom code viewer, not a form
  app, and every library we need is framework-agnostic.
- **It still looks familiar:** JSX and TypeScript. The main gotcha is that
  destructuring props breaks reactivity, and lint rules catch that.

React remains viable if you prefer it. The row renderer would then drop to
imperative DOM, which Solid gives us without leaving the framework.

**Type safety, end to end.**

- **One source of truth.** Every shared type is defined once, in Rust: snapshot,
  API requests and responses, WebSocket events, MCP tool inputs. `ts-rs`
  generates the TS types, and CI fails if the generated files are stale. MCP
  tool schemas come from the same Rust types (`schemars`, via `rmcp`).
- **Events are tagged unions** (`#[serde(tag = "type")]` becomes a TS
  discriminated union). Every `switch` over them ends in an `assertNever`, so
  adding an event type is a compile error until every consumer handles it.
- **IDs are newtypes** (`ReviewId`, `ThreadId`, `Revision`) in Rust, and branded
  types in TS. You can't pass a thread id where a review id goes.
- **Strict at the boundaries:**
  - TS runs with `strict`, `noUncheckedIndexedAccess` and
    `exactOptionalPropertyTypes`, and Biome forbids `any` and non-null
    assertions.
  - Rust API inputs use `deny_unknown_fields`.
  - sqlx checks every query against the schema at compile time.
- **The client is typed too:** one generated route table, so the page can only
  call endpoints that exist, with the right payloads.

**Code style.** Exhaustive matching goes through **ts-pattern**
(`match(x).with(...).exhaustive()`), never `switch`. Data crossing a boundary is
typed by the generated Rust types, so there's nothing to cast.

**Styling and components.** Tailwind v4, with every color, size and radius
defined once as theme tokens (`@theme`), light and dark. The mockup's CSS
variables are that token set. Behavior-heavy pieces come from headless,
accessible Solid primitives rather than hand-rolled ones: Kobalte for popovers,
dialogs, menus and tooltips, and corvu for the resizable drawers. We style
them ourselves.

Around it:

| purpose | tool |
|---|---|
| styling | Tailwind v4 (theme tokens), Kobalte + corvu (headless components) |
| pattern matching | ts-pattern |
| build | Vite, TypeScript (strict), `vite-plugin-singlefile` (one HTML document) |
| lint and format | Biome |
| unit tests | Vitest |
| end-to-end tests | Playwright |
| Markdown | markdown-it (raw HTML off) + DOMPurify |
| fuzzy file picker | fzf (the JS port) |
| icons | Octicons (GitHub's own) |
| syntax colors | our own token set, tuned for both themes |

## 12. Repo layout and quality bar

The server is laid out **hexagonally (ports and adapters)**:

- **Pure logic** lives in `diffd-core` and never touches IO:
  - turning old/new contents into a snapshot
  - anchoring and re-anchoring threads
  - batching feedback
  - the event model
- **Everything that talks to the world is an adapter** behind a small trait:
  - driving adapters: HTTP pages, the WebSocket stream, MCP, the file watcher
  - driven adapters: SQLite, git, the clock
- **Use cases** (share, comment, reply, refresh, wait) are written once against
  those traits. Tests run them with in-memory fakes, with no database, repo or
  browser needed.

```
diffd/
├── Cargo.toml                   workspace: shared deps, lints, release profile
├── crates/
│   ├── diffd-core/              pure: model (→ TS via ts-rs), snapshot building (difftastic fork,
│   │                            tree-sitter highlight + tags), anchoring, feedback batching, events
│   ├── diffd-server/            app: use cases over ports (traits)
│   │   ├── src/app/             share, comment, reply, refresh, wait_for_feedback
│   │   ├── src/adapters/        sqlx store, git source, notify watcher, axum http + ws, rmcp mcp
│   │   └── migrations/
│   └── diffd/                   the binary: CLI (serve, setup), config, wiring; embeds the web build
├── .sqlx/                       sqlx offline query data
├── web/                         SolidJS + TypeScript + Vite
│   └── src/{gen,model,keymap,state,components,styles}
├── nix/package.nix              vite build → rust build (bundle baked in) → one binary, git on PATH
├── flake.nix                    packages, devShell, checks
├── justfile                     just dev · just test · just demo
└── docs/DESIGN.md
```

**The web build is baked into the binary.** Vite produces one HTML document,
which `diffd` embeds at compile time and fills with a review's data when
serving it. You install one file.

**Quality bar:**

- **Rust:** `clippy -D warnings`, `rustfmt`, `forbid(unsafe_code)`; unit and
  snapshot tests (`insta`) for every core module; sqlx compile-checked queries.
- **TypeScript:** strict mode; Biome; Vitest on all pure logic (excerpts,
  keymap, anchors, tree).
- **Everything at once:** `nix flake check` runs all of it.

## 13. Testing

- **Rust:** fixtures turn real git repos into snapshot tests (git source,
  engine, highlighting, tags, re-anchoring).
- **MCP:** integration tests run the real server with an `rmcp` client: share →
  comment → wait → reply → edit → revision.
- **End to end:** Playwright plays both sides of §2. A script acts as the agent
  over MCP while the browser acts as you, checking the page updates, unread
  markers, scroll stability and offline mode.
- **Performance:** the 100k-line benchmark from §10.
- **How you'll test it:**
  - I run the server in my sandbox and drive the full loop with Playwright,
    sending you screenshots.
  - I can publish a sample review page (offline mode) as a private link, so you
    can click through the UI and keys.
  - The live loop you run locally: `nix run github:404wolf/diffd`, then
    `diffd setup claude`.

## 14. Later

- `git diff | diffd` and `diffd -o review.html` (static export), then CI → Gitea
  links.
- A full **interdiff** view: "what changed since rev N".
- **herdr plugin.** herdr plugins declare actions, event hooks and panes in
  `herdr-plugin.toml`, and drive herdr through its CLI. Start a review from a
  worktree; the plugin finds that workspace's agent pane and bridges it to
  diffd.
- **LSP** behind the symbol API.
- **Postgres**, then hosted and multi-user.
- Stage and restore hunks (Zed's `du` / `dp`).
- syntect fallback highlighting for the long tail of languages.

## 15. Open questions

1. **Multibuffer vs single file, and what Ctrl+F searches.** Browser find only
   searches what's rendered. Options:
   - **(a)** Multibuffer by default, with Ctrl+F searching all files (as on
     GitHub PR pages) and a `space o` "focus this file" toggle for a scoped
     search.
   - **(b)** Single file by default, with the multibuffer as a toggle.

   Recommendation: (a).
2. **Solid or React?** Recommendation: Solid (§11).
3. **Where the difftastic fork lives.** Options:
   - A GitHub fork (`404wolf/difftastic`, branch `diffd`) used as a pinned git
     dependency.
   - Vendored into this repo. That adds ~60 MB of generated parsers, mostly
     LaTeX and Kotlin.

   Recommendation: the fork. Will you create it, or add it to this session so I
   can?
4. **Defaults.** 3 context lines, split view, port 3433, `space` as the leader.
   Change any?
