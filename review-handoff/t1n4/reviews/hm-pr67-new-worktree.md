# APPROVE — home-manager-conf PR #67, new worktree

Latest verdict: **APPROVE at `b63ede6`**, on #68 `75ef821`. The original P2 is closed; the unmodified full light-check script passes at the new head. See the appended re-review. The original finding and evidence below concern `3d249ef`.

Independent review by t1n4 at **`3d249ef6de0337acd6a36dc8ab85ddd3b5a44f38`**, directly on #68's `629f1af6cd38f5e3731d799340131f265258d72b` (`wolf/herdr-app-tab-bar-back`). Fetched the PR again after PM's rebase instruction; the verdict and executed checks concern this head, not superseded `d81904f`.

Initial verdict at `3d249ef`: **CHANGES**, one P2 finding. Read the complete delta against #68, `traditional-setup-plan.md` §1/§3, `QUALITY.md`, the herdr-worktree skill and base helper, the host exec/space API contract, and the relevant bar/PM flows.

## Must fix

### 1. [P2] An unrelated first pane chooses the repository instead of the focused space

Location: `users/wolf/programs/herdr-core/app/mods/worktree-extras/main.ts:102`, using `place` at lines 37–39.

`ask()` chooses `place(s, panes()) || f.cwd || s.folder`. `place` returns the first pane with a cwd anywhere in the space, without checking which pane is focused or whether its cwd still belongs to the space's worktree. A normal `cd` in another tab can therefore change what C-a C does for the focused tab.

Confirmed by loading the actual mod at the reviewed head and executing its repository probe against two scratch Git repositories:

- Space folder **repo A**, focused cwd **repo A**, first/unfocused pane cwd **repo B**: the prompt says repo B and records repo B as the cwd passed to creation. Submitting would create a worktree of the wrong repository.
- Same space and focus, first/unfocused pane cwd **not-git**: no prompt opens; the bar wrongly says repo A is in no Git repository.

Resolve the repository from the space's own worktree folder. If a cwd fallback is needed, use the focused pane's context rather than an arbitrary pane. Keep that chosen repository context for creation/retry. Add regressions where the first pane has changed to another repository or a non-repository while the space and focused pane remain in the intended worktree. The current one-pane and linked-worktree tests cannot catch this.

Reproduction source and observed results: `reviews/hm-pr67-artifacts/3d249ef/repo-context-probe.mjs` and `repo-context-probe.log`. This used scratch repositories and the actual mod code with a fake Herdr host; it did not touch live app spaces or user repositories.

## What passes review

- **Names and existing state.** The prompt trims input, accepts the optional `wolf/` or `wolf-` prefix, rejects empty input, spaces, other slashes, leading `-`, overlong names, `..`, `.lock` and trailing dots. Existing destination paths fail without overwrite. An existing unattached `wolf/<name>` branch is reused without `-b` or a base fetch, matching the skill; Git itself rejects a branch already checked out elsewhere. New branches use `wolf/<name>` and the requested `<repo>/<name>` directory shape.
- **Execution and linked worktrees.** The shell scripts are constant strings; name and cwd are separate positional argv entries, and expansions used for paths/refnames are quoted. No user input is interpolated into shell source. `git rev-parse --path-format=absolute --git-common-dir`, then its parent, resolves an ordinary linked worktree to the main checkout instead of nesting a new worktree under the current checkout. The real-Git test exercises that case. The repository-selection defect above occurs before this otherwise-correct resolution.
- **Machine targeting.** The chosen space's `machine` is passed as `exec(..., {on})` for both probe and add. `space.new` receives that same machine explicitly, including `""` for local, and success lookup matches both folder and machine. The host API rejects an unreachable/unsupported remote execution; there is no retry on the local machine. Tests inspect the remote `on` and `machine` arguments.
- **Base selection and fetching.** New branches call the existing `herdr-worktree-base` helper on that machine. The helper uses `herdr.worktreeBase`, otherwise asks origin for its default branch and fetches it, returning a commit so the new branch does not track the default branch. No origin, or a failed default-branch lookup/fetch, uses the helper's established HEAD fallback; failure fetching an explicit override is nonzero and the add is not attempted. The real-Git test stubs the helper with a commit behind HEAD and proves the new branch starts there. Helper contents were inspected; no real remote fetch was triggered by the review probes.
- **Space/error flow.** Success opens the new folder on its machine and selects it. An add/base failure stays in shared `worktree.new`; a failed space-opening retry retains `dest` and does not add the worktree twice. #68's marker renders the error reason, click sends `worktree-extras.retry`, and × clears it. New item 57 requirement coverage drives those rendered controls as well as prefix → prompt → create → selected space. There are no new failure toasts.
- **C-a c and New PM.** C-a c remains plain `tab.new`. The In-flight header sends `tabs-wolf.new-pm`, reaching the retained #51 flow: local-deacon lookup, a distinct kept Claude session/space, PM/deacon labels, briefing and focus, with the no-local-deacon refusal still covered. Requirement 36b and the unrelated title/count requirement are retained from #68. Requirement 48 changes its entry trigger/name for item 57, preserving its substantive assertions; the rest of this PR's requirement changes add item 57 coverage.
- **Test setup.** `tests.nix` adds `pkgs.git`; the new script test actually creates linked worktrees in a temporary HOME and checks branch, path and base, rather than only matching source text.

## Executed validation

Ran the **unmodified `run-tests.sh`** from an isolated Git archive of `3d249ef`, with the specified TypeScript executable on PATH and no install/build step. Load at start was **66.91 < 100**. Exit **0**, **11.6 seconds**:

- TypeScript: **15 sources**, pass.
- Node: **14 test files**, pass, including **7/7 new-worktree tests** and **28/28 requirement tests**.
- Python: **5 test files, 72 tests**, pass.

`git diff --check 629f1af 3d249ef` also passes. Suite output and head/load/tool metadata are in `reviews/hm-pr67-artifacts/3d249ef/run-tests.log` and `run.json`. The green suite does not cover the confirmed repository-selection failure above.

No source worktree edits, installs, Nix/Cargo/Gradle builds, browser/emulator runs, live app changes, configuration switches, pushes, GitHub comments or merges were performed. Verdict reported to t1jf via `hc send`.

## Re-review at b63ede6 — APPROVE

Fetched `pull/67/head` and confirmed **`b63ede6cd12bf196858a4082ba4ab0253d67d881`**: fix `b63ede6` on rebased implementation `5224059133745d3ec1057b82eb79a483da1e7eca`, based on #68 **`75ef821ff6d3dcc688f1e30ed01e415df48c6a42`**. Reviewed the fix and the rebase differences from the original reviewed head.

**P2 closed.** `ask()` now probes the focused space's folder first. Only if that is absent or outside a repository does it probe the focused pane's cwd, on the same space machine. It no longer calls `place(s, panes())` for this operation. The selected cwd is passed through the prompt/request to creation and retained in failure state for retry, so an unrelated pane cannot change the operation's repository.

The added regression covers another tab in repo B or outside Git while the space remains in repo A; a non-repository/empty space folder with the focused pane inside repo A; and neither source being in a repository even though another pane is in repo B. I also reran the **unchanged original reproduction against actual scratch Git repositories** using the new mod: both failing cases now prompt for repo A and retain the space's repo-A folder. Results are saved under `reviews/hm-pr67-artifacts/b63ede6/repo-context-probe.log`.

The rebase correctly removes the remaining `throughBar` path for c/C from #68: C-a c dispatches native `tab.new`, and C-a C dispatches `worktree-extras.ask` directly, independent of whether the top bar is visible. The native navigation/rename keys from #68 remain direct. The requirement fixture now explicitly gives the focused space its worktree folder; it does not weaken the expected create, select or error-marker behavior. The creation script, name rules, base helper, machine binding, retry logic and New PM header flow are unchanged from the prior review.

Ran the **unmodified `run-tests.sh` again at `b63ede6`** in a fresh isolated Git archive, with the specified TypeScript executable. Load at start **52.57 < 100**; exit **0**, **10.47 seconds**:

- TypeScript: **15 sources**, pass.
- Node: **14 files**, pass, including **8/8 new-worktree tests** and **28/28 requirement tests**, with no skips in either suite.
- Python: **5 files / 72 tests**, pass.

Full and fix-only `git diff --check` pass (`75ef821..b63ede6`, `5224059..b63ede6`). New run metadata, full log and original-reproduction results are in `reviews/hm-pr67-artifacts/b63ede6/`. **APPROVE, no remaining findings.** No source worktree edits, installs, heavy builds, browser/emulator runs, live app/configuration changes, pushes, GitHub comments or merges were performed. Verdict sent to PM t1jf via `hc send`.
