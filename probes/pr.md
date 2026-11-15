On a phone the review page's sidebars didn't work: reported on a Pixel 9 Pro Fold (Chrome, Android).

## What was wrong

Reproduced with Playwright at the Fold's sizes (412×915 cover screen, 884×1050 / 1050×884 inner screen, dpr 2.625, mobile + touch):

- Nothing in `web/` reacted to screen size. Both drawers sat **beside** the code at their desktop size, so on the cover screen the files/tour drawer took 248 of 412px and the diff got **153px**. The summary wrapped one word per line.
- The only way to open or close a drawer was its edge: a **7px** drag strip (double-tap to close) or an **11px** collapsed handle. There was no button and no backdrop, and opening the activity drawer would squeeze the code from both sides.
- Tree rows were 20px tall, and a folder's `⋯` (show other files) only appeared on hover.

## What changed

- **Narrow screens (under 768px):** each drawer is a sheet that slides over the code from its side. Only one is out at a time, and both start closed. Buttons at the ends of the top bar open and close them. Tapping the dimmed code or pressing esc puts the sheet away, and so does opening a file, a `path:line` link or an activity item from it (asking in the chat leaves it open). Keyboard commands (`ctrl-h`/`ctrl-l`, toggling a drawer, focusing the chat) go through the same open/close state. The saved desktop drawer layout is left alone.
- **Touch screens of any width** (the unfolded inner screen, tablets): the same two buttons show, and the drawers stay beside the code. Tree, activity and commit rows, tabs, label chips and the filter box get 44px targets, and `⋯` no longer needs hover. This uses a `touch:` Tailwind variant (`pointer: coarse`). The windowed tree's row height follows it.
- **Desktop with a mouse:** unchanged. The buttons are hidden, the rows are still 20px, and the drawers are still resizable inline (see the screenshot).

Main pieces: `web/src/lib/media.ts` (media-query signals), `drawerOpen`/`setDrawerOpen`/`doneWithSheet` in `web/src/state/view.ts`, sheet mode in `web/src/components/Drawer.tsx`, `DrawerButton` in `web/src/components/Chrome.tsx`.

## Screenshots

Before is the live review from the report (deployed d4ff2fb). After is a local build of this branch on a demo review with a tour.

**Fold cover screen, 412×915**

| Before | After | Files open | Activity open |
|---|---|---|---|
| <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/live-before-cover.png" width="200"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/after-cover.png" width="200"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/after-cover-files.png" width="200"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/after-cover-activity.png" width="200"> |

**Fold inner screen, 884×1050 (touch)**

| Before | After | Activity open |
|---|---|---|
| <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/live-before-inner.png" width="270"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/after-inner.png" width="270"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/after-inner-activity.png" width="270"> |

**Inner screen landscape, 1050×884:** <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/after-innerland.png" width="300">  **Desktop, 1440×900 (unchanged):** <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/after-desktop.png" width="400">

## Verification

- `npm --prefix web run lint`, `typecheck` and `test` (58 tests) pass. No Rust changed.
- `just e2e`: a new section in `web/e2e/full.mjs` drives the cover screen with touch. Both drawers start away and the code has the full width. The files button is at least 44px, it opens the sheet over the code, and tree rows are at least 44px. Tapping a file opens it and closes the sheet. The activity button shows the chat, and tapping the backdrop closes it. Widening to 884px puts the drawers back beside the code. Locally, with the language servers from nixpkgs, all 28 sections pass ("All checks passed"), including the desktop drawer section.
- I also ran this page at 412, 884×1050, 1050×884 and 1440 with touch emulation: no page errors, and the desktop layout measured the same as before (left drawer 248px, right 250px, rows 20px, no buttons).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
