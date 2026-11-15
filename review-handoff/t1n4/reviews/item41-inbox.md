# APPROVE — item 41, review feedback through Herdr's inbox

Latest verdict: **APPROVE (static) for diffd `755689d` and herdr-core `432b966`** under PM t1jf's **at-least-once** notice contract. All review findings are closed. Ready for the assigned Lane R validation; no build/test execution is implied by this approval. Earlier findings and verdicts below are historical and refer to their stated heads and, where indicated, the superseded notice contract.

Independent static review by t1n4, 2026-11-14:

- diffd draft PR #6: `06ddcb5328ba5bc14ad855562e36452573be7412`, including `5bf2d1a`, against `dedfcc8`.
- herdr-core #1 increment: `c367ebd5c460ae889f2049207b2d4c027e67cb36`, against its parent.

Reviewed the design in `reports/diffd-review-via-herdr-inbox.md`, `QUALITY.md`, the changes, and the surrounding CLI/RPC, input, notification, gate, and hook paths. Both pieces need changes before the linked feature is safe to ship.

## Must fix

### 1. [P1] A new hc client talking to an old daemon can still type

Locations: diffd `adapters/herdr.rs:109–115`; core `cli.rs:236–239`, `client.rs:244–259`, `api/types.rs:463–493`, and the parent of `inbox.rs:61–94`.

The adapter assumes an old core rejects `--inbox-only` as an unknown CLI flag. That holds when the hc executable is old, but not when the executable was updated and the existing daemon is still old. The new client serializes `inbox_only: true` into an ordinary `terminal.send`. It connects to an existing daemon without negotiating support for this parameter. The old `SendParams` uses ordinary Serde deserialization, which ignores unknown fields; the old handler therefore executes its normal send, including the typing fallback when nobody follows the inbox. The reply saying `via: typed` is checked only after the input was already sent. Both daemons have the same protocol generation, and the new commit adds no capability negotiation preventing this path.

Use a fail-closed operation that an old daemon cannot interpret as a typing send, for example a distinct inbox-only RPC method, or an equally strong protocol contract. The core id check verifies identity, not inbox-only support. Add a mixed-version regression with a new client and an old daemon, a non-following live terminal, and an assertion that no bytes are typed. The current fake-old-hc test covers only the older-executable case. **This blocks both pieces' safety claim.**

### 2. [P1] Sending one ready review discards another review's pause deadline

Locations: diffd `app/wake.rs:216–255` and `app/push.rs:90–111`.

`take_fresh()` can collect both ready feedback and a `held` deadline from different reviews. When any review is ready, it returns only the notice and discards `held`. The pusher groups reviews by terminal/core; that group's `Look::Notice` therefore never contributes to the pusher's next deadline.

Concrete order, two reviews routed to the same terminal: comment on A at t=0, comment on B at t=0.75 s. The pusher's t=1.5 s pass finds A ready and B held for another 0.75 s. It sends A, returns `None` for its next wait, and sleeps on `pushes.notified()` indefinitely. Sending A successfully creates no new feedback event. With no further user action, B never reaches the inbox; a future hook or user action is required. This defeats the event-driven replacement for polling.

Preserve the held deadline alongside a notice, or immediately re-evaluate remaining feedback after claiming a notice, then sleep until the pending gate expires. Add the two-review staggered-comment regression with no subsequent event and no hook, asserting both notices arrive once at their respective pauses.

### 3. [P1] Close the test module in adapters/herdr.rs

Location: diffd `adapters/herdr.rs:142` and EOF at line 250.

`mod tests {` remains open: the final brace closes `the_inbox_takes_messages_only_when_the_core_queued_them`, and the file ends without the module's closing brace. The parent had that brace; this change removed it while adding tests. Rust must parse the source even when the test module is disabled, so the draft cannot compile as checked in. Restore the brace and run the Rust gates in Lane R.

### 4. [P2] A send timeout is not proof that core did not queue the notice

Locations: diffd `adapters/herdr.rs:111–138`, `app/push.rs:100–104`; core `inbox.rs:75–94`.

Core queues and emits the inbox message before awaiting `started_after()` and returning its response. The adapter turns a ten-second timeout, lost connection, nonzero exit, or unreadable reply into the same `false` as an explicit rejection. The pusher then removes the `told` marks and wakes the hooks.

An allowed order is: core accepts the message; the response is lost or delayed past the timeout; diffd unmarks it; a hook announces it; the inbox follower also receives the accepted message. The shared `told` lock prevents concurrent claims before the send, but cannot prevent this duplicate after an uncertain outcome. Core's per-message replay id does not deduplicate a separate hook notice.

Represent explicit rejection separately from an unknown outcome, and make acceptance discoverable/idempotent with a stable delivery identity or an equivalent receipt protocol across the fallback paths. Unmarking is safe only when non-acceptance is established. Add an accepted-then-response-lost/timeout regression. Existing failure tests model a rejection, not acceptance followed by an ambiguous result. Actual feedback batches remain protected by `wait_for_feedback`'s delivered state, but the claimed exactly-once notice behavior does not hold.

### 5. [P2] Refresh the complete agent route on the promised MCP paths

Locations: diffd `adapters/mcp.rs:123–129` and `412–414`.

`note_agent()` returns early when just the terminal string matches, without checking the stored core id. After a core change with the same short terminal address, `say` and `wait_for_feedback` therefore never repair `agent_core_id`; the pusher keeps rejecting that route as belonging to another core. Separately, the `reply` handler does not receive request context or call `note_agent` at all. An agent resumed in a different terminal that answers through `reply` leaves the old terminal as its push destination, potentially notifying the wrong still-running agent.

Refresh the terminal/core pair on `reply`, `say`, and `wait_for_feedback`, as the design specifies. Add MCP-header tests for a moved agent replying and for an unchanged terminal address on a changed core. The current route test calls `App::agent_at()` directly and cannot detect either omission.

## Latency gap against the approved design

The design gives routed feedback a bounded hook grace period so the inbox normally wins. The implementation explicitly leaves hooks competing without that preference (`app/push.rs:11–18`), and `hook_first_the_pusher_finds_nothing_to_push` confirms that an early hook suppresses the inbox permanently for those messages. Both paths may already be waiting when a comment arrives; they race at the same quiet-period deadline. If the hook wins during a long agent turn, the feature retains the hook delay this item was intended to remove. The fast latency test runs without a competing hook.

Resolve this deviation before claiming that feedback arrives within seconds mid-turn: implement the bounded preference/fallback rule, or obtain an explicit design change with the resulting latency contract. Exercise a normally active hook and pusher together in the latency test, rather than forcing only one ordering. This is separate from the timeout ambiguity above.

## What passes static review

- On a daemon containing `c367ebd`, the local inbox-only branch checks the follower and queues under the core lock. Its non-queue branch returns `not_following` before reaching `self.send`. A follower disappearing after acceptance leaves a queued message, rather than triggering typing. The remote route check rejects forwarding inbox-only sends to another machine. The compatibility hole in finding 1 is outside that protected new-daemon branch.
- The diffd adapter validates a bare local terminal address and uses literal argv with `--`; no shell interpolation or fallback typing command is present. Child process execution is bounded, with `kill_on_drop` on timeout.
- Sharing derives the agent route from the per-request `X-Herdr-Terminal` header, independently of `present_in`. New route fields are transport-owned and skipped on input deserialization; optional fields with Serde defaults preserve older stored specs. Keeping them in the existing JSON spec avoids a schema migration.
- Successful hook-first and inbox-first claims share the same `told` set under the live lock. Explicitly rejected pushes unmark their own ids and notify hook waiters. Partial database errors in notice construction now also unmark accumulated claims. No-route, missing-hc, wrong-core, older-executable, and non-following/Codex cases leave or return feedback to hooks, subject to finding 1's mixed-version case and finding 4's uncertain outcomes.
- The pusher has no fixed idle rescan. It waits for `pushes` notifications or a known held-feedback deadline; `notify_one` retains a permit while it is busy. Failure rollback notifies hooks without immediately retriggering the pusher, avoiding a failed-send busy loop. The existing five-second hook discovery backstop remains unchanged. Finding 2 must be fixed to retain all needed event deadlines.

## Tests and validation

The eight new `wake_inbox` tests cover successful inbox delivery, controlled hook-first/inbox-first order, explicit rejection with/without an existing hook, no route/wrong core/no core, direct route changes, and idle behavior. Adapter tests cover literal argv and an old executable rejecting the flag. The core increment adds a scratch follower/non-follower/remote test. They are useful, but miss the mixed-version, ambiguous acceptance, mixed ready/held reviews, and MCP route-refresh cases above.

`git diff --check` passed for both reviewed changes. This was a static review only: no Cargo, Rust tests, browser, e2e, or real-agent latency smoke was run. The design's actual idle/mid-turn transcript timing remains unverified. No source edits, push, GitHub comment, merge, service restart, or interaction with live diffd port 3433. The review-pr1 source worktree remains clean at PR #4 head `21bb9bc`.

## Re-review — core `87ff5a4`, diffd `d1a9bdc`

Confirmed diffd PR #6 head `d1a9bdcba2aef9480c6903323616f367f690702b` and core commit `87ff5a481fb098ca5d3acd9f01e50b4fe95b6db0`. Compared each with its previously reviewed head. **Core's inbox-only increment passes static review; the linked diffd feature still needs changes.**

### Verification of the six fixes

1. **Mixed-version typing: closed.** `hc send --inbox-only` now sends the distinct `terminal.queue` RPC. An old daemon rejects that method before any send handler can run. The new core's handler forces the existing queue-only branch, and `terminal.queue` is excluded from the remote forwarding list; local address resolution rejects a foreign prefix. `server.status` advertises `queue`; diffd checks it, treating missing features as unsupported. The modelled-old-daemon test records that only `terminal.queue`, never `terminal.send`, is called. This addresses the old-client/old-daemon ambiguity without a racy capability-only safety check.
2. **Send outcomes: duplication avoidance improved; reliable delivery remains open below.** `Queued`, `Refused`, and `Unknown` are distinct. Named definite refusals hand feedback to hooks; a lost/unreadable/timed-out reply no longer automatically creates a second announcement. That is necessary, but keeping an unknown result permanently told can instead suppress every announcement.
3. **Mixed ready/held reviews: closed.** `Look::Notice` now carries `Option<Duration>` alongside the notice and claimed ids. The pusher accumulates that deadline even after scheduling a send. The staggered two-review regression covers the original A-at-0/B-at-0.75-second order without another event.
4. **Unclosed module: closed.** `adapters/herdr.rs` now ends with the test function and module braces.
5. **Route refresh: closed.** `reply` resolves its review and calls `note_agent`; `reply`, `say`, and `wait_for_feedback` all refresh the full terminal/core pair. The terminal-only early return is gone. The MCP-header test covers a moved terminal, the same address on a changed core, and a later wait from another terminal.
6. **Inbox preference: implemented for the normal event path.** `Hooks | Deciding | Inbox` and the `Taker` checks stop a hook from claiming feedback while the pusher decides or owns the review. Definite rejection returns ownership and wakes hooks; fresh feedback retries the inbox. A parked-hook regression now checks that the inbox wins. Error recovery and the publication ordering below still leave holes around this state machine.

The pusher still has no periodic idle rescan: it waits for changes or a known pending pause deadline. Nine `wake_inbox` tests are now present. Both incremental `git diff --check` calls pass; no Rust tests were run by this reviewer.

### Remaining [P1]: Unknown can strand the notification indefinitely

Location: diffd `app/push.rs:165–175`, `adapters/herdr.rs:142–165`, and `app/wake.rs:248–260`.

**The agent is not guaranteed to see it through the inbox later.** A timeout/lost connection can occur before core queues anything, as well as after acceptance. For example, `hc server status` succeeds, then the send child hangs before transmitting its request and is killed by the timeout; or the request reaches core but its refusal reply is lost. The adapter returns `Unknown` in both cases. `deliver_notice` merely logs: it leaves the ids in `told`, leaves delivery with `Inbox`, and schedules no receipt check, retry, or hook handoff.

With no further user action, the pusher sleeps. Hook rescans cannot rescue the notice: hooks do not take an `Inbox` review, and even a later ownership change leaves the id excluded by `told`. If core never accepted the request, its inbox has nothing to replay. The comment remains in SQLite as undelivered and an explicit future `wait_for_feedback` call can read it, but an idle agent never receives the wake that would cause that call. This is indefinite notification loss, not deletion of the comment's stored body.

`an_unknown_outcome_is_never_announced_twice` models only “maybe accepted” and asserts hook silence plus `pending_count == 1`; it does not establish any delivered notification. Add both accepted-then-lost-reply and never-accepted/lost-refusal cases, and assert eventual arrival as well as absence of duplicates.

Resolve uncertain acceptance with a stable delivery id and an idempotent queue/receipt or equivalent recoverable protocol. Retry unresolved deliveries safely, with bounded recovery work while there is outstanding feedback rather than idle polling. A durable accepted receipt can retain `told`; proven non-acceptance can hand it back. Simply unmarking all unknowns restores the previous duplicate bug, while permanently marking them chooses possible silent loss. If the intended contract is instead at-least-once notices with exactly-once feedback batches, that requires an explicit design decision and an actual fallback, not a claim that an unannounced comment will be read automatically.

### Additional [P2]: Notice-construction errors leave ownership with an idle pusher

Locations: diffd `app/wake.rs:218–225`, `app/push.rs:68–79` and `147`.

After a usable route becomes `Inbox`, `take_notice` may fail while reading pending feedback or metadata. Its error path unmarks accumulated claims and notifies hooks, but does not return the review to `Hooks`. Those hooks therefore wake and immediately skip it. The pusher propagates the error, logs it, returns no held deadline, and waits for another global feedback event. A transient database error can consequently leave fresh feedback unannounced even after the database recovers. This is separate from uncertain external acceptance: no send was attempted, so safe fallback is possible.

On such an error, explicitly return affected reviews to hooks and notify them, or retain recovery work for the pusher. Cover errors before the first claim and after a partial claim; asserting that ids were unmarked is insufficient once ownership can still exclude hooks.

### Additional [P2]: Publish ownership and the pause gate before hooks can see a new message

Locations: diffd `app/conversation.rs:346–356`, `app/mod.rs:304–314`, and `app/wake.rs:235–260`.

On a fresh routed review, delivery initially remains `Hooks`. `chat_user` commits the new message through an awaited store call before `user_activity` touches the quiet-period gate and changes delivery to `Deciding`. A parked hook's five-second rescan can run after that database commit but before the writer resumes. It sees the newly visible message with the old settled gate and `Hooks` ownership, marks it told, and returns it. The later `Deciding` transition cannot recover inbox preference for those ids. Thus the normal parked-hook test does not establish the priority invariant for every publication order, and this order can also bypass the intended pause.

Coordinate feedback publication with its gate/ownership transition so a hook cannot observe newly committed feedback using the previous admission state. Add a barrier-driven test holding the writer after commit and before its post-write notification while a hook inspects the review. This is an existing store-then-touch window that the new ownership design still needs to account for, rather than another fixed grace timeout.

### Re-review verdict and limits

**herdr-core `87ff5a4`: APPROVE for the reviewed inbox-only increment on static evidence. diffd `d1a9bdc`: CHANGES**, chiefly because unknown send outcomes can suppress the only wake indefinitely. The earlier typing, deadline, syntax, and MCP-route findings are closed; the error/publication cases above still require state-machine recovery and ordering coverage. No Cargo, browser, e2e, service operation, source edit, push, GitHub comment, or merge was performed. The independent runtime/latency gates still require their assigned slots.

## Re-review — core `cf19f44`, diffd `9c067e9`

Confirmed diffd PR #6 head `9c067e99d6a79f7416c2b71ee42a70d46417c1f0` and core commit `cf19f44147ba9a722241c8b237337e0b4658776b`. Incremental static comparison and `git diff --check` passed for both trees. **CHANGES remains for the linked implementation**, for the receipt-retention and retry-target findings below.

### The preceding three findings are addressed

- **Unknown outcome no longer silently sleeps forever.** Each `deliver_notice` creates one key before its retry loop and reuses it on every attempt. `Unknown` waits 1, 2, 4, … seconds, capped at 60 seconds; `Queued` exits, and only a definite `Refused` returns claims to hooks. Retry timers exist only while a notice is unresolved; this adds no periodic idle database scan. The four scripted lost-request/lost-answer orders now assert one accepted key, the same key on all attempts, and no hook announcement. A separate lost-request-then-refusal case verifies hook fallback.
- **Core deduplicates a retained key atomically.** `terminal.queue` validates a 1–128-byte key. Under the core state lock, `send_or_queue` checks `queued_keys`, records a new key, and queues the message. A retained key returns `via: inbox, repeated: true` without enqueuing, without requiring a live follower, and without waiting for the program to start. Keys are serialized with the terminal registry. The new scratch test covers repeat, acknowledgment, restart, and repeat after the follower disconnects. This is correct while the receipt is retained; the fixed-size cache is the unresolved limit below.
- **Notice-construction errors hand ownership back.** The pusher catches `take_notice` errors per terminal group, changes those reviews to `Hooks`, notifies their waiters, and continues processing other groups. `take_notice` still rolls back any partial claims. Internal tests break `messages` (before claiming) and `reviews` (metadata after claiming), restore the table, and verify hook recovery.
- **Admission state precedes publication.** Comment, user reply, and user chat create `FeedbackComing` before the insert. `user_activity` touches the gate and moves a routed `Hooks` review to `Deciding` under the same lock. The guard notifies on drop, including failed writes. The internal ordering test explicitly inspects feedback after commit and before guard drop, both before and after the pause, and confirms a hook cannot take it. The preceding store-then-admission finding is closed on static evidence.

The earlier RPC typing fix, held deadline propagation, syntax correction, MCP route refresh, and normal inbox preference remain in place. Tests were inspected, not executed by this reviewer.

### Remaining [P2]: Keep acceptance receipts for as long as their keys can be retried

Locations: core `inbox.rs:37–47` and `88–117`; diffd `app/push.rs:188–203`.

Core retains only the newest 256 accepted keys per terminal. It evicts the oldest key when accepting another one, even if the old message is still in the inbox or its sender has never received confirmation. Diffd retries an unresolved key indefinitely and can send later notices for the same terminal in other tasks. These two contracts do not compose into exactly-once notices.

Concrete order: core accepts key K, but all answers for K are lost. Later it accepts 256 distinct keyed notices on that terminal. `remember_key` removes K, and the inbox `Message` has no stored key from which to recover that receipt. When K's outstanding retry arrives, core treats it as a new request and enqueues a duplicate if a follower is present. If no follower is present, it returns `not_following` instead; diffd treats that as proof K was never queued and announces it through a hook, even though K was accepted before eviction. Neither outcome preserves the intended notice guarantee. An unacknowledged original can coexist with its duplicate in the inbox.

The core unit test deliberately verifies eviction; the diffd model keeps accepted keys forever, so the new lost-answer cases cannot catch this mismatch. Add a coupled regression: accept K and lose its answer, accept 256 later keys, retry K with and without a follower, and assert no second announcement.

Tie receipt reclamation to sender confirmation or another protocol boundary that makes future retries safe; alternatively, explicitly bound both retry validity and receipt retention with a safe outcome for retired keys. A fixed newest-256 cache alone cannot prove non-acceptance for a retry after eviction. Increasing the constant only moves the failure point. This is a blocker in the current `cf19f44`/`9c067e9` implementation, independent of older preview compatibility.

### Additional [P2]: Bind retries to the core identity that owns the route

Locations: diffd `app/push.rs:127–153` and `188–203`; `adapters/herdr.rs:129–144`.

The initial pusher pass verifies `route_core == local_core.id`, but a retry task retains only the terminal string, text, key, and claimed messages. It never checks that identity again. After an unknown send, replacing that local session/core with another identity can reuse the same bare terminal address. The next retry sends to that address on the new core, which has never seen K and can queue it for a different agent. The core-mismatch guard that protects fresh passes is bypassed by the long-lived retry path.

Preserve the expected core identity with the outstanding delivery and validate it for each enqueue, ideally as part of the queue operation so a separate status check cannot race replacement. Resolve a changed route/identity explicitly instead of allowing a bare-address retry to select a new recipient. Add a test that changes the modelled core id and reuses the terminal between an unknown attempt and its retry, asserting that no notice reaches the replacement recipient. An ordinary restart preserving the same core identity and registry should continue accepting the same key.

### Compatibility boundary, confirmed with the PM

`87ff5a4` implements an unkeyed `terminal.queue`, advertises the same `queue` feature, and ignores the newer optional `key` field. It would not deduplicate keyed retries from a newer executable. PM t1jf confirmed that **core #1 has never been merged or deployed anywhere**: deployed cores run master `c645d00`, which has no `terminal.queue`. Accordingly, the unkeyed preview is an unsupported compatibility boundary, **not a blocker for this first release**. The deployed old core still fails closed on the new method. A distinct keyed capability name was separately requested by the PM as a cheap clarification; this review does not require support for the unshipped preview.

### Re-review verdict and scope

**CHANGES for the linked feature at core `cf19f44` / diffd `9c067e9`.** The previous three requested fixes are implemented, but unlimited retry requires receipts that cannot be forgotten while still in use, and retry attempts must preserve route identity. No additional periodic idle polling or path to typing was introduced in these commits. No Cargo, tests, browser, e2e, service operations, source edits, push, GitHub comments, or merge were performed. The review-pr1 source worktree remains at `21bb9bc`; this append is the only review deliverable changed.

## Round 3 — core `dcf6879` + `432b966`, diffd `8eb7194`

Confirmed diffd PR #6 head `8eb71945ec8fdacdac7793193c42ca0a41760433` and inspected core through `432b966`, including `dcf6879`. Compared each with the preceding reviewed head. **Both preceding blockers are closed on static evidence. Core's increment is APPROVE; diffd is CHANGES under the clarified notification contract below.**

### Contract decision from PM t1jf

Eventual notification is required. Wake notices are **AT LEAST ONCE**, with duplicates kept rare; a second wake is acceptable because the agent reads the stored feedback through `wait_for_feedback`, whose delivery mechanism prevents duplicate feedback batches. An unclear inbox result must therefore never permanently suppress hook fallback. If recovery reaches the retry limit, or a later result cannot vouch for an earlier unclear attempt, hand feedback to hooks even though an earlier inbox notice might also arrive.

This supersedes the previous strict exactly-once-notice requirement. It is the standard for the verdict here; earlier historical findings should not be read as requiring suppression of every possible duplicate wake.

### Receipt retention and identity: closed

- **Receipt protocol is explicit.** Core advertises `queue-keyed` and `queue_keys_kept_ms`; diffd requires the keyed feature and reads the retention duration. Each immutable `Outgoing` carries terminal, expected core id, key, original send timestamp, and text across all attempts. The adapter sends these as literal argv with `--core`, `--key`, and `--key-since` before the `--` separating terminal/text.
- **Age and capacity eviction are safe to identify.** Core keeps timestamped keys for one hour, subject to a 10,000-key cap. Its persisted `keys_complete_since` watermark advances when keys are removed. A known key is still a repeat; an unknown key whose original send time predates complete history returns `key_forgotten` before follower lookup or enqueue. It is not requeued and is not misreported as `not_following`. Age-limited retries use half the advertised retention period. Capacity eviction can still precede that window, but is explicitly recognized as an uncertain-history result; it must take the at-least-once fallback below, rather than being mistaken for a definite first-time refusal.
- **Every attempt is bound to its core.** `terminal.queue` checks the expected core id inside the queue RPC before resolving or queuing the target. A replacement core returns `other_core`; it cannot accept the notice into an unrelated terminal that reused the address. The fixed `Outgoing` prevents retries from silently changing core, key, or payload.
- **Evidence is relevant to these fixes.** Core tests cover keyed capability/retention advertisement, preserved keys across restart, old timestamps producing `key_forgotten`, retained keys still returning repeated, watermark advancement at the cap, and wrong-core refusal. The diffd fake now models retention and core ids; tests cover cutoff, replacement during retry, and replacement before the first send. All were inspected statically, not run by this reviewer.

The distinct RPC continues to fail closed on deployed old cores, and the earlier unkeyed-preview compatibility boundary remains nonblocking. No new typing or remote-forwarding path was found. Idle pusher behavior and prior deadline/error/publication fixes are unchanged.

### Must fix [P1]: Hand abandoned ambiguous notices to hooks

Location: diffd `app/push.rs:217–255`, `deliver_notice`.

Two branches still implement the superseded at-most-once behavior:

- `Sent::Unvouched` after `unclear` became true logs and returns with ids still in `told`.
- `Sent::Unknown` when `started.elapsed() + wait > window` likewise logs and returns with ids still in `told`.

Neither guarantees that an earlier attempt was accepted. Concrete zero-delivery case: all attempts lose their requests before core receives them. At the deadline, diffd stops trying, the inbox has no message, and hooks still cannot announce the feedback because the ids remain told. Another case is a lost first request followed by `other_core`, `key_forgotten`, or a missing hc: the second result cannot prove acceptance, yet the uncertain-result branch suppresses fallback immediately. Stored feedback surviving in SQLite does not wake an idle agent.

For the clarified contract, both terminal ambiguity branches must call `hand_to_hooks(told)` so claims are cleared, ownership changes to `Hooks`, and waiters are notified. Keep the bounded, same-key retries first to make duplicate notices rare. A possible accepted prior attempt is no longer a reason to abandon notification; it only means the fallback may produce a permitted duplicate wake.

Update the cutoff and replacement regressions accordingly. They currently start with `QueueLoseAnswer` and require hook silence, so they encode the old contract. Cover both first-attempt acceptance and first-attempt loss, assert no enqueue on a replacement core, and require hook fallback when the outcome remains ambiguous. Include all-request-loss through the cutoff with zero inbox messages; it must still produce a hook notice. Keep the existing feedback-batch delivery checks so a second wake cannot cause the same stored comment to be handed out twice.

### Round 3 verdict and scope

**herdr-core `432b966`: APPROVE for the reviewed increment, static only. diffd `8eb7194`: CHANGES**, limited to the two ambiguity-exit branches and tests that still require suppression instead of eventual hook fallback. The previous receipt eviction and core identity findings are closed. Incremental `git diff --check` passed for both repositories. No Cargo, tests, browser, e2e, source edits, service operations, push, GitHub comment, or merge were performed. The source worktree remains clean at PR #4 head `21bb9bc`.

Report delivery: the final `hc send t1jf` was refused as `blocked (waiting)`. A read-only screen check showed t1jf at an account-limit options dialog. No forced send, dialog input, account change, or alternative messaging path was used; the final verdict is recorded here for the resumed PM.

## Final review requested at diffd `449fc57`

Fetched PR #6 and confirmed head `449fc57c4fc34c2298271fc475580fa1a8c7335d`. Core remains the previously reviewed `432b966f64dc9897713179f1c2d90bda867be282`. The incremental diff changes only `app/push.rs`, `ports.rs`, and `tests/wake_inbox.rs`; `git diff --check 8eb7194 449fc57` passes.

### Requested at-least-once change: closed

Both `deliver_notice` ambiguity exits now call `hand_to_hooks(told)`: an `Unvouched` result regardless of earlier uncertainty, and `Unknown` when another retry would exceed the window. The claims are released and hooks are notified rather than leaving a notice permanently told. Successful keyed sends still stop recovery; the bounded same-key retries remain in place before fallback. A possible duplicate wake is allowed under the clarified contract.

The new tests cover the required distinctions:

- Every request is lost: zero inbox accepts, a hook receives the notice after the retry window, a later hook receives nothing, and retrying stops.
- Core accepted the first attempt but its answer and later requests were lost: one inbox enqueue plus hook fallback at the deadline.
- Core replacement after either a lost request or an accepted request with a lost answer: no enqueue on the replacement core, hook fallback in both cases, and no second hook notice.

These close the previously requested branch/test changes on static evidence. The stored-feedback delivery path is unchanged, so a permitted second wake does not bypass its existing delivered-message filtering and delivery lock.

### Remaining [P2]: A stale pusher pass can undo hook handoff

Locations: `app/push.rs:145–175` and `app/wake.rs:281–299` at `449fc57`.

`push()` filters reviews whose delivery is not `Hooks`, then awaits `inbox.local_core()`. After that await it unconditionally writes `Inbox` or `Hooks`, without rechecking whether a delivery task returned the review to hooks meanwhile. `hand_to_hooks()` separately sets ownership and then calls `untell()`, taking the review lock again to remove claims. Another runtime worker can run in between those operations.

Allowed zero-delivery ordering for a review R whose original requests were lost:

1. An unrelated review event starts a pusher pass. It captures R as `Inbox`, then awaits the core lookup. The unrelated event can be a draft transition on an unrouted review, so it need not produce another pending deadline.
2. R's send recovery reaches its cutoff and `hand_to_hooks` sets R to `Hooks`. Its ids are still told until the later `untell` step.
3. The stale pass resumes, overwrites R back to `Inbox`, reads its pending feedback, and skips the still-told ids. It finds no remaining work/deadline and goes idle.
4. The handoff removes R's told ids and notifies hook waiters. Those waiters now skip R because delivery was overwritten to `Inbox`. No global pusher notification or pending deadline remains to reclaim the untold feedback.

The original notice was never queued, yet neither path now announces it until another external action. This violates the same at-least-once liveness contract despite the corrected ambiguity branches. It also affects the older definite-refusal handoff; it is an ownership interleaving in the current shared code, not another request to change the notice contract.

Revalidate current delivery under the review lock after the core lookup: a pass must not overwrite a review that has since been handed to `Hooks`. Making ownership change and claim removal atomic for each review also removes the exposed handoff gap. Add a controlled interleaving regression with `local_core` parked, handoff occurring, and that stale pass resuming; it must leave the review with hooks, with a hook notice eventually returned and no new feedback needed. The existing tests control send/core answers individually but do not cross a global pass with an in-flight handoff.

### Verdict and validation

**Core `432b966`: APPROVE (static, unchanged). Diffd `449fc57`: CHANGES**, solely for the stale-pass/handoff race above. The two requested ambiguity exits and zero-delivery tests are corrected; prior receipt, identity, header, deadline, database-error, and publication findings remain closed. No additional issue was found in the three-file incremental change. No Cargo, tests, browser, e2e, source edits, services, push, GitHub comment, or merge were performed. Source HEAD remains `21bb9bc`; only this review report was edited.

## Final static approval — diffd `755689d`, core `432b966`

Fetched PR #6 and confirmed head `755689dcd1b2fdcc72609369f7e9d4e5cc880a5c`. Reviewed only the handoff correction against `449fc57`: four files, `app/mod.rs`, `app/push.rs`, `app/wake.rs`, and `app/push_tests.rs`. Core remains the approved `432b966f64dc9897713179f1c2d90bda867be282`.

**The stale-pass/handoff finding is closed.** Each runtime ownership update now calls `LiveInner::set_delivery`, which updates delivery and advances `delivery_epoch` under the review lock. A search of the server source confirms no other runtime assignment bypasses that helper; initial construction sets `Hooks` and epoch zero. The pusher captures each eligible review's epoch before `local_core().await`, then compares it under the same review lock before changing ownership. A handoff changes the epoch, so a stale pass skips the review instead of reacquiring it. A later transition through another owner cannot accidentally match the older snapshot.

`hand_to_hooks` now changes ownership to `Hooks` and removes the claimed ids within one lock scope per review, then notifies waiters after releasing the lock. This removes the observable Hooks-but-still-told interval. `take_fresh` retains its existing ownership recheck after the pending-message query. Together, these changes address both sides of the reported interleaving without a timeout or periodic scan.

The new barrier-controlled `a_pass_that_resumes_after_a_handoff_leaves_the_review_to_the_hooks` test parks an in-flight send, starts another pass and parks its core lookup, refuses the original send, waits for complete hook handoff, then resumes the stale pass. It checks that a hook receives both messages, ownership stays with hooks, and no second inbox send occurs. This exercises the stale-pass ordering rather than relying on arbitrary sleep timing to make the race happen. The PM reports it fails on the previous code; this reviewer inspected the test and did not execute it.

**APPROVE for the reviewed diffd `755689d` / core `432b966` pair, static review complete.** No outstanding must-fix findings remain under the clarified at-least-once wake contract. Previous safety, retention, identity, fallback, route, deadline, error-recovery, and publication fixes remain intact in this narrow delta. `git diff --check 449fc57 755689d` passes. The pair is ready for the PM's assigned Lane R build/tests and runtime/latency gates; those checks remain separate and unrun by this reviewer.

No source edits, Cargo/tests, browser, e2e, service actions, push, GitHub comment, or merge. The review-pr1 source worktree remains clean at `21bb9bc`; only this report was updated.
