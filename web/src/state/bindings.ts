/**
 * Every key binding, with where it shows up in the help screen. Mostly Zed's
 * vim keymap; `tab` replaces `ctrl-w h/l` because browsers reserve `ctrl-w`.
 */
import type { Binding } from "../lib/keymap";
import type { TextObject } from "../lib/textObjects";
import type { Commands } from "./commands";
import type { View } from "./view";

export interface Ctx {
  readonly cmd: Commands;
  readonly view: View;
}

const MARK_NAMES = [..."abcdefghijklmnopqrstuvwxyz"];

/** Keys after `i` / `a` in visual mode, and the object each selects (vim's aliases included). */
const TEXT_OBJECTS: readonly (readonly [string, TextObject])[] = [
  ["p", "paragraph"],
  ["f", "function"],
  ["c", "class"],
  ["{", "brace"],
  ["}", "brace"],
  ["B", "brace"],
  ["(", "paren"],
  [")", "paren"],
  ["b", "paren"],
  ["[", "bracket"],
  ["]", "bracket"],
  ["t", "tag"],
  ["h", "hunk"],
];

const diffModes = ["normal", "visual", "symbol"] as const;

export const BINDINGS: readonly Binding<Ctx>[] = [
  // Move
  { keys: "j", run: ({ cmd }, n) => cmd.move(n), help: ["Move", "Down / up a line (5j works)"] },
  { keys: "k", run: ({ cmd }, n) => cmd.move(-n) },
  { keys: "down", run: ({ cmd }, n) => cmd.move(n) },
  { keys: "up", run: ({ cmd }, n) => cmd.move(-n) },
  { keys: "g g", run: ({ cmd }) => cmd.edge(false), help: ["Move", "First / last line"] },
  { keys: "G", run: ({ cmd }) => cmd.edge(true) },
  { keys: "ctrl-d", run: ({ cmd }) => cmd.move(cmd.halfPage()), help: ["Move", "Half a page down / up"] },
  { keys: "ctrl-u", run: ({ cmd }) => cmd.move(-cmd.halfPage()) },
  {
    keys: "tab",
    modes: diffModes,
    run: ({ cmd }) => cmd.switchSide(),
    help: ["Move", "Switch old / new side"],
  },
  { keys: "ctrl-o", run: ({ cmd }) => cmd.jumpBack(), help: ["Move", "Jump back / forward"] },
  { keys: "ctrl-i", run: ({ cmd }) => cmd.jumpForward() },
  // Symbols
  { keys: "w", run: ({ cmd }) => cmd.stepWord(1), help: ["Symbols", "Next / previous symbol on the line"] },
  { keys: "b", run: ({ cmd }) => cmd.stepWord(-1) },
  {
    keys: "g d",
    run: ({ cmd }) => void cmd.gotoDefinition(),
    help: ["Symbols", "Go to definition (or ctrl-click)"],
  },
  { keys: "ctrl-]", run: ({ cmd }) => void cmd.gotoDefinition() },
  {
    keys: "g t",
    run: ({ cmd }) => void cmd.typeDefinition(),
    help: ["Symbols", "Go to the type's definition (language server)"],
  },
  {
    keys: "K",
    run: ({ cmd }) => void cmd.hoverAtCursor(),
    help: ["Symbols", "Docs and errors here (or hover)"],
  },
  { keys: "enter", modes: ["symbol"], run: ({ cmd }) => void cmd.gotoDefinition() },
  { keys: "g r r", run: ({ cmd }) => cmd.references(), help: ["Symbols", "Find references"] },
  {
    keys: "g s",
    run: ({ cmd }) => cmd.outline(false),
    help: ["Symbols", "Symbols in this file / in the diff"],
  },
  { keys: "g S", run: ({ cmd }) => cmd.outline(true) },
  // Review
  { keys: "] c", run: ({ cmd }) => cmd.hunk(1), help: ["Review", "Next / previous hunk"] },
  { keys: "[ c", run: ({ cmd }) => cmd.hunk(-1) },
  {
    keys: "] f",
    run: ({ cmd }) => cmd.fileJump(1),
    help: ["Review", "Next / previous file, skipping collapsed"],
  },
  { keys: "[ f", run: ({ cmd }) => cmd.fileJump(-1) },
  { keys: "] a", run: ({ cmd }) => cmd.noteJump(1), help: ["Review", "Claude's notes, in order"] },
  { keys: "[ a", run: ({ cmd }) => cmd.noteJump(-1) },
  { keys: "] t", run: ({ cmd }) => cmd.threadJump(1), help: ["Review", "Next / previous thread"] },
  { keys: "[ t", run: ({ cmd }) => cmd.threadJump(-1) },
  { keys: "] n", run: ({ cmd }) => cmd.unreadNext(), help: ["Review", "Next unread activity"] },
  {
    keys: "] r",
    run: ({ cmd }) => cmd.stepCommit(1),
    help: ["Review", "Next / previous commit, one at a time"],
  },
  { keys: "[ r", run: ({ cmd }) => cmd.stepCommit(-1) },
  { keys: "space c", run: ({ cmd }) => cmd.commitPicker(), help: ["Review", "Pick a commit to look at"] },
  {
    keys: "space v",
    run: ({ cmd }) => cmd.markViewedAndNext(),
    help: ["Review", "Mark viewed, go to the next file"],
  },
  // Context
  {
    keys: "g e",
    modes: diffModes,
    run: ({ cmd }) => cmd.expandNearest(),
    help: ["Context", "Expand the nearest folded lines"],
  },
  { keys: "shift-enter", modes: diffModes, run: ({ cmd }) => cmd.expandNearest() },
  {
    keys: "ctrl-enter",
    modes: diffModes,
    run: ({ cmd }) => cmd.expandAround(),
    help: ["Context", "Show more lines above and below this hunk"],
  },
  {
    keys: "ctrl-shift-enter",
    modes: diffModes,
    run: ({ cmd }) => cmd.contractAround(),
    help: ["Context", "Show fewer lines above and below this hunk"],
  },
  {
    keys: "z a",
    run: ({ cmd, view }) => {
      const f = view.cursor()?.file;
      if (f !== undefined) cmd.toggleFold(f);
    },
    help: ["Context", "Collapse / expand this file"],
  },
  { keys: "z R", run: ({ cmd }) => cmd.expandAll(), help: ["Context", "Show everything / back to hunks"] },
  { keys: "z M", run: ({ cmd }) => cmd.collapseAll() },
  { keys: "g enter", run: ({ cmd }) => cmd.fileView(), help: ["Context", "The plain file here, no diff"] },
  {
    keys: "g space",
    run: ({ cmd }) => cmd.fileInSplit(),
    help: ["Context", "The plain file here, in a split"],
  },
  // Talk
  {
    keys: "g c c",
    modes: ["normal", "symbol", "file"],
    run: ({ cmd }) => cmd.comment(),
    help: ["Talk", "Comment on this line"],
  },
  {
    keys: "V",
    modes: [...diffModes, "file"],
    run: ({ cmd }) => cmd.startVisual(),
    help: ["Talk", "Select lines (then gc to comment)"],
  },
  { keys: "v", modes: [...diffModes, "file"], run: ({ cmd }) => cmd.startVisual() },
  { keys: "g c", modes: ["visual"], run: ({ cmd }) => cmd.comment() },
  { keys: "c", modes: ["visual"], run: ({ cmd }) => cmd.comment() },
  {
    keys: "r",
    run: ({ cmd, view }) => {
      const t = cmd.nearThread();
      t ? cmd.replyTo(t) : view.say("No thread to reply to");
    },
    help: ["Talk", "Reply to the next thread"],
  },
  {
    keys: "space i",
    run: ({ cmd }) => cmd.focusChat(),
    help: ["Talk", "Ask Claude anything"],
  },
  // Text objects, in visual mode: i = inside, a = around (vip, vaf, vi{, …).
  ...TEXT_OBJECTS.flatMap(([key, object], n): Binding<Ctx>[] =>
    (["i", "a"] as const).map((ia, k) => ({
      keys: `${ia} ${key}`,
      modes: ["visual"],
      run: ({ cmd }) => cmd.selectObject(object, ia === "a"),
      ...(n === 0 && k === 0
        ? {
            help: [
              "Talk",
              "Select a text object: ip ap, if af, ic ac, i{ a{, i( a(, i[ a[, it at, ih ah",
            ] as const,
          }
        : {}),
    })),
  ),
  // Marks: m{a-z} sets one at the cursor, ' or ` jumps back to it.
  ...MARK_NAMES.flatMap((name, i): Binding<Ctx>[] => [
    {
      keys: `m ${name}`,
      run: ({ cmd }) => cmd.setMark(name),
      ...(i === 0 ? { help: ["Marks", "Set mark a–z at the cursor (ma)"] as const } : {}),
    },
    {
      keys: `' ${name}`,
      run: ({ cmd }) => cmd.jumpToMark(name),
      ...(i === 0 ? { help: ["Marks", "Jump to a mark ('a or `a)"] as const } : {}),
    },
    { keys: `\` ${name}`, run: ({ cmd }) => cmd.jumpToMark(name) },
  ]),
  // Splits
  { keys: "ctrl-\\", run: ({ cmd }) => cmd.splitPane(), help: ["Splits", "Split to the right"] },
  // Also space s: ctrl-\ is hard to type on AltGr layouts.
  { keys: "space s", run: ({ cmd }) => cmd.splitPane() },
  { keys: "ctrl-esc", run: ({ cmd }) => cmd.closePane(), help: ["Splits", "Close this split"] },
  // Also space x: some systems take ctrl-esc (Windows' Start menu).
  { keys: "space x", run: ({ cmd }) => cmd.closePane() },
  {
    keys: "ctrl-h",
    run: ({ cmd }) => cmd.focusSplit(-1),
    help: ["Splits", "Focus the split to the left / right"],
  },
  { keys: "ctrl-l", run: ({ cmd }) => cmd.focusSplit(1) },
  // Panels
  { keys: "space e", run: ({ cmd }) => cmd.toggleDrawer("left"), help: ["Panels", "Files drawer"] },
  {
    keys: "space t t",
    run: ({ view }) => view.setTreeMode(view.treeMode() === "diff" ? "project" : "diff"),
    help: ["Panels", "Files: the diff's or the whole project's"],
  },
  { keys: "space t c", run: ({ view }) => view.setAllFolders(false), help: ["Panels", "Collapse all folders"] },
  { keys: "space t o", run: ({ view }) => view.setAllFolders(true), help: ["Panels", "Expand all folders"] },
  { keys: "space n", run: ({ cmd }) => cmd.toggleDrawer("right"), help: ["Panels", "Activity drawer"] },
  { keys: "space f", run: ({ cmd }) => cmd.filePicker(), help: ["Panels", "Go to file"] },
  { keys: "ctrl-p", run: ({ cmd }) => cmd.filePicker() },
  { keys: "/", run: ({ cmd }) => cmd.search(), help: ["Panels", "Search every line"] },
  { keys: "?", run: ({ view }) => view.setHelp(true), help: ["Panels", "This list"] },
  { keys: "esc", run: ({ cmd }) => cmd.escapeAll() },
];

/** Keys shown next to each help entry: its own keys plus unlabelled siblings that follow it. */
export function helpEntries(): { group: string; label: string; keys: string[] }[] {
  const out: { group: string; label: string; keys: string[] }[] = [];
  for (const b of BINDINGS) {
    const last = out.at(-1);
    if (b.help) out.push({ group: b.help[0], label: b.help[1], keys: [b.keys] });
    else if (
      last &&
      b.keys !== "esc" &&
      !["down", "up", "ctrl-p", "ctrl-]", "shift-enter", "v", "c", "enter"].includes(b.keys) &&
      !/^[m'`ia] /.test(b.keys)
    )
      last.keys.push(b.keys);
  }
  return out;
}
