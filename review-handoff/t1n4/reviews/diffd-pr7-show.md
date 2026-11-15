# APPROVE — diffd PR #7, show_in_herdr

Latest verdict: **APPROVE (static) at `1deaeec`**. The per-request answer change matches companion #50 at `c01e457`; the earlier three findings and acknowledgment timeout note remain closed. See the appended re-reviews; earlier findings below describe `bce570b`. Build/runtime validation remains for Lane R.

Independent static review by t1n4. Fetched PR #7 and confirmed head `bce570b299e9f45dad005c9518e7b5e02e626649` (`wolf/show-in-herdr`), reviewing its six-file delta from parent `755689d`. Read `reports/diffd-show-tool.md`, `QUALITY.md`, and the related item 41 targeting contract. For the label protocol, also inspected companion home-manager-conf PR #50 at `3387c4f585c4a414ac84c9f449c9c03c1fe71505`; no app changes were made.

## Must fix

### 1. [P2] Detect an existing core without starting one, and stop before every label write when absent

Locations: `adapters/herdr.rs:130–136`; `adapters/mcp.rs:342–360` and `399–425`.

The promised no-Herdr behavior is a side-effect-free `herdr: false` with nothing labelled. `Herdr::core()` probes using `hc server status --json`. On the deployed Unix core (`c645d00`), `platform/unix.rs:34–36` returns true from `status_may_start_core`; CLI `server status` consequently uses `connect_or_start`. With hc installed and no running core, the supposed availability check starts a core rather than reporting absence. The 500ms process timeout is not a guarantee that a daemon it spawned is stopped.

There is a second gap even if the probe returns `None`: `share_diff` still calls `hc.label`, and `present_to` still calls `hc.move_label`, before `hc.show(None, …)` returns absent. A failed/slow status query followed by a successful label call can therefore write `diffd.review` while reporting no Herdr. The label command can itself autostart a core. This is particularly misleading because the app can react to that legacy label even though no show request is sent.

Use a non-starting availability check and gate all presentation label operations on its successful result. Persisting a requested target separately, as the old API did, need not imply touching a terminal. Add entry-point tests with an installed fake hc whose status is absent/slow but whose label command would record a write; assert no label invocation and a bounded absent result. The current `show(None, …)` unit test bypasses discovery and the preceding legacy label write, so cannot catch either path.

### 2. [P2] Publish diffd.review and diffd.show together

Locations: `adapters/mcp.rs:359–360`, `421–422`; `adapters/herdr.rs:139–140`, `185–186`. Companion app: `mods/diffd-control/main.ts:71–80`, `132` at PR #50's reviewed head.

Sharing or moving first writes `diffd.review=<id>` and only later, in a separate subprocess/RPC, writes `diffd.show=<view>:<id>:<seq>`. The new app deliberately retains compatibility with older diffd versions: a newly observed review label with no parseable `diffd.show` is treated as a legacy `open`.

Concrete order on a fresh terminal without an older show label: request `share_diff(view: none)` or `present_review(view: badge)`. After the first label write, the app's active tick observes the review but no show request and opens it beside the target if that target is not the focused typing pane. The later `none` request only clears a badge; it does not close the pane that was already opened. Thus a request intended to keep a review off screen can leave it visible. The same intermediate state also bypasses `front`/`close` intent.

Prepare the sequence/request before publishing, and write the review and show labels atomically in the same label operation. Core's label API already accepts multiple labels. Preserve old-target label repair around that combined destination update. Add a protocol test that samples labels between writes or drives an app tick at that boundary; `none`/`badge` must never expose a legacy-open intermediate state.

### 3. [P2] Bind label mutations to the observed core identity

Locations: `adapters/mcp.rs:344–360`, `460–469`; `adapters/herdr.rs:170–186` and the legacy label helpers.

The default-target show correctly rejects stored metadata from a different current core before calling the adapter, and qualified remote targets are rejected. However, the `Core` argument is only a snapshot: `show()` copies its id into the result and then runs `hc label <bare-terminal> …`, without enforcing that identity at the write. Sharing/moving does the same after database work and several awaited hc operations.

If core A is replaced after the status check and core B reuses the terminal address, the label commands reach B's unrelated terminal while the response still claims core A. This is the same short-address reuse hazard item 41 fixed by checking `--core` inside the actual queue RPC. A preflight metadata comparison alone does not enforce the rule for the ensuing mutation.

Bind presentation writes to the expected existing core, using an identity-checked mutation or a connection pinned to the core whose identity was checked. Do not merely repeat an unbound status call, or assume that a machine-qualified address cannot be forwarded. Add a fake-core test that replaces the responding identity between discovery and label; it must record no mutation on the replacement core. Include old-target label cleanup in that protection.

## What passes static review

- **Label payloads are injection-safe.** The view is a Serde enum. Review ids used by `show` are restricted to 1–64 ASCII alphanumeric/underscore/hyphen characters, excluding the label protocol's `:` separator. Presentation targets are normalized to bare `t…` addresses, bounded in length and restricted to lowercase ASCII/digits. The subprocess runner uses literal argv, not a shell. An arbitrary nonexistent review id fails its prepared database lookup before a presentation write; the new show payload also validates stored ids.
- **Normal machine selection is correct.** Explicit targets accept a local core-name prefix and reject another machine; agent delivery fields remain distinct from presentation fields. The stored-core mismatch guard avoids blindly showing an old review on a reused short address. Finding 3 concerns replacement during the operation, rather than an ordinary remote-target bypass.
- **The acknowledgment protocol is specific.** `next_seq` uses a process-wide atomic counter with wall-clock milliseconds, increasing even for calls in the same millisecond. Answers must contain the matching numeric sequence and one of `open`, `front`, `badge`, or `closed`; stale/malformed states do not count. With a confirmed core but no responding app, the request remains labelled and the result is `pending`.
- **The wait yields the executor.** It awaits Tokio subprocess output and Tokio sleep; no synchronous sleep or broad App/MCP mutex is held across the acknowledgment loop. Unrelated request futures can progress. `view: none` does not wait for an app acknowledgment. No periodic background scan was added to diffd.

## Timing note

The advertised acknowledgment wait is not a strict three-second upper bound. `answer()` checks its deadline after an hc get and reserves only the next 500ms sleep; a get starting near the deadline can consume another 500ms. The loop can take about 3.5 seconds, in addition to preceding status/label calls (each bounded separately). The one-second test permits up to two seconds and uses a fast fake get, so it does not establish the advertised bound under a slow child.

Use a deadline/remaining budget around each get or the whole acknowledgment future if three seconds is the contract, and cover a slow/non-answering get. This does not block a runtime worker, but the initiating MCP request stays in flight until the wait completes.

## Tests, base, and validation

New adapter tests cover literal label argv, a simulated app acknowledging a badge, stale ack/pending, direct absence, invalid ids/targets, `none`, and sequence matching. MCP tests cover tool exposure, required/invalid view, target persistence, missing reviews, unlinked targets, and rejection of another machine. They do not exercise a fake core through the MCP entry points, core replacement, absence with a still-invocable label command, or the two-label publication boundary. The current MCP fixture constructs `Herdr::default()` through production handlers, so real hc availability affects those paths; use a per-session injected adapter/fake rather than a live core or global environment mutation for the required coverage.

The design note predates this implementation and the change reuses the existing MCP/presentation path. No new SQL query or storage migration was introduced. Generated protocol/API effects and compilation remain unverified; Cargo and runtime checks belong to Lane R. The PR is still based on the old item 41 branch head; retarget/rebase onto the merged `3a3d64c` base, then confirm the final diff and run the assigned gates.

`git diff --check 755689d bce570b` passes. Static only: no Cargo, tests, browser, e2e, service commands, source edits, push, GitHub comment, or merge. Only this report was written; the review-pr1 source worktree remains clean at `21bb9bc`. **Verdict: CHANGES.**

## Re-review — APPROVE at `e03b5bc`

Fetched PR #7 and confirmed head `e03b5bc5ae765a4c5caed0348bfe2ba954ec6bae`. The rebased feature commit `557ce4075097c656583d5caf853feb4a00e7356c` directly follows merged base `3a3d64cba6ffdd6d74cf3ed7448387111e7644bb`, so the old branch-base issue is resolved in the source history. Reviewed the correction and the full feature diff against that base. **No outstanding must-fix findings remain in the presentation change.**

### Closed findings

1. **No implicit core start.** Presentation and core discovery no longer invoke hc. They connect directly to an existing Unix socket and speak the core's plain line-delimited JSON-RPC protocol. Socket discovery follows the normal Unix `Paths::from_env` precedence: `HC_SOCKET`, configured socket, then runtime/session socket or state fallback. Missing sockets, failed status calls, and the MCP no-core branches return absent without attempting a label. Recording a desired target remains separate from touching a terminal. The no-core fixture includes a runnable fake hc and asserts it was never executed and no socket was created.
2. **Atomic destination publication.** `Herdr::present` constructs the sequence/request first, then sends one `terminal.label` map containing both `diffd.review` and `diffd.show`. Actual core `terminal_label` applies the map under one state lock and emits one labels event, so the companion app cannot observe the legacy-only intermediate state. A failed destination leaves the old target alone; successful old-target repair follows the destination write.
3. **Core identity pinned to writes.** `present` opens a connection, checks `server.status` on it against the expected id, and performs destination/old-target writes on that same connection. Replacing the socket's listener cannot redirect an already connected Unix stream to the replacement process. Mismatch returns replaced without label/get calls; a hangup does not trigger reconnection to another core. The fake records connection numbers, and tests assert that status and label share the checked connection.
4. **Whole acknowledgment deadline.** One `tokio::time::timeout` now encloses the entire ack-read/sleep loop. Slow reads cannot extend it by another poll's call budget. Individual RPC calls are also bounded, and a timed-out/unreadable connection is marked unusable rather than reusing a misaligned response stream. The slow-read test covers both fast and 450ms gets under a one-second whole-wait budget. The production ack budget remains three seconds; connection/status/label work precedes that budget and remains individually bounded.

Payload validation, per-request sequence matching, local-target restrictions, and async executor yielding remain intact. The presentation path uses structured JSON rather than shell commands. No background idle polling was introduced.

### Coverage and remaining validation

New fake Unix-core tests inspect the actual JSON-RPC requests and cover atomic labels, status/write connection affinity, replacement, hangup, old-target repair, missing core without process execution, invalid ids, none, stale ack, and slow reads. Per-session injected `Herdr` instances test MCP present/show handlers and the share presentation helper without global environment changes or a live core. The existing HTTP/MCP schema tests remain present. Tests were inspected, not executed by this reviewer.

`git diff --check 557ce40 e03b5bc` and the full `git diff --check 3a3d64c e03b5bc` pass. **APPROVE for static review at `e03b5bc`; ready for the assigned Lane R gates.** No compilation, Rust tests, browser, e2e, service changes, source edits, push, GitHub comments, or merge were performed. Source worktree remains clean at `21bb9bc`.

### Requested item 41 follow-up: move inbox sends to the socket too

**Recommendation: yes, as a follow-up rather than a blocker for #7.** This commit also makes `AgentInbox::local_core` a non-starting socket check, but `AgentInbox::send` still invokes `hc send --inbox-only`. If the core disappears between the check and send, that hc invocation can autostart it on Unix. Core-id binding still prevents a notice reaching an unrelated replacement core, but does not prevent the unwanted process start.

Reuse the existing-socket transport for `terminal.queue`, preserving the fixed expected core, key, original timestamp, retries, and at-least-once hook fallback. Keep structured RPC error kinds: the presentation helper currently collapses errors to `None`, while inbox delivery needs to distinguish definitive refusal, an unvouched result, and uncertain acceptance. Connect failure before sending and a disconnect after sending must retain their appropriate fallback behavior. A no-core/send-race fixture should assert that no hc process runs and the notification still reaches hooks as required.

## Per-request answer re-check at 1deaeec — APPROVE (static)

Fetched `pull/7/head` and confirmed `1deaeec584e51d16683e186ed12531fd4cfa7a68`, directly on approved `e03b5bc`. Reviewed the entire two-file delta (`README.md` and `crates/diffd-server/src/adapters/herdr.rs`) and companion home-manager-conf #50's writer/model at `c01e457`.

- `answer_key(seq)` constructs exactly `diffd.shown.<seq>`. `answer_for` indexes only that key on the requested terminal's labels and accepts the four app states `open`, `front`, `badge`, `closed`. Another sequence's key, an unknown/non-string state, and the old shared `diffd.shown` label cannot satisfy it. Companion #50 writes precisely that key/value format on the same terminal and uses the same state allowlist.
- `present` uses the sequence it generated for its own outgoing show label throughout the wait. The whole-loop timeout, production three-second budget, 500ms polling, per-RPC bounds and `pending` timeout result are unchanged. The no-wait `none` path, atomic request labels, connection/core binding and missing-core behavior are unchanged.
- The fake app now answers under the request's own key. The updated unit test checks separate answers for two sequences, rejects an invalid state, and rejects even a legacy shared answer whose embedded sequence matches. The slow-read timeout test now includes older and newer per-request keys plus the shared label, and still requires `pending` within the original bound. Existing successful presentation tests consequently exercise the new fake response format. Tests were inspected, not executed.
- README and adapter comments match the new protocol. No fallback to the shared label remains in production code and no additional background work was added.

No static findings. Both `git diff --check e03b5bc 1deaeec` and `git diff --check 3a3d64c 1deaeec` pass. **APPROVE (static)**; the assigned Lane R build/test run remains pending. No source checkout/edit, build, test, browser/e2e run, service change, push, GitHub comment or merge was performed.
