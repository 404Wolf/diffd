# APPROVE — diffd PR #5 CPU fix at `95d89aa`

The original P1 below is closed by the metadata-only follow-up. See the appended re-review for the final verdict; the initial review at `511ff46` is preserved below.

Independent static review by t1n4, 2026-11-14. Fetched PR #5 and confirmed head `511ff46d834f145484391b1b6e5e599239cad96a` (`wolf/diffd-cpu`), based on `9ed9ab0e45a498de07b45982675da8895752fb73` from `claude/youthful-dirac-5ow4dj`. Reviewed the four changed files, the gate, notification and delivery paths, CI/package build configuration, `reports/diffd-cpu.md`, and `QUALITY.md`.

## Must fix

**[P1] Commit the SQLx offline metadata for both changed queries.** At `crates/diffd-server/src/adapters/store.rs:184–205`, `review()` removes `status` from its SELECT and `reviews_since()` adds another SELECT. Neither exact SQL string has a cache entry in the committed `.sqlx/` tree. Their SHA-256 cache names are:

- `.sqlx/query-e17346abbd4deca540e79c44109202f0ade7021959149809a6caef01d14a1c39.json` (`review`).
- `.sqlx/query-8fce4ef7c5587cc2b9b65928cf8bf2aca4af1dde8dd879e90c75a19f51111ead.json` (`reviews_since`).

`justfile` exports `SQLX_OFFLINE=true`, CI invokes `just lint` / `just test` / `just build`, and `nix/package.nix` explicitly builds using the committed offline data. Consequently the checked-in head cannot pass those builds: `query_as!` has no matching cached query descriptions. The commit message acknowledges that `just sqlx` is needed, but the generated files must be included in the PR. Generate and commit the metadata in the approved Lane R slot, then run the Rust gates. This conclusion comes from comparing the literal query hashes with the committed tree; no build was run.

## Cause and wake semantics

- The reported cause matches the parent code. Every wake-loop pass enumerated recent reviews through `Store::recent(200)` and then slept for the smallest `gate.wait_ms(now).max(100)`. One settled nearby review therefore forced a 100ms interval even with no feedback, including when its only pending feedback had already been told. `recent()` performs one id query plus `review()`, `read_seq()`, and `activity()` per result: 205 reads for 68 reviews. The report's ~25k reads/s and ~170% CPU are consistent with this path; they remain the implementer's measured/estimated evidence, not fresh measurements by this reviewer.
- The replacement distinguishes ready feedback, untold feedback held for the pause, and nothing new. Only untold feedback with no draft contributes a gate timer. Multiple held reviews use their minimum wait, capped at the existing five-second rescan. A settled review with no fresh messages no longer forces polling.
- The 1500ms quiet period is unchanged. `FeedbackGate::ready` still requires no open draft and a settled last activity. Comments, user replies, and user chat notify after saving; draft transitions notify after updating the gate. WebSocket disconnect cleanup closes an open draft through the same notifying method. A draft closing starts its own quiet period, after which the held-feedback timer releases the notice.
- Wake notification futures are still registered and enabled before `take_notice()` reads pending messages. Thus activity during that read or between inspection and sleeping is retained by the registered waiter. The loop rechecks the gate after every notification; ongoing activity extends the pause instead of prematurely releasing feedback.
- The five-second rescan still discovers newly shared reviews and backs up missed notifications. Existing nearby reviews normally wake through notification plus the pause timer, without waiting for the rescan. New-review discovery can still take up to one rescan interval plus the gate wait, as before. Cancel/replacement registration, listener lifetime, the deadline cap, and the delivery path are unchanged. No new lost-feedback or notification-delay regression was found in this scheduling change; this is a static assessment, not an execution guarantee.

## Query and tests

`reviews_since(since, 200)` retains the previous seven-day inclusive cutoff, descending update order, and 200-result cap. Filtering by the cutoff before limiting is equivalent to taking the sorted prefix and then `take_while(updated_at >= since)`. It reads review metadata in one query without calculating unread activity. `ReviewRow::parse` preserves the previous metadata mapping, including optional fields and spec-derived terminal/core id; removing the unused `status` column does not change its existing `Open` mapping.

`an_idle_waiter_doesnt_poll` exercises both the no-feedback and already-told-but-undelivered cases, counting loop inspections over 2.5 seconds. Its at-most-two bound distinguishes the previous roughly 25 inspections from the new idle behavior. The tightened pause test checks both the minimum quiet period and a wake before 4.5 seconds, rejecting a fallback to the five-second rescan. Existing tests cover draft hold/release, directory filtering, replacement/cancel, and abandoned `wait_for_feedback` calls. A query cutoff/order/limit test and a newly-shared-review rescan test would improve coverage, but are not additional blockers from this review.

## Validation and scope

Static inspection and `git diff --check` passed. Cargo, SQLx preparation, Rust tests, browser, and e2e were not run: they require Lane R authorization. Rust validation remains pending, including `wake`, `review_loop`, and `http_mcp`. The implementation is a focused correction to the existing path and query, with a documented cause and regression tests; no temporary workaround or UI/mobile-specific change is introduced.

Only this review report was written. No source edits, push, GitHub comment, merge, service restart, or interaction with live diffd port 3433. The review-pr1 worktree remains clean at PR #4 head `21bb9bc`; its Lane E lint/typecheck/Vitest job is still queued for t1jf's explicit go.

## Re-review at `95d89aa` — APPROVE

Fetched PR #5 again and confirmed head `95d89aa5ed7fb1e33bd717de6e48db065acc37d0`. Compared the complete Git trees against reviewed head `511ff46d834f145484391b1b6e5e599239cad96a`: the only changes are the two required `.sqlx` cache entries added and the stale `query-7f9c25faa78b35584f5a5148f5c22c1746bba3a0a0e89ef71e27f9ade0dc8027.json` removed. All other 25 existing cache entries are byte-identical by Git blob id. No source, tests, build configuration, or other files changed.

Verified each new entry's literal SQL and SHA-256 hash against its `query_as!` invocation. Both describe the expected 11 `ReviewRow` fields, ordered column ordinals, SQLite Text/Integer types, and nullability (only `summary` and `to_rev` nullable). Parameter counts match: one for `review`, two for `reviews_since`. `git diff --check 511ff46 95d89aa` passes.

**P1 closed; no outstanding must-fix findings. APPROVE.** The previously reviewed wake/gate/notification behavior is unchanged. PM t1jf reports an offline Cargo check passing and wake tests **5/5** at this head; those are upstream validation results, not checks rerun by t1n4. This re-review was static only, with no Cargo, browser, e2e, or service actions. PR #4's worktree remains clean at `21bb9bc` (its separate web gates have since passed).
