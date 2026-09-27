//! Embed the web page bundle (`web/dist/index.html`) in the binary.
//!
//! When the bundle hasn't been built (e.g. `cargo check` on a fresh clone), a
//! placeholder page is embedded instead that says how to build it.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("index.html");
    let bundle =
        std::env::var_os("DIFFD_WEB_DIST").map(PathBuf::from).unwrap_or_else(|| manifest.join("../../web/dist")).join("index.html");
    println!("cargo:rerun-if-changed={}", bundle.display());
    println!("cargo:rerun-if-env-changed=DIFFD_WEB_DIST");
    match std::fs::read_to_string(&bundle) {
        Ok(html) => std::fs::write(&out, html).unwrap(),
        Err(_) => {
            println!("cargo:warning=web bundle not found at {}; embedding a placeholder (run `just web`)", bundle.display());
            std::fs::write(
                &out,
                "<!doctype html><meta charset=utf-8><title>diffd</title>\
                 <p style=\"font:14px system-ui;margin:2rem\">This diffd binary was built without its web page. \
                 Build it with <code>just build</code> (or <code>npm --prefix web run build</code> before <code>cargo build</code>).</p>\
                 <!--diffd-boot-->",
            )
            .unwrap();
        }
    }
}
