This PR is stacked on #1 (base `wolf/mobile-sidebar`). It's the follow-up from that PR: on a Fold's cover screen (412px) the top bar wrapped to three or four lines (logo, title, repo and refs, file counts, the agent's presence), so the code started about 100px down.

## What changed

Under 768px the top bar is **one line, 49px** (it was 98–103px):

`[files] title… [commit chip, if one is shown] [⋯] [activity]`

- The title takes the space left and is truncated. The commit chip (e.g. `701baf2 ×`) stays in the bar so "back to all changes" is still one tap, and it truncates too.
- The **details button** (`⋯`, 44px on touch) shows the agent's presence as a dot. It opens a Kobalte popover with the full title, repo and refs, revision, file counts, the presence text and an "All reviews" link (the logo is hidden on phones). Tapping outside or pressing esc closes it. Focus stays on the button so the link isn't ringed on open.
- The bar's pieces are shared between the bar and the popover. On phones the bar hides them with `max-md:hidden` wrappers (`display: contents` otherwise), so wider screens get exactly the same elements and layout. `#presence` is unchanged for the e2e tests.

Wider screens are unchanged. I measured the same review on #1's build and on this one: at 1440px the header is 33px without a commit chip and 59px with one, on both builds.

## Screenshots (412×915 unless noted; same review with a long title)

| Before (#1) | After | Details open |
|---|---|---|
| <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/topbar-before-cover.png" width="260"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/topbar-after-cover.png" width="260"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/topbar-after-cover-details.png" width="260"> |

| With a commit shown, before | After | After, 360px |
|---|---|---|
| <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/topbar-before-cover-chip.png" width="260"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/topbar-after-cover-chip.png" width="260"> | <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/topbar-after-small-chip.png" width="230"> |

Desktop 1440px with a commit shown, before / after (same): <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/topbar-before-desktop-chip.png" width="400"> <img src="https://raw.githubusercontent.com/404Wolf/diffd/pr-assets/mobile-sidebar/topbar-after-desktop-chip.png" width="400">

## Verification

- `npm --prefix web run lint`, `typecheck` and `test` pass. No Rust changed.
- The phone section of `web/e2e/full.mjs` now also checks that the top bar is one line (≤56px) and that the details popover shows the title, refs and file count and closes on esc. Locally, with the language servers from nixpkgs, all 28 sections of `just e2e` pass on this branch after rebasing onto #1's review fixes ("All checks passed").
- I also measured it at 360, 412, 884 (touch) and 1440, with and without a commit chip: one 49px line at 360 and 412, and no page errors.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
