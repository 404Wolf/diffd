#!/usr/bin/env python3
"""Create a demo git repository with a realistic, multi-language change.

    scripts/demo-repo.py /tmp/diffd-demo

The base is committed on `main`. The change is on a `demo` branch: three
commits, then more left uncommitted in the working tree. A review `from: main`
shows all of it, lets you walk the commits one at a time, and follows further
edits live.
"""
import os
import subprocess
import sys
import textwrap
from pathlib import Path


def w(root: Path, path: str, text: str) -> None:
    p = root / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(text).lstrip("\n"))


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, stdout=subprocess.DEVNULL)


BASE = {
    # Files the change doesn't touch: context to browse, show and comment on.
    "src/clock.rs": """
        //! Time sources for limiters.

        use std::time::Instant;

        /// Something that tells the time, so tests can fake it.
        pub trait Clock {
            fn now(&self) -> Instant;
        }

        /// The real clock.
        pub struct SystemClock;

        impl Clock for SystemClock {
            fn now(&self) -> Instant {
                Instant::now()
            }
        }
    """,
    "web/src/format.ts": """
        /** "3s", "2m 5s": a short duration for badges. */
        export function formatSeconds(total: number): string {
          if (total < 60) return `${total}s`;
          const m = Math.floor(total / 60);
          const s = total % 60;
          return s === 0 ? `${m}m` : `${m}m ${s}s`;
        }
    """,
    "cmd/probe/flags.go": """
        package main

        import "flag"

        // Flags for the probe command.
        type Flags struct {
        	URL     string
        	Verbose bool
        }

        func parseFlags() Flags {
        	var f Flags
        	flag.StringVar(&f.URL, "url", "http://localhost:8080/quota", "quota endpoint")
        	flag.BoolVar(&f.Verbose, "v", false, "print every response")
        	flag.Parse()
        	return f
        }
    """,
    "tools/common.py": """
        \"\"\"Helpers shared by the log tools.\"\"\"


        def percent(part, whole):
            \"\"\"Part of whole as a percentage, 0 when whole is 0.\"\"\"
            return 0 if whole == 0 else round(100 * part / whole, 1)
    """,
    ".github/workflows/ci.yml": """
        name: ci
        on: [push, pull_request]
        jobs:
          test:
            runs-on: ubuntu-latest
            steps:
              - uses: actions/checkout@v4
              - run: cargo test
    """,
    "Cargo.toml": """
        [package]
        name = "ratelimit"
        version = "0.1.0"
        edition = "2021"

        [dependencies]
        tokio = { version = "1", features = ["time"] }
    """,
    "Cargo.lock": """
        [[package]]
        name = "ratelimit"
        version = "0.1.0"
        dependencies = [
         "tokio",
        ]

        [[package]]
        name = "tokio"
        version = "1.40.0"
        source = "registry+https://github.com/rust-lang/crates.io-index"
    """,
    "src/lib.rs": """
        //! A token-bucket rate limiter.

        use std::time::{Duration, Instant};

        pub mod bucket;

        /// Configuration for a limiter.
        pub struct Config {
            pub capacity: u32,
            pub refill_every: Duration,
        }

        impl Default for Config {
            fn default() -> Self {
                Config { capacity: 10, refill_every: Duration::from_millis(100) }
            }
        }

        pub struct Limiter {
            config: Config,
            tokens: u32,
            last_refill: Instant,
        }

        impl Limiter {
            pub fn new(config: Config) -> Self {
                let tokens = config.capacity;
                Limiter { config, tokens, last_refill: Instant::now() }
            }

            /// Take one token if available.
            pub fn try_acquire(&mut self) -> bool {
                self.refill(Instant::now());
                if self.tokens > 0 {
                    self.tokens -= 1;
                    true
                } else {
                    false
                }
            }

            fn refill(&mut self, now: Instant) {
                let elapsed = now.duration_since(self.last_refill);
                let new_tokens = (elapsed.as_millis() / self.config.refill_every.as_millis()) as u32;
                if new_tokens > 0 {
                    self.tokens = std::cmp::min(self.config.capacity, self.tokens + new_tokens);
                    self.last_refill = now;
                }
            }
        }
    """,
    "src/bucket.rs": """
        /// Helpers shared by limiters.
        pub fn clamp(value: u32, max: u32) -> u32 {
            if value > max { max } else { value }
        }
    """,
    "src/legacy.rs": """
        // Old fixed-window limiter, kept for reference.
        pub struct Window {
            pub count: u32,
            pub limit: u32,
        }

        impl Window {
            pub fn hit(&mut self) -> bool {
                self.count += 1;
                self.count <= self.limit
            }
        }
    """,
    "web/src/api.ts": """
        export interface Quota {
          remaining: number;
          resetAt: number;
        }

        export async function fetchQuota(user: string): Promise<Quota> {
          const res = await fetch(`/api/quota/${user}`);
          if (!res.ok) throw new Error("quota request failed");
          return res.json();
        }

        export function formatReset(quota: Quota, now: number): string {
          const seconds = Math.round((quota.resetAt - now) / 1000);
          return seconds + "s";
        }
    """,
    "web/src/QuotaBadge.tsx": """
        import { formatReset, type Quota } from "./api";

        export function QuotaBadge(props: { quota: Quota }) {
          return (
            <span class="badge">
              {props.quota.remaining} left, resets in {formatReset(props.quota, Date.now())}
            </span>
          );
        }
    """,
    "tools/report.py": """
        \"\"\"Summarise rate-limit logs.\"\"\"
        import json
        import sys


        def load(path):
            with open(path) as f:
                return [json.loads(line) for line in f]


        def summarise(events):
            denied = [e for e in events if not e["allowed"]]
            return {"total": len(events), "denied": len(denied)}


        if __name__ == "__main__":
            print(summarise(load(sys.argv[1])))
    """,
    "cmd/probe/main.go": """
        package main

        import (
        \t"fmt"
        \t"net/http"
        \t"os"
        )

        func main() {
        \tresp, err := http.Get(os.Args[1])
        \tif err != nil {
        \t\tfmt.Println("error:", err)
        \t\tos.Exit(1)
        \t}
        \tfmt.Println(resp.StatusCode)
        }
    """,
    "flake.nix": """
        {
          outputs = { self, nixpkgs }: {
            packages.x86_64-linux.default =
              nixpkgs.legacyPackages.x86_64-linux.hello;
          };
        }
    """,
    "README.md": """
        # ratelimit

        A token-bucket rate limiter.

        ## Usage

        Create a `Limiter` and call `try_acquire`.
    """,
    "db/schema.sql": """
        CREATE TABLE quotas (
            user_id TEXT PRIMARY KEY,
            remaining INTEGER NOT NULL
        );
    """,
    "web/src/badge.css": """
        .badge {
          padding: 2px 6px;
          border-radius: 4px;
          background: #eee;
        }
    """,
}

# A long file where only a few spots change, to exercise folding and context.
BIG = "\n".join(
    [
        "//! Generated-looking table of per-route limits.",
        "",
        "pub fn limit_for(route: &str) -> u32 {",
        "    match route {",
    ]
    + [f'        "/api/v1/resource{i}" => {10 + i % 7},' for i in range(260)]
    + ["        _ => 10,", "    }", "}", ""]
)

CHANGES = {
    # A real refactor: burst capacity, a wrapped constructor (difftastic shows
    # only the new tokens), a renamed method, a new error type.
    "src/lib.rs": """
        //! A token-bucket rate limiter with burst support.

        use std::time::{Duration, Instant};

        pub mod bucket;

        /// Configuration for a limiter.
        pub struct Config {
            pub capacity: u32,
            /// Extra tokens allowed in a short burst on top of `capacity`.
            pub burst: u32,
            pub refill_every: Duration,
        }

        impl Default for Config {
            fn default() -> Self {
                Config {
                    capacity: 10,
                    burst: 5,
                    refill_every: Duration::from_millis(100),
                }
            }
        }

        #[derive(Debug, PartialEq, Eq)]
        pub enum Denied {
            /// Try again after this long.
            RetryAfter(Duration),
        }

        pub struct Limiter {
            config: Config,
            tokens: u32,
            last_refill: Instant,
        }

        impl Limiter {
            pub fn new(config: Config) -> Self {
                let tokens = config.capacity + config.burst;
                Limiter { config, tokens, last_refill: Instant::now() }
            }

            /// Take one token, or say how long to wait for the next one.
            pub fn acquire(&mut self, now: Instant) -> Result<(), Denied> {
                self.refill(now);
                if self.tokens > 0 {
                    self.tokens -= 1;
                    Ok(())
                } else {
                    let since = now.duration_since(self.last_refill);
                    Err(Denied::RetryAfter(self.config.refill_every.saturating_sub(since)))
                }
            }

            fn refill(&mut self, now: Instant) {
                let elapsed = now.duration_since(self.last_refill);
                let new_tokens = (elapsed.as_millis() / self.config.refill_every.as_millis()) as u32;
                if new_tokens > 0 {
                    let max = self.config.capacity + self.config.burst;
                    self.tokens = bucket::clamp(self.tokens + new_tokens, max);
                    self.last_refill = now;
                }
            }
        }

        #[cfg(test)]
        mod tests {
            use super::*;

            #[test]
            fn burst_allows_extra_requests() {
                let mut limiter = Limiter::new(Config::default());
                let now = Instant::now();
                for _ in 0..15 {
                    assert_eq!(limiter.acquire(now), Ok(()));
                }
                assert!(matches!(limiter.acquire(now), Err(Denied::RetryAfter(_))));
            }

            #[test]
            fn refills_over_time() {
                let mut limiter = Limiter::new(Config { capacity: 1, burst: 0, ..Config::default() });
                let start = Instant::now();
                assert_eq!(limiter.acquire(start), Ok(()));
                assert!(limiter.acquire(start).is_err());
                assert_eq!(limiter.acquire(start + Duration::from_millis(150)), Ok(()));
            }
        }
    """,
    "tests/limiter.rs": """
        use std::time::{Duration, Instant};

        use ratelimit::{Config, Denied, Limiter};

        #[test]
        fn tells_callers_how_long_to_wait() {
            let mut limiter = Limiter::new(Config { capacity: 1, burst: 0, refill_every: Duration::from_secs(1) });
            let now = Instant::now();
            limiter.acquire(now).unwrap();
            let Err(Denied::RetryAfter(wait)) = limiter.acquire(now) else {
                panic!("expected to be limited");
            };
            assert!(wait <= Duration::from_secs(1));
        }
    """,
    "web/src/api.test.ts": """
        import { describe, expect, it } from "vitest";
        import { formatReset } from "./api";

        describe("formatReset", () => {
          const quota = { remaining: 3, burst: 2, resetAt: 90_000 };
          it("shows seconds under a minute", () => {
            expect(formatReset(quota, 60_000)).toBe("30s");
          });
          it("shows minutes after that", () => {
            expect(formatReset(quota, 0)).toBe("2m");
          });
          it("never goes negative", () => {
            expect(formatReset(quota, 100_000)).toBe("0s");
          });
        });
    """,
    "src/bucket.rs": """
        /// Helpers shared by limiters.
        pub fn clamp(value: u32, max: u32) -> u32 {
            value.min(max)
        }

        /// Tokens earned over `elapsed`, one per `every`.
        pub fn earned(elapsed: std::time::Duration, every: std::time::Duration) -> u32 {
            (elapsed.as_millis() / every.as_millis().max(1)) as u32
        }
    """,
    "web/src/api.ts": """
        export interface Quota {
          remaining: number;
          burst: number;
          resetAt: number;
        }

        export class QuotaError extends Error {
          constructor(readonly status: number) {
            super(`quota request failed with ${status}`);
          }
        }

        export async function fetchQuota(user: string, signal?: AbortSignal): Promise<Quota> {
          const res = await fetch(`/api/quota/${encodeURIComponent(user)}`, { signal });
          if (!res.ok) throw new QuotaError(res.status);
          return res.json();
        }

        export function formatReset(quota: Quota, now: number): string {
          const seconds = Math.max(0, Math.round((quota.resetAt - now) / 1000));
          return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
        }
    """,
    "web/src/QuotaBadge.tsx": """
        import { formatReset, type Quota } from "./api";

        export function QuotaBadge(props: { quota: Quota; now?: number }) {
          const low = () => props.quota.remaining < 3;
          return (
            <span class="badge" classList={{ low: low() }}>
              {props.quota.remaining} left (+{props.quota.burst} burst), resets in{" "}
              {formatReset(props.quota, props.now ?? Date.now())}
            </span>
          );
        }
    """,
    "tools/report.py": """
        \"\"\"Summarise rate-limit logs.\"\"\"
        import json
        import sys
        from collections import Counter


        def load(path):
            with open(path) as f:
                return [json.loads(line) for line in f if line.strip()]


        def summarise(events):
            denied = [e for e in events if not e["allowed"]]
            by_user = Counter(e["user"] for e in denied)
            return {
                "total": len(events),
                "denied": len(denied),
                "worst": by_user.most_common(3),
            }


        if __name__ == "__main__":
            print(json.dumps(summarise(load(sys.argv[1])), indent=2))
    """,
    "cmd/probe/main.go": """
        package main

        import (
        \t"fmt"
        \t"net/http"
        \t"os"
        \t"time"
        )

        func main() {
        \tclient := &http.Client{Timeout: 5 * time.Second}
        \tresp, err := client.Get(os.Args[1])
        \tif err != nil {
        \t\tfmt.Fprintln(os.Stderr, "error:", err)
        \t\tos.Exit(1)
        \t}
        \tdefer resp.Body.Close()
        \tfmt.Println(resp.StatusCode, resp.Header.Get("Retry-After"))
        }
    """,
    "flake.nix": """
        {
          inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
          outputs = { self, nixpkgs }:
            let pkgs = nixpkgs.legacyPackages.x86_64-linux;
            in {
              packages.x86_64-linux.default = pkgs.rustPlatform.buildRustPackage {
                pname = "ratelimit";
                version = "0.1.0";
                src = ./.;
                cargoLock.lockFile = ./Cargo.lock;
              };
            };
        }
    """,
    "README.md": """
        # ratelimit

        A token-bucket rate limiter with **burst** support.

        ## Usage

        Create a `Limiter` and call `acquire(now)`. It returns
        `Err(Denied::RetryAfter(d))` when the bucket is empty.

        ## Tools

        - `tools/report.py` summarises logs.
        - `cmd/probe` checks an endpoint.
    """,
    "db/schema.sql": """
        CREATE TABLE quotas (
            user_id TEXT PRIMARY KEY,
            remaining INTEGER NOT NULL,
            burst INTEGER NOT NULL DEFAULT 0,
            reset_at INTEGER NOT NULL
        );

        CREATE INDEX quotas_by_reset ON quotas (reset_at);
    """,
    "web/src/badge.css": """
        .badge {
          padding: 2px 6px;
          border-radius: 4px;
          background: #eee;
        }

        .badge.low {
          background: #fde68a;
          color: #78350f;
        }
    """,
    "Cargo.lock": """
        [[package]]
        name = "ratelimit"
        version = "0.1.0"
        dependencies = [
         "tokio",
        ]

        [[package]]
        name = "tokio"
        version = "1.41.1"
        source = "registry+https://github.com/rust-lang/crates.io-index"
    """,
    "web/src/gen/quota.ts": """
        // This file was generated by ts-rs. Do not edit it by hand.

        export type Quota = { remaining: number; burst: number; resetAt: number };
    """,
}


# The branch's history: which changed files each commit takes.
COMMITS = [
    (["src/lib.rs", "src/bucket.rs", "tests/limiter.rs", "Cargo.lock"], "Add burst capacity and wait times to the limiter"),
    (["web/src/api.ts", "web/src/api.test.ts", "web/src/QuotaBadge.tsx", "web/src/badge.css", "web/src/gen/quota.ts"],
     "Show typed quota errors in the badge"),
    (["cmd/probe/main.go", "db/schema.sql"], "Probe timeout flag and reset_at column"),
]


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/diffd-demo").resolve()
    if root.exists() and any(root.iterdir()):
        sys.exit(f"{root} exists and isn't empty")
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "demo@example.com")
    git(root, "config", "user.name", "Demo")
    for path, text in BASE.items():
        w(root, path, text)
    (root / "src/routes.rs").write_text(BIG)
    (root / "assets").mkdir(exist_ok=True)
    (root / "assets/logo.png").write_bytes(bytes(range(256)) * 4)
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "Initial limiter")

    git(root, "checkout", "-q", "-b", "demo")
    for group, message in COMMITS:
        for path in group:
            w(root, path, CHANGES[path])
        if "src/lib.rs" in group:
            os.remove(root / "src/legacy.rs")
        if "cmd/probe/main.go" in group:
            git(root, "mv", "tools/report.py", "tools/logreport.py")
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", message)

    # The rest stays uncommitted.
    committed = {p for group, _ in COMMITS for p in group}
    for path, text in CHANGES.items():
        if path == "tools/report.py":
            w(root, "tools/logreport.py", text)
        elif path not in committed:
            w(root, path, text)
    big = BIG.replace('"/api/v1/resource17" => 13,', '"/api/v1/resource17" => 40,')
    big = big.replace('"/api/v1/resource200" => 14,', '"/api/v1/resource200" => 14,\n        "/api/v2/stream" => 100,')
    assert big.count("/api/v2/stream") == 1 and '"/api/v1/resource17" => 40' in big
    (root / "src/routes.rs").write_text(big)
    (root / "assets/logo.png").write_bytes(bytes(range(256)) * 5)
    print(root)


if __name__ == "__main__":
    main()
