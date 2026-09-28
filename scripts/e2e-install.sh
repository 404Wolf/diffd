#!/usr/bin/env bash
# End to end: `diffd install` on a real machine (Linux or macOS), for the
# current user: the binary, the login service (when there's a systemd user
# session or launchd), and the Codex and Claude Code plugins; then an upgrade
# and `diffd uninstall`, which must leave nothing behind.
#
#   scripts/e2e-install.sh [path/to/diffd]    # default: target/release/diffd
#
# It changes your real home directory: run it in CI or a throwaway account.
# Needs `codex` on PATH (npm install -g @openai/codex) and curl.
set -euo pipefail

diffd=${1:-target/release/diffd}
port=3433
bin=${XDG_BIN_HOME:-$HOME/.local/bin}/diffd
claude_plugin=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/diffd

fail() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }
up() { curl -fsS -o /dev/null "http://localhost:$port/"; }
wait_up() { for _ in $(seq 60); do up && return 0; sleep 0.5; done; return 1; }
codex_status() { codex plugin list 2>/dev/null | awk '$1 == "diffd@diffd" { $1 = ""; print }'; }

case $(uname -s) in
  Darwin) service=launchd ;;
  Linux) if systemctl --user show-environment >/dev/null 2>&1; then service=systemd; else service=none; fi ;;
  *) service=none ;;
esac
echo "service manager: $service"

preview=$("$diffd" install --print --agents codex,claude)
[[ $preview == *"nothing is changed"* ]] || fail "--print didn't preview: $preview"
[ -e "$bin" ] && fail "--print changed something: $bin exists"
ok "--print changes nothing"

"$diffd" install --agents codex,claude
[ -x "$bin" ] || fail "no binary at $bin"
ok "the binary is at $bin"

case $service in
  launchd)
    launchctl print "gui/$(id -u)/dev.diffd" >/dev/null || fail "no launchd agent dev.diffd"
    wait_up || fail "diffd isn't answering on port $port"
    ok "the launchd agent runs diffd" ;;
  systemd)
    systemctl --user is-active --quiet diffd.service || fail "the systemd unit isn't active"
    wait_up || fail "diffd isn't answering on port $port"
    ok "the systemd user unit runs diffd" ;;
  none) ok "no service manager here: skipped the service" ;;
esac

[ -f "$claude_plugin/.claude-plugin/plugin.json" ] || fail "no Claude Code plugin at $claude_plugin"
grep -q "$bin hook claude" "$claude_plugin/hooks/hooks.json" || fail "the Claude hooks don't call $bin"
ok "Claude Code plugin in $claude_plugin"
[[ $(codex_status) == *"installed, enabled"* ]] || fail "Codex doesn't list diffd@diffd as installed: $(codex plugin list 2>&1)"
ok "Codex has diffd@diffd installed and enabled"

# Again: an upgrade, which must still work (and keep the service running).
"$bin" install --agents codex,claude >/dev/null
[[ $(codex_status) == *"installed, enabled"* ]] || fail "Codex lost the plugin on reinstall"
[ "$service" = none ] || wait_up || fail "diffd isn't answering after a reinstall"
ok "installing again upgrades in place"

"$bin" uninstall
[ -e "$bin" ] && fail "uninstall left $bin"
[ -e "$claude_plugin" ] && fail "uninstall left $claude_plugin"
[[ $(codex_status) == *installed* ]] && fail "uninstall left the Codex plugin installed"
if [ "$service" != none ]; then
  sleep 2
  up && fail "diffd still answers after uninstall"
fi
[ "$service" = launchd ] && launchctl print "gui/$(id -u)/dev.diffd" >/dev/null 2>&1 && fail "the launchd agent is still loaded"
[ -e "${XDG_DATA_HOME:-$HOME/.local/share}/diffd/install.json" ] && fail "uninstall left its manifest"
ok "uninstall removes everything it installed"
echo "diffd install works."
