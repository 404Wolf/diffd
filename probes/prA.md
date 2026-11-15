Part A of reviewing from a phone (item 25): **selecting lines and commenting** by touch, without shift-click, `V`/`j`/`k`, or a character-by-character text selection. Parts B (a command bar for keyboard-only actions, and symbol actions) and C (a compact tree in the Tour tab) follow as their own PRs.

Design note (approved before building): `~/herdr-android/reports/diffd-mobile-review-design.md` on the review machine. It also has the audit of every mouse-, hover- and keyboard-only interaction, summarised here:

| Interaction | Before | Covered by |
|---|---|---|
| Comment on a range | shift-click, `V`+`j/k`+`gc`, or a text selection | **this PR**: drag over line numbers; tap start, then tap end |
| Composer with the on-screen keyboard | floated by the line, under the keyboard | **this PR**: docked above the keyboard on narrow screens |
| Thread Reply/Resolve, composer and selection buttons | ~20px | **this PR**: 44px on touch |
| Right-click menu (definition, references, …) | right-click only | B |
| Docs and diagnostics cards | `mousemove` or `K` | B |
| Next/previous hunk, file, thread, unread; mark viewed; reply here; go to file | keys only | B (a command bar built from `BINDINGS`) |
| Tour file list | full paths, flat | C |
| Edit a sent comment; approve | not in diffd's API | out of scope |

## How it works

- **One pointer path for mouse, finger and pen** (`Buffer.tsx`). It replaces the click handler on line numbers. Pressing a line number puts the cursor there and starts the existing visual range (`view.visual`, which already paints `.vsel`). Dragging extends it: the row under the pointer comes from `elementFromPoint`, and holding near the buffer's top or bottom edge scrolls it. Releasing opens the composer through the existing `cmd.comment()`. A tap or click is still a one-line comment. Shift extends from the cursor. It's the primary button and primary pointer only, so a second finger is ignored. There is no user-agent or `pointerType` branching.
- **`touch-action: none` on line numbers only** (`styles.css`), so a finger drag that starts on them selects lines, and anywhere else it scrolls. `-webkit-touch-callout: none` stops a long press from opening the callout.
- **Tap the start, tap the end:** while a new comment is open, tapping another line number in the same file and side changes its range (`cmd.extendComposer`). This is for ranges taller than the screen, and it also works with a mouse. **The rule:** the line the range was started from (the first tap, or where a drag began) stays put, and each tap moves the other end. L10, then L20, is L10–20; then L5 is L5–10. The composer keeps that line (`Composer.from`, saved with the draft, so the rule survives a reload). **Clear range** in the composer's header puts it back to that one line. On touch the composer says "Tap another line number to move the range's end".
- **Finding the row under a drag:** by geometry, among the file's rows in view below the sticky file header, so holding a drag over that header (or over a thread card or a gap) still picks a row; past the rows in view, it's the nearest one. When the range moves, the saved draft moves with it.
- **Composer on narrow screens (under 768px):** the same component, docked full width along the bottom of the code instead of floating by the line. `index.html`'s viewport gains `interactive-widget=resizes-content`, the standard way for Chrome to shrink the layout viewport for the on-screen keyboard, so the composer sits right above the keyboard with no measuring. The lines it's about are scrolled into view above it when it opens and when the viewport resizes.
- **Targets on touch** (`touch:`, i.e. `pointer: coarse`): Cancel and Comment, the selection's Comment button, and a thread's Reply, Resolve and Next note are at least 44px, and their key hints are hidden. The textarea uses 16px text.

**Behaviour change to note:** before, a plain click on a line number while the cursor was elsewhere in the same file opened a *range* from the cursor, because the start was read before the cursor moved. Now a plain click means that line, and shift-click extends, as the code comment always said.

## Screenshots

Before (deployed, a tap on a line number; a drag only scrolled) and after (a finger drag over lines 45–50):

| | 412×915 (cover) | 884×1050 (inner) | 1050×884 (inner, landscape) |
|---|---|---|---|
| Before | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/review-before-cover.png" width="200"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/review-before-inner.png" width="260"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/review-before-innerland.png" width="300"> |
| After | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/review-after-cover.png" width="200"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/review-after-inner.png" width="260"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/review-after-innerland.png" width="300"> |

412px with the on-screen keyboard up (viewport 412×520), then the sent comment with 44px Reply/Resolve:

<img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/review-after-cover-keyboard.png" width="260"> <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/review-after-cover-thread.png" width="260">

## Verification

- `npm --prefix web run lint`, `typecheck` and `test` (58) pass. No Rust changed.
- New e2e section 28, "Reviewing from a phone", in `web/e2e/full.mjs`:
  - At 412×915 with touch, a finger drag selects L3–6, and the composer is docked full width with a 44px Comment button.
  - With the viewport shrunk to 412×520, as the keyboard would, the composer is fully on screen and the selected lines are visible above it.
  - Tapping Comment sends it; Reply (44px) adds a reply; Resolve works by tap.
  - Tapping L10 then L12 makes L10–12; the typed draft survives a reload on L10–12.
  - L20 next gives L10–20, then L5 gives L5–10. Clear range (44px) goes back to L10.
  - Holding a drag up over the sticky header grows the range upward (L1–14 from L14).
  - At 884×1050 and 1050×884 with touch, a finger drag selects L7–9, and the composer is on screen with 44px buttons.
  - At 1500px a mouse drag selects L7–9.
- The full `just e2e` passes all 29 sections (re-run after the review fixes), with the language servers from nixpkgs. The existing desktop sections pass unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
