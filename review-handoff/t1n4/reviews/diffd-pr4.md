# Review in progress — diffd PR #4 at `21bb9bc`

Resumed by independent reviewer t1n4. Fetched `origin pull/4/head` and checked out `FETCH_HEAD`; confirmed full head `21bb9bc7fcf306bb709c3a11def0c98b6d740730`, with a clean source worktree.

The four fixes pass static review against `/home/wolf/herdr-android/QUALITY.md`:

- `CommentPopover.tsx:127–154` saves the current composer/quote with the existing textarea text when the anchor changes, and restores an equal saved composer after reload.
- `commands.ts:1109–1157` stores the original starting line in `Composer.from`, preserves it when moving the endpoint, and uses it for Clear range. Reverse drags keep their actual starting line; older drafts fall back to `anchor.start`.
- `Buffer.tsx:95–112` finds the nearest rendered row in the originating file using its geometry and the measured sticky header bottom. It avoids a fixed header offset and shares the existing pointer path across mouse, touch, and pen.
- `CommentPopover.tsx:201–216` renders Clear range in the shared composer only for a multi-line range, with a 44px coarse-pointer target. Responsive CSS and one composer remain in use; no UA sniffing, duplicate mobile implementation, or temporary production patch found.

The committed e2e phone section now covers draft reload on a moved range, endpoint correction across the first tap, Clear range, and upward hold under the sticky header. Prior reviewer evidence at this exact head in `diffd-pr4-artifacts/21bb9bc/` confirms all original failure probes, Clear range forward/reverse with text preserved, and touch comment/reply/resolve at 412×915, 884×1050, and 1050×884. Those results are inherited evidence, not a fresh full-suite run by t1n4.

## Fresh web gates at `21bb9bc` — 2026-11-14, t1n4

After t1jf's explicit Lane E go and confirmation that the lane's RAM gate replaces the outside-lane load limit, ran the following in sequence using the existing `web/node_modules`. `free -g` reported 11 GB available at the start, exceeding the required 10 GB. No dependency install was needed.

- `npm --prefix web run lint`: **PASS**, 61 files checked, exit 0.
- `npm --prefix web run typecheck`: **PASS**, no errors, exit 0.
- `npm --prefix web test`: **PASS**, 58 tests in 3 files, exit 0.

The three checks completed in approximately 18 seconds. Start/done were recorded in `/home/wolf/deacon/SLOTS.md`; results were reported immediately to t1jf so the next Lane E job could run. Evidence: `diffd-pr4-artifacts/21bb9bc/lane-e-t1n4-web-checks.log` and `.json`.

**Final verdict pending the unmodified 29-section full e2e on a newly owned private instance.** That run still requires Lane R authorization. The old `7ae5208` e2e result below does not certify `21bb9bc`. No new server, browser, production build, or e2e process was started; live port 3433 was untouched. No push, GitHub comment, or merge.

## Previous review — CHANGES at `7ae5208` (historical)

Reviewed head `7ae5208` against the PR diff, the approved `diffd-mobile-review-design.md`, and `QUALITY.md`. All requested automated checks pass, but independent interaction probes found three must-fix issues.

## Must fix

1. **[P2] Persist the updated range when extending an existing typed draft.** `web/src/state/commands.ts:1124` changes the composer anchor without updating its saved draft. On 412px touch: tap L8, type a comment, then tap L12. The visible composer correctly becomes L8–12 and keeps the text, but localStorage still contains the L8-only composer. Reload restores the text on **L8**, losing the chosen range and potentially attaching the eventual comment to the wrong lines. Keep the persisted composer/quote synchronized with range changes, without requiring another keystroke. Evidence: `diffd-pr4-artifacts/probes.json`, test `draft extension/reload`, and `draft-after-reload.png`.

2. **[P2] Upward edge-scroll must extend the selection past the sticky header.** `web/src/components/Buffer.tsx:93` clamps hit testing to the buffer edge, where `elementFromPoint` returns the sticky file header. `rowUnder` then returns null even while `scrollAtEdge` keeps scrolling. Reproduction: start on L100 of a long file, drag to three pixels below the buffer's top, and hold for 900ms. Scroll position moves from 1304 to 644, but the cursor/selection remains L100; release opens a one-line L100 composer. Downward edge-scroll does extend the range. Select the nearest eligible code row when the edge is covered by sticky UI, using the layout rather than a fixed header-size offset. Evidence: `probes.json`, test `edge scroll` / `up`, and `edge-up.png`.

3. **[P2] Keep the initial tap as the anchor when correcting the range endpoint.** `web/src/state/commands.ts:1123` derives the next range from its current min/max bounds, so crossing the original start retains the previous endpoint. Taps on L10 → L20 → L5 produce **L5–20**, instead of moving the end relative to the initial L10 tap (**L5–10**). Subsequent taps now use L5 as the start. Preserve an explicit initial anchor so endpoint changes are consistent in both directions. The approved “Clear range” control is also absent from the header at `web/src/components/CommentPopover.tsx:201`; provide the planned reset without discarding the typed comment. Evidence: `probes.json`, test `range endpoint correction`.

Add regression coverage for draft reload after extension, upward auto-scroll under a sticky header, and endpoint correction across the initial anchor. The new e2e section currently exercises short drags and the first forward tap pair, which pass.

## What passes and design judgment

- **The desktop plain-click change is right.** With the composer closed, clicking L12 after placing the cursor on L5 now starts an L12-only comment. Shift-click on L15 still selects L5–15. This is predictable editor behavior, matches the approved design, and avoids the previous accidental range from an unrelated cursor position. Mouse dragging also selects a range, as intended.
- Mouse, touch, and pen use the same pointer-event path; primary-pointer/button checks replace UA or pointer-type behavior branching. Pen dragging independently selected L3–6. Pointer cancellation clears the selection without opening a composer.
- `touch-action: none` is confined to `.num`; code/buffer remain `auto`. A native touch drag starting on code scrolled the buffer (0 → 64px), with no composer; a drag outside the gutter on a thread also scrolled normally.
- At **412×915**, **884×1050**, and **1050×884**, touch drags selected L8–12 and Comment/Cancel/Reply/Resolve targets measured at least 44px. Comment, reply, and resolve all worked by tap at each size. Coarse-pointer textarea text is 16px.
- The same composer docks full width below 768px and floats at wider widths. The viewport includes `interactive-widget=resizes-content`. At **412×520**, simulating the keyboard's viewport resize, the composer remained on screen with the selected lines visible above it. This checks the viewport contract and resized layout; it is not a physical Android IME test.
- The approved design note precedes the implementation, and the PR includes before/after screenshots at all three Fold sizes. No duplicated mobile composer, UA sniffing, or temporary production patch found. The interaction bugs above need resolution to meet the quality bar.

## Gates and isolation

- Web lint: **PASS**.
- Typecheck: **PASS**.
- Vitest: **PASS — 58 tests in 3 files**.
- Production web/release build: **PASS**.
- **Unmodified `web/e2e/full.mjs`: PASS — all 29 sections, exit 0**, including existing desktop checks, the new phone drag/comment/reply/resolve checks at all Fold sizes, and no console errors. Log: `diffd-pr4-artifacts/e2e-head.log`.

All evidence/scripts/screenshots are in `/home/wolf/herdr-android/reviews/diffd-pr4-artifacts/`. Used my rebuilt PR-head binary on **43461**, private `/tmp/diffd-pr4-*` repositories/database, and PID/port-checked stop/start commands. Stopped the private instance after testing. This review never stopped or restarted **3433**. No source edits, push, GitHub comment, or merge.
