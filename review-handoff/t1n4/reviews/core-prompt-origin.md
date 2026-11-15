# APPROVE — herdr-core PR #3, prompt origin

Latest verdict: **APPROVE (static) at `55e874d`**. The original P2 below is closed by the appended re-review. Build/runtime validation remains for its later Lane R run; this is not part of tonight's restart.

Independent static review by t1n4. Fetched `pull/3/head` and confirmed `532d044f09fbaeef58d79c2a7a602d14d8ccf3f6`, its single commit on `131019c1fcf03081b53be16c6140688c729f5bfb`. Reviewed all eleven changed files, the surrounding input, persistence and public serialization paths, the repository instructions, and `QUALITY.md`. No source checkout or edits, builds, tests, browser runs, or live-service changes were made.

Initial verdict at `532d044`: **CHANGES**, one P2 finding. The requested metadata and isolation conditions otherwise pass static review. The finding below records the original head.

## Must fix

### 1. [P2] An ordinary Alt key sequence can permanently suppress human prompt attribution

Location at the reviewed head: `crates/herdr-core/src/input.rs:95–104`, in `Gate::submission`.

`ESC ]` is also the ordinary legacy encoding of Alt+]. The new parser treats it as the start of an OSC and retains the entire unfinished sequence in `key_tail`. If the person subsequently types a question and presses Enter, there is still no OSC terminator, so the parser retains that input too and never visits its CR. Every later Enter is likewise ignored until a BEL or `ESC \\` happens to arrive. The bytes still reach the program normally, but `hc get` and turn events keep reporting an older agent prompt (or no prompt) for human submissions. This breaks the field's use for deciding whether a completed turn answers a person. The retained buffer also grows without a bound and is copied/scanned again on subsequent input frames.

Static trace / regression to add inside the existing Gate tests:

```rust
let mut gate = Gate::default();
gate.viewer(b"\x1b]", true); // Alt+]
assert!(gate.take_prompt().is_none());
gate.viewer(b"question\r", true);
assert_eq!(gate.take_prompt().expect("human Enter was delivered").by, "human");
```

At this head the final `take_prompt()` is `None`: both calls take the `!complete` branch. This trace was inspected, not executed under the build hold.

Keep partial escape parsing bounded and ensure ordinary Escape/Alt input cannot leave subsequent human Enter events permanently hidden. Preserve the split CSI-u and bracketed-paste behavior already covered by the new test; add coverage for this sequence followed by normal submissions and for malformed/incomplete input not retaining an ever-growing history.

## What passes static review

- **Optional, additive public data.** `Terminal.prompt` defaults to `None` and is omitted when unknown; registry initialization leaves it unknown. `Prompt.from` is omitted when unavailable. The Public serializer retains the field, the schema makes it optional, and the ordinary Serde terminal records accept unknown fields in older clients. No existing request parameters or required result fields change.
- **Submission timing and source.** Immediate human Enter is stamped in `viewer_input` when a holder link exists. Human input held behind a send is stamped only when the held bytes are released. Typed sends stamp `agent` at their Submit step, including the existing caller when known; launch tasks and automatic note submissions use the same step. Automatic viewer input does not manufacture a human prompt.
- **Queue and refusal behavior.** A new inbox enqueue stamps `agent` with the message's existing sender and enqueue timestamp. The known-key repeated branch never reaches `push`; status/refusal checks precede it. Refused typed sends never reach Submit. Thus retries and refusals leave the last prompt intact.
- **Persistence and turn events.** The prompt lives in the persisted terminal record. Agent submission/enqueue paths save the registry; immediate human input uses the existing two-second `save_soon` mechanism, and graceful handover/shutdown saves the full registry. Turn events copy the latest stored prompt when present, without inferring program consumption or inventing attribution from OSC status. The documentation states that a steer can replace an earlier prompt while a turn is working.
- **Required isolation.** The diff adds no sizing, focus, display or status decisions. Existing `last_human`, draft/quiet gate updates, input bytes and ordering remain intact; the new parser affects attribution only. There is no new presentation or human-readable UI flow.
- **Tests inspected.** Registry round-trip/absence/public output; plain and split CSI-u Enter; bracketed paste; automatic input; held input ordering; typed send caller/no-caller and refusal; turn event copying; keyed enqueue/retry and restart persistence. These cover the main contract but miss the parser poisoning sequence above. None were run by this reviewer.

`git diff --check 131019c 532d044` passes. Cargo, generated-schema verification and runtime tests were not run because this assignment is static and Rust checks require Lane R. No GitHub comment, push or merge was made.

## Re-review at 55e874d — APPROVE (static)

Fetched `pull/3/head` again and confirmed `55e874d4649ae5552072fe211ae44d3dbceadb17`, directly on the previously reviewed `532d044`. The complete incremental diff touches only `crates/herdr-core/src/input.rs` and `crates/herdr-core/tests/m4.rs`.

**P2 closed.** In `Gate::submission` (`input.rs:95–120`), non-CSI Escape input is consumed as an Alt key rather than retained as an OSC/DCS string opener. `ESC ]` therefore leaves no carried state, and the following question plus CR reaches the human-submission branch. Only an incomplete CSI or lone Escape can be carried; the carry branch accepts fewer than `MAX_KEY_TAIL = 64` bytes, so it cannot retain an unbounded history. Overlong prefixes are discarded without discarding later input. Invalid control bytes in a CSI prefix cause parsing to resume after the prefix, allowing a following CR to be processed instead of swallowed.

Valid CSI-u and bracketed-paste markers still use the existing CSI parsing path. The X10 mouse special case still consumes its complete six-byte input without confusing a coordinate byte with Enter. Source attribution, busy/held delivery, input bytes, quiet/draft gating, persistence, public/schema output and turn copying are otherwise unchanged from the previous review.

The new Gate regression checks `Alt+]`, `Alt+P`, `Alt+_` and `Alt+O` followed by a normal human submission, confirms the Alt bytes are forwarded unchanged and leave no carried tail, exercises repeated overlong CSI fragments, and verifies recovery when a CR follows an incomplete CSI. The existing split CSI-u, split bracketed-paste, held-input and automatic-input tests remain in place. The m4 integration test now sends `Alt+]` before its human question and still checks matching human prompt metadata in get and the turn event. These tests were inspected, not executed.

Both `git diff --check 532d044 55e874d` and `git diff --check 131019c 55e874d` pass. No new static findings. **APPROVE**, with Cargo/schema/runtime validation still pending the separately scheduled Lane R run. No builds/tests, source edits, pushes, GitHub comments, merges, or service/restart actions were performed.
