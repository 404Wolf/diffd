# Vendored: Signal's tungstenite fork

This is [signalapp/tungstenite-rs](https://github.com/signalapp/tungstenite-rs)
at `a1837ccfe96b6895a57352d7f0112e4557516c27`: tungstenite 0.27 with
`permessage-deflate` (RFC 7692). diffd uses it (through `[patch.crates-io]`
in the workspace `Cargo.toml`) to compress the review page's WebSocket.

Only `src/`, the licenses, the README and a trimmed `Cargo.toml` (no
benches, examples or dev-dependencies) are kept. It's vendored rather than a
git dependency so builds, including Nix's, need no network or extra hashes.

To update: copy `src/` from a newer revision, update the revision above, and
run the end-to-end tests (they check that compression is negotiated).
