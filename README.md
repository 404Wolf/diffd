# diffd

A live code review of your agent's changes, in your browser.

Your agent (Claude Code, Codex, or anything that speaks MCP) shares a diff
and gives you a link. You
read it in a fast, vim-driven, difftastic-powered split view, comment on
lines like on a pull request, and the agent answers inline while it keeps
working. The diff updates as the code changes. There's no "submit review":
the agent hears each comment once you pause.

![A review in diffd: the file tree, a split diff with a comment thread, and the activity panel](docs/screenshot.png)

- **Structural diffs** from [difftastic](https://difftastic.wilfred.me.uk/),
  with a plain line diff when a language isn't supported. Highlighting is
  done on the server with tree-sitter.
- **Talk about the code where it is.** Select lines, comment, and get a reply
  in the thread. A chat box covers everything else, and the agent can point
  you at code (it asks first; your scroll never jumps).
- **Agent-made structure.** Notes on tricky code, test code marked along the
  side, and uninteresting hunks folded behind a one-line summary. Lockfiles
  and generated code (`.sqlx`, `@generated`, minified bundles) start folded
  by themselves. The agent can group the files into related changes ("The
  API", "Database") to read one group at a time, and label them (`frontend`)
  so you can hide tests, generated code or a whole side of the stack at once.
- **Walk the history.** A review that spans commits can be read one commit
  at a time, or across any run of them.
- **Beyond the diff.** Open any file in the repository, comment on it, or
  let the agent show it to you.
- **Language servers.** Go to definition (`gd`), type definition (`gt`),
  hover docs (`K`) and red/yellow squiggles, for Rust, TypeScript, Python,
  Go, Nix, YAML or anything you configure.
- **Keyboard first**, mostly Zed's vim bindings: hunks, files, symbols, a
  jump list, marks, text objects, splits. Browser Ctrl+F works and finds
  folded lines too.
- **Built for big diffs** (100k lines) and flaky connections. Comments
  written offline are sent on reconnect, from any tab.

## Install

With Nix:

```sh
nix run github:404Wolf/diffd            # or: nix profile install github:404Wolf/diffd
```

From source, with Rust (1.85+), Node 22 and [just](https://just.systems):

```sh
just setup build        # target/release/diffd, with the page built in
```

diffd needs `git`. It uses `difft` (difftastic) when it's on your PATH, and
any language servers you have installed.

## Use it

```sh
diffd                   # start the server (http://localhost:3433)
diffd setup claude      # register it with Claude Code (once)
diffd setup codex       # or with Codex (once; then trust its hooks when Codex asks)
```

Then ask the agent to show you its changes ("share your changes with
diffd"). It calls `share_diff` and gives you a link. Leave comments; the
agent answers in the threads. Press `?` on the page for every key.

**The agent hears you even when it's idle.** An agent in its terminal ends
its turn and waits for you, so it can't be listening for comments.
`diffd setup` also installs hooks that wait in the background (whenever a
session starts, you write to the agent, or a turn ends) and wake the agent
when you comment: Claude Code through an `asyncRewake` hook, Codex by
queueing a message into the session with `codex queue`. You can keep
talking to the agent in its terminal at the same time; feedback that
arrives mid-turn is picked up with that turn or right after it. For any
other agent, `diffd hook wait` blocks until there's feedback on a review of
the current directory, then prints what to do and exits 2
(`--json` for scripts). `diffd setup claude --print` shows everything setup
would do.

### The MCP tools

| Tool | What it's for |
| --- | --- |
| `share_diff` | Start a review: `from`/`to` revisions (default: the working tree), a title and summary, notes on tricky code, files to collapse, test regions and folds, groups of related changes and labels. |
| `wait_for_feedback` | Wait (up to 50 s) for your comments and chat messages, batched once you pause. |
| `reply` | Answer in a thread, where the code is. |
| `say` | Answer in the chat. |
| `annotate` | Add notes, test marks, folds, groups or labels later. |
| `show` | Point you at some code, in the diff or anywhere in the repository. |
| `refresh` | Rebuild the review now (it also follows file changes by itself). |
| `get_review` | Everything about a review, for picking a conversation back up. |

### Keys you'll use most

| Keys | |
| --- | --- |
| `j` `k`, `]c` `[c`, `]f` `[f` | lines, hunks, files |
| `gcc`, `V` … `gc` | comment on a line, on selected lines |
| `r`, `space i` | reply to a thread, ask the agent anything |
| `gd`, `gt`, `K`, `grr` | definition, type definition, docs, references |
| `w` `b` | step through symbols on the line |
| `ctrl-o` `ctrl-i` | jump back and forward |
| `ge`, `zR` `zM` | expand folded lines, everything, back to hunks |
| `g enter`, `g space` | the plain file here, or in a split |
| `ctrl-\`, `ctrl-esc`, `ctrl-h` `ctrl-l` | split, close a split, move between splits |
| `]r` `[r`, `space c` | walk the commits |
| `ma`, `'a` | set a mark, jump to it |
| `vip`, `vaf`, `vi{`, `vat` | select a paragraph, function, block, tag |
| `]a`, `]n`, `]t` | the agent's notes, unread activity, threads |
| `space f`, `/`, `?` | go to file, search every line, all keys |

## Configure

`diffd config` prints the default configuration, with comments. Save the parts
you want to change as `~/.config/diffd/config.toml` (or pass `--config`); it's
merged over the defaults.

```toml
[server]
port = 3433

# Change one setting of a built-in language server...
[lsp.servers.rust-analyzer]
args = ["--log-file", "/tmp/ra.log"]

# ...turn one off...
[lsp.servers.yaml]
enabled = false

# ...or add another.
[lsp.servers.lua]
command = "lua-language-server"
languages = { lua = ["lua"] }
```

Language servers start in the reviewed repository (at the nearest project
root, e.g. the folder with `Cargo.toml`) when a review of the working tree
is open, several at once for mixed diffs, and stop when idle.

### Share it with your other machines

diffd only answers requests for `localhost` unless you tell it otherwise,
because review comments become input for your agent. To read reviews from
another machine on a network you trust (a tailnet, say), list the names you'll
open it by, and set the link agents hand out:

```toml
[server]
bind = "0.0.0.0"   # or keep 127.0.0.1 behind a proxy such as `tailscale serve`
allowed_hosts = ["mybox", "mybox.tailnet.ts.net"]
public_url = "http://mybox:3433"
```

Requests for any other host are refused, pages only accept writes from their
own origin, and MCP (`/mcp`) always answers localhost only: agents run on the
machine with the code. The same settings exist as `--bind`,
`--allowed-hosts` and `--public-url`, or `DIFFD_BIND`, `DIFFD_ALLOWED_HOSTS`
(comma-separated) and `DIFFD_PUBLIC_URL`.

## Run it as a service

The flake has modules for NixOS and home-manager, both as `services.diffd`.

**home-manager** runs diffd as your user, which is usually what you want: it
reads your checkouts and starts language servers in them. Reviews go to
`~/.local/share/diffd/diffd.db`, the service gets your profile's `PATH`, and it
registers `http://localhost:<port>/mcp` in `programs.mcp.servers.diffd`, so
Claude Code, Codex and OpenCode pick it up when their home-manager MCP
integration is on (`services.diffd.mcp.enable = false` to skip that).

```nix
# flake.nix: inputs.diffd.url = "github:404Wolf/diffd";
{
  imports = [ inputs.diffd.homeManagerModules.default ];
  services.diffd = {
    enable = true;
    # Optional: share it on your tailnet.
    allowedHosts = [ "mybox.tailnet.ts.net" ];
    publicUrl = "https://mybox.tailnet.ts.net:3433";
  };
}
```

It also installs diffd as a **Claude Code plugin and a Codex plugin**
(`programs.claude-code.plugins.diffd`, `programs.codex.plugins`) when those
programs are enabled: the hooks that wake an idle agent when you leave
feedback, the same ones `diffd setup` writes into your settings, but packaged,
so they come and go with the plugin and never touch your own hooks. Turn
either off with `services.diffd.agents.claude.enable = false` (or `codex`).
The plugins carry the MCP server too when `mcp.enable` is off. Without
home-manager, use the flake's `claude-plugin` and `codex-plugin` packages, e.g.
`claude --plugin-dir $(nix build --print-out-paths github:404Wolf/diffd#claude-plugin)`.

Language servers start through `direnv exec .` in the reviewed project when
`programs.direnv` is enabled (`services.diffd.lsp.direnv`), so they come from
the project's devshell, the same toolchain the agent uses there.

On a server you log out of, run `loginctl enable-linger $USER` (or set
`users.users.<name>.linger = true` on NixOS) so user services keep running.

**NixOS** runs a system service with reviews in `/var/lib/diffd`. It runs as
a `diffd` user by default; set `user` to an account that can read the
repositories you review (usually your own).

```nix
{
  imports = [ inputs.diffd.nixosModules.default ];
  services.diffd = {
    enable = true;
    user = "alice";
    bind = "0.0.0.0";
    allowedHosts = [ "mybox" ];
    publicUrl = "http://mybox:3433";
    openFirewall = true;
    extraPackages = [ pkgs.rust-analyzer pkgs.nil ];
  };
}
```

Both take `port`, `bind`, `allowedHosts`, `publicUrl`, `extraPackages` (put
on the service's `PATH`, e.g. language servers) and `settings` (merged into
the config file). `nix flake check` runs a NixOS VM test of the module.

## How it's built

One Rust binary with the page baked in:

- `crates/diffd-core`: the model and wire protocol (exported to TypeScript
  with ts-rs), highlighting, symbols, difftastic parsing, the fallback line
  diff, anchoring.
- `crates/diffd-server`: use cases (`app/`) over ports (`ports.rs`) with
  adapters for git, difftastic, SQLite (sqlx), language servers, the file
  watcher, and the HTTP / WebSocket / MCP front doors.
- `crates/diffd`: the command line.
- `web/`: the page (SolidJS, Tailwind, Vite), built into one HTML file.
- `vendor/tungstenite`: Signal's tungstenite fork, for a compressed WebSocket.

[`docs/DESIGN.md`](docs/DESIGN.md) explains the design.

The server listens on localhost by default, and refuses requests with a
foreign `Host` (DNS rebinding) or `Origin`; `allowed_hosts` adds names for
the pages, never for MCP.

## Develop

```sh
just                    # list recipes
just dev                # the server from source (rebuilds the page first)
just dev-web            # the page with hot reload, against `just dev`
just demo               # make a demo repository and share it with the running server
just check              # formatting, lints, types, unit and integration tests
just e2e                # the whole thing in a browser, with an MCP client as the agent
just e2e-wake codex     # a real Codex TUI hears feedback while idle (stand-in model, no network)
just e2e-wake claude    # the same with a real Claude Code TUI (signed in)
just e2e-agent          # a real Claude Code does a task and reviews it with you
```

`just e2e` drives a real review end to end: Playwright plays you, a small
MCP client plays the agent, and it checks every surface (comments, chat,
splits, commits, language servers in six languages, offline and multi-tab,
reloads). SQL queries are checked at compile time; after changing one, run
`just sqlx`. After changing a type in `diffd-core`, run `just types`.

## License

MIT
