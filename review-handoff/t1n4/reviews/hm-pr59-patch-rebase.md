# APPROVE — home-manager-conf PR #59 patch rebase

Independent review by t1n4. Fetched `pull/59/head` and confirmed `048d899e14cd715acf0b34d58a71996104be62b4`, directly on PR #55's `b813a764b8757366edbd415a38d3514d7e8140b7`. Verdict: **APPROVE**. No behavioral additions, omissions or regressions found in the patch rebase.

Compared the old patch stack applied to core `c645d000865c1f2c28ffaa8451d56c5dee9d1c59` with the new stack applied to `1c456496078558263e3f253bb8bd3cfe873cf9f6` (the inbox and replay merges). This review covers the rebase, preserving the separately approved upstream changes. It does not initiate a build or restart.

## Independent comparison

The PR regenerates eight patch files. I checked the complete nine-patch order from `packages/herdr-core.nix`, including the unchanged final `hidden-reporter-fallback.patch`, against isolated snapshots of all 26 affected source/documentation/schema files.

- Both complete stacks apply with `git apply`. A separate GNU `patch --batch --fuzz=0 -p1` pass applies all **9/9 new patches with no offsets or fuzz** and produces exactly the same 26 files.
- Independently three-way merging each old patched file with its old and new upstream base gives an exact byte match for **24/26 files**. This includes viewer selection, visibility/focus negotiation and relaying, diagnostics, server frame handling, AttachParams/AttachResult, documentation and OpenRPC.
- The only merge conflict is the expected `api.rs` FEATURES array. Its resolution retains the complete new upstream list, including `queue` and `queue-keyed`, followed by the old patch additions `viewer_visibility` and `viewer_focus`. After resolving that array, the entire file is byte-identical to the new applied stack. No method-table or handler edits were misplaced.
- The remaining file, `remote/tests.rs`, only moves the two peer-build tests before the focus tests. All **12 test bodies and the file preamble are identical** after accounting for order.
- Comparing patch added/removed line multisets leaves differences only in the two FEATURES hunks in `viewer-visibility.patch` and `focused-window.patch`. `visibility-fallback.patch` changes diff-section order; its payload is retained. The other changes are context, offsets and blob headers.
- Parsed OpenRPC confirms **AttachResult and the entire `terminal.attach` method schema are identical JSON values** across the applied stacks. Visibility/focus fields, defaults and negotiation remain attached to their original definitions; nothing was inserted into unrelated structs/functions.

These checks support the existing visibility/focus contract and the no-hacks quality bar in `QUALITY.md`. The rebase preserves the old behavior while applying cleanly to the newer core.

## Validation and limits

PM supplied the patched build's green result and crate-suite parity with the known environment failures plus the existing desktop-priority failure. I did not rerun those gates. Static inspection corroborates the latter: `tests/desktop_size.rs` is unchanged between the core bases and still expects a phone to displace a visible desktop, while the applied desktop-priority selector is unchanged by this rebase.

The outer repository's `git diff --check` reports 58 trailing-space warnings. Every flagged line was checked: each is exactly the required single-space blank context marker inside a regenerated patch, rather than an added source line. This is not a source whitespace regression.

Evidence is in `reviews/hm-pr59-artifacts/048d899/`: `summary.json`, `applied-interdiff.diff`, `upstream.diff`, residual comparison diffs and `new-gnu-patch.log`. Temporary comparison snapshots are recorded in the summary. No builds, tests, source worktree edits, configuration changes, restarts, pushes, GitHub comments or merges were performed. Verdict sent to t17d and t1jf via `hc send`.
