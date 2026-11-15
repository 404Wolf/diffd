Section 24 of `web/e2e/full.mjs` ("Text objects…") fails intermittently at **"0 back on the whole line"**. Diagnosed in the #2 review.

The `$` and `0` checks looked for ` · ` anywhere in the status line, to tell whether the cursor is on a word (`lib.rs:45 new · tokens`). But when no message is covering them, the key hints shown beside the cursor's position (`]c hunk · ]f file · …`) contain ` · ` too. So "no word after `0`" failed whenever the hints were showing, and passed only when a message happened to be covering them.

**Fix:** the status line marks the cursor's position with `data-cursor-status` (a one-attribute change in `Chrome.tsx`), and the two checks read only that. I didn't use a positional selector like `footer > span:nth(1)`, so the checks won't break if the status line's layout changes. Nothing else changes.

**Verified:** two full `just e2e` runs on this branch, with the language servers from nixpkgs, both pass all 28 sections ("All checks passed"), including "✓ 0 back on the whole line". A third run, between those two, stopped early at section 3: rust-analyzer's "references to clamp" timed out, which has nothing to do with this change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
