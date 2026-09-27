# diffd development tasks. `just` lists them.

# Demo repositories live outside this one (a Cargo project inside our workspace would confuse cargo).
scratch := env_var_or_default("TMPDIR", "/tmp") / "diffd-demo"

default:
    @just --list

# Install web dependencies.
setup:
    npm --prefix web ci

# Build the web page bundle (web/dist/index.html).
web:
    npm --prefix web run build

# Build the release binary with the page baked in.
build: web
    cargo build --release -p diffd
    @echo "built target/release/diffd"

# Run the server from source (rebuilds the page first).
dev: web
    cargo run -p diffd -- serve

# The web page with hot reload, proxying the API to a running `just dev`.
dev-web:
    npm --prefix web run dev

# Every check CI runs.
check: lint test

lint:
    cargo fmt --all --check
    SQLX_OFFLINE=true cargo clippy --workspace --all-targets -- -D warnings
    npm --prefix web run lint
    npm --prefix web run typecheck

test:
    SQLX_OFFLINE=true cargo test --workspace
    npm --prefix web test

# Regenerate the TypeScript protocol types from the Rust model.
types:
    cargo test -p diffd-core export

# Refresh the compile-time checked query data in .sqlx after changing SQL.
sqlx:
    mkdir -p target
    cargo sqlx database create
    cargo sqlx migrate run --source crates/diffd-server/migrations
    cargo sqlx prepare --workspace

# Make a demo repository with a multi-language change and share it with a
# running server (`just dev`); prints the link.
demo port="3433":
    rm -rf {{scratch}} && python3 scripts/demo-repo.py {{scratch}}
    python3 scripts/demo-share.py {{scratch}} {{port}}

# The end-to-end run: Playwright plays the user, an MCP client plays the agent.
# It stops and restarts the server once to check that offline comments get through.
e2e port="3433": build
    #!/usr/bin/env sh
    set -eu
    rm -rf {{scratch}} target/e2e.db* && python3 scripts/demo-repo.py {{scratch}} >/dev/null
    start='target/release/diffd --port {{port}} --db target/e2e.db >> target/e2e.log 2>&1 & echo $! > target/e2e.pid; sleep 1'
    stop='kill $(cat target/e2e.pid)'
    sh -c "$start"
    trap "sh -c '$stop' || true" EXIT
    url=$(python3 scripts/demo-share.py {{scratch}} {{port}})
    DIFFD_E2E_STOP="$stop" DIFFD_E2E_START="$start" node web/e2e/full.mjs "$url" {{scratch}} target/e2e-shots

# A review with a real agent: Claude Code does a small task in a clone of
# `requests` and talks it through with a scripted reviewer. Uses real model calls.
e2e-agent port="3433": build
    #!/usr/bin/env sh
    set -eu
    repo={{scratch}}-agent
    rm -rf "$repo" && git clone -q https://github.com/psf/requests "$repo"
    git -C "$repo" config user.email dev@example.com && git -C "$repo" config user.name Dev
    target/release/diffd --port {{port}} --db target/e2e-agent.db >> target/e2e-agent.log 2>&1 & echo $! > target/e2e-agent.pid
    trap 'kill $(cat target/e2e-agent.pid) || true' EXIT
    sleep 1
    node web/e2e/agent.mjs "$repo" {{port}} target/e2e-agent-shots

# Check reviews of real repositories against git: `just verify ~/src/ripgrep 13.0.0 14.0.0`.
verify repo from to="" port="3433":
    python3 scripts/verify-review.py {{repo}} {{from}} {{to}} --port {{port}}
