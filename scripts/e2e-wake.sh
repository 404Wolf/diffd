#!/usr/bin/env bash
# End to end: an agent in its interactive terminal UI hears review feedback
# without polling, and its user can keep talking to it meanwhile.
#
#   scripts/e2e-wake.sh codex    # real Codex TUI, on a scripted stand-in model (no network, no key)
#   scripts/e2e-wake.sh claude   # real Claude Code TUI, on a real model (must be signed in)
#
# Each run: `diffd setup <agent>` (the plugin) into a throwaway config, a review of a
# scratch repository, the agent's TUI in tmux, then
#   1. a comment while the user has the agent busy with something else, and
#   2. a chat message while the agent is idle;
# both must be answered on the review. Needs tmux, node, git, and the agent's CLI.
set -euo pipefail

agent=${1:?usage: e2e-wake.sh codex|claude}
here=$(cd "$(dirname "$0")/.." && pwd)
bin="$here/target/release"
port=${DIFFD_E2E_PORT:-3530}
mock_port=${DIFFD_E2E_MOCK_PORT:-18090}
# Codex refuses homes under /tmp, and its daemon socket path must stay short.
work=$(mktemp -d "$HOME/.diffd-e2e-wake.XXXX")
# `diffd setup` records what it installed under XDG_DATA_HOME: keep that in the throwaway too.
export XDG_DATA_HOME="$work/data"
session="diffd-wake-$$"
pids=()
cleanup() {
  tmux kill-session -t "$session" 2>/dev/null || true
  [ "$agent" = codex ] && CODEX_HOME="$work/home" codex app-server daemon stop >/dev/null 2>&1 || true
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  rm -rf "$work" 2>/dev/null || true
}
trap cleanup EXIT
fail() {
  echo "✗ $*"
  echo "--- screen:"; tmux capture-pane -pt "$session" 2>/dev/null | grep -v '^\s*$' | tail -30 || true
  exit 1
}
screen() { tmux capture-pane -pt "$session" | grep -v '^\s*$'; }
type_line() { tmux send-keys -t "$session" -l "$1"; sleep 0.5; tmux send-keys -t "$session" Enter; }
until_screen() { # until_screen <regex> <seconds>
  for _ in $(seq 1 "$2"); do screen | grep -Eq "$1" && return 0; sleep 1; done
  return 1
}

# A repository with an uncommitted change.
repo="$work/repo"
mkdir -p "$repo" && cd "$repo"
git init -q && printf 'def add(a, b):\n    return a + b\n' > calc.py && git add -A
git -c user.email=e2e@example.com -c user.name=e2e commit -qm init
printf 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n' > calc.py

"$bin/diffd" --port "$port" --db "$work/diffd.db" > "$work/diffd.log" 2>&1 & pids+=($!)
sleep 1.5
export PATH="$bin:$PATH"

case "$agent" in
  codex)
    export CODEX_HOME="$work/home"
    mkdir -p "$CODEX_HOME"
    cat > "$CODEX_HOME/config.toml" <<EOF
model = "mock-model"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.mock]
name = "Mock"
base_url = "http://127.0.0.1:$mock_port/v1"
wire_api = "responses"

[projects."$repo"]
trust_level = "trusted"
EOF
    python3 "$here/scripts/mock-responses.py" "$mock_port" "$work/mock.jsonl" & pids+=($!)
    diffd setup codex --port "$port" >/dev/null
    # The agent shares (the stand-in model doesn't write code; share as it would).
    DIFFD_MCP="http://localhost:$port/mcp?agent=codex" python3 "$here/scripts/mcp_client.py" share_diff \
      "{\"repo_path\": \"$repo\", \"from\": \"HEAD\", \"title\": \"e2e wake\"}" > /dev/null
    # tmux sessions get the tmux server's environment, not ours: pass it on.
    tmux new-session -d -s "$session" -x 220 -y 50 "cd '$repo' && env CODEX_HOME='$CODEX_HOME' PATH='$PATH' codex; sleep 600"
    # Codex runs new hooks only once the user trusts them: it asks at startup
    # (older versions: through /hooks).
    until_screen 'Ask Codex|Trust all and continue' 60 || fail "Codex didn't start"
    if screen | grep -q 'Trust all and continue'; then
      tmux send-keys -t "$session" Down; sleep 0.5; tmux send-keys -t "$session" Enter
      until_screen 'Ask Codex' 30 || fail "Codex didn't start after trusting the hooks"
    else
      tmux send-keys -t "$session" -l "/hooks"; sleep 2
      for _ in 1 2 3; do screen | grep -q 'trust all' && break; tmux send-keys -t "$session" Enter; sleep 2; done
      screen | grep -q 'need review' || fail "Codex's /hooks didn't list diffd's hooks for review"
      tmux send-keys -t "$session" t; sleep 2
      screen | grep -q 'need review' && fail "the hooks weren't trusted"
      # Back out of the menu (it can be a level or two deep) to the composer.
      for _ in 1 2 3 4; do
        tmux send-keys -t "$session" Escape; sleep 1
        screen | grep -q 'hooks' || break
      done
    fi
    # The hooks run from the next event on: a first message arms them.
    type_line "hello"
    until_screen 'mock: hello' 30 || fail "Codex didn't answer through the stand-in model"
    busy="please take your time with this one"
    ;;
  claude)
    export CLAUDE_CONFIG_DIR="$work/claude"
    mkdir -p "$CLAUDE_CONFIG_DIR"
    # A fresh config would start with onboarding and a folder trust prompt.
    python3 - "$CLAUDE_CONFIG_DIR/.claude.json" "$repo" <<'EOF'
import json, sys
json.dump({"hasCompletedOnboarding": True, "theme": "dark",
           "projects": {sys.argv[2]: {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}}},
          open(sys.argv[1], "w"))
EOF
    diffd setup claude --port "$port" >/dev/null
    tmux new-session -d -s "$session" -x 200 -y 50 \
      "cd '$repo' && env CLAUDE_CONFIG_DIR='$CLAUDE_CONFIG_DIR' PATH='$PATH' claude --allowedTools mcp__plugin_diffd_diffd Edit Write; sleep 600"
    until_screen '❯' 60 || fail "Claude Code didn't start"
    sleep 3
    type_line "Share the uncommitted changes in this repo for review with diffd's share_diff (from HEAD, title 'e2e wake'), then stop."
    until_screen "localhost:$port/r/" 180 || fail "Claude didn't share a review"
    busy="Write a two-line poem about subtraction into poem.txt."
    ;;
  *) echo "usage: e2e-wake.sh codex|claude"; exit 2 ;;
esac

review=$(curl -s "localhost:$port/api/reviews" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['review']['id'])")
echo "review $review"
named=$(curl -s "localhost:$port/api/reviews/$review" | python3 -c "import json,sys; print(json.load(sys.stdin)['layout']['agent'])")
want=$([ "$agent" = codex ] && echo Codex || echo Claude)
[ "$named" = "$want" ] || fail "the review names the agent '$named', not $want"
echo "✓ the page calls the agent $want"
# Idle, with a hook waiting.
until_screen 'esc to interrupt' 1 && sleep 15
pgrep -f "diffd hook --port $port $agent" > /dev/null || fail "no diffd hook is waiting after the turn"
echo "✓ a hook waits for feedback while the agent is idle"

# 1. The user keeps the agent busy in its terminal and comments on the review meanwhile.
type_line "$busy"
sleep 1
node "$here/scripts/as-user.mjs" "$port" "$review" --comment calc.py:5 "Should sub have a docstring?" --wait 240 \
  || fail "the comment made during a busy turn wasn't answered"
echo "✓ a comment made while the user talks to the agent is answered"

# 2. Idle again: a chat message wakes it.
for _ in $(seq 1 120); do screen | grep -q 'esc to interrupt' || break; sleep 1; done
sleep 3
node "$here/scripts/as-user.mjs" "$port" "$review" --chat "Thanks! Anything else worth changing?" --wait 240 \
  || fail "the idle agent wasn't woken by a chat message"
echo "✓ an idle agent is woken by a chat message"
echo "The $agent wake-up works."
