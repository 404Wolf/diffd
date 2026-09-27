//! Real language servers, one per language: go to definition, go to type
//! definition, hover and diagnostics through the pool diffd runs. A test is
//! skipped when its server isn't installed.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use diffd_core::model::{CodeAnswer, CodeQuery, Severity};
use diffd_server::adapters::lsp::LspPool;
use diffd_server::config::Config;
use diffd_server::ports::CodeIntel;

fn installed(command: &str) -> bool {
    std::process::Command::new("sh").args(["-c", &format!("command -v {command}")]).output().is_ok_and(|o| o.status.success())
}

/// rustup puts a `rust-analyzer` proxy on the `PATH` even when the component
/// isn't installed: make sure it actually runs.
fn rust_analyzer_installed() -> bool {
    std::process::Command::new("rust-analyzer")
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success())
}

fn write(root: &Path, files: &[(&str, &str)]) {
    for (path, text) in files {
        let p = root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
}

/// Ask until the server has an answer (servers index in the background after starting).
async fn ask_until(
    pool: &LspPool,
    root: &Path,
    path: &str,
    q: CodeQuery,
    line: u32,
    col: u32,
    ok: impl Fn(&CodeAnswer) -> bool,
) -> CodeAnswer {
    let mut last = CodeAnswer::Unavailable { reason: "never asked".into() };
    for _ in 0..60 {
        last = pool.ask(root, path, q, line, col).await;
        if ok(&last) {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("{path}:{line}:{col} {q:?}: no good answer; last: {last:?}");
}

fn goes_to(answer: &CodeAnswer, path: &str, line: u32) -> bool {
    matches!(answer, CodeAnswer::Locations { locations } if locations.iter().any(|l| l.path == path && l.line == line))
}

fn hover_has(answer: &CodeAnswer, needle: &str) -> bool {
    matches!(answer, CodeAnswer::Hover { markdown } if markdown.contains(needle))
}

/// Wait for diagnostics on `path` that satisfy `ok`.
async fn diagnostics_until(
    pool: &LspPool,
    rx: &mut tokio::sync::broadcast::Receiver<diffd_server::ports::FileDiagnostics>,
    root: &Path,
    path: &str,
    ok: impl Fn(&[diffd_core::model::Diagnostic]) -> bool,
) {
    let want = root.join(path);
    pool.sync(root, path).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        let d = tokio::time::timeout_at(deadline, rx.recv()).await.expect("diagnostics in time").unwrap();
        if d.path == want && ok(&d.diagnostics) {
            return;
        }
    }
}

fn setup() -> (tempfile::TempDir, std::path::PathBuf, Arc<LspPool>) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let pool = LspPool::new(Arc::new(Config::default()));
    (dir, root, pool)
}

#[tokio::test(flavor = "multi_thread")]
async fn rust() {
    if !rust_analyzer_installed() {
        return eprintln!("skipped: rust-analyzer isn't installed");
    }
    let (_dir, root, pool) = setup();
    write(
        &root,
        &[
            ("Cargo.toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"),
            ("src/lib.rs", "mod shapes;\npub use shapes::Square;\n\npub fn area(s: &Square) -> u32 {\n    s.side * s.side\n}\n"),
            ("src/shapes.rs", "/// A square.\npub struct Square {\n    pub side: u32,\n}\n"),
        ],
    );
    let mut rx = pool.diagnostics();
    // `Square` in `area(s: &Square)`: line 4, col 17.
    let def = ask_until(&pool, &root, "src/lib.rs", CodeQuery::Definition, 4, 17, |a| goes_to(a, "src/shapes.rs", 2)).await;
    assert!(goes_to(&def, "src/shapes.rs", 2));
    // The type of `s` (line 4, col 12) is Square.
    ask_until(&pool, &root, "src/lib.rs", CodeQuery::TypeDefinition, 4, 12, |a| goes_to(a, "src/shapes.rs", 2)).await;
    ask_until(&pool, &root, "src/lib.rs", CodeQuery::Hover, 4, 17, |a| hover_has(a, "A square")).await;
    // Every use of Square: its declaration, the re-export and the parameter.
    let uses = ask_until(
        &pool,
        &root,
        "src/lib.rs",
        CodeQuery::References,
        4,
        17,
        |a| matches!(a, CodeAnswer::Locations { locations } if locations.len() >= 3),
    )
    .await;
    assert!(goes_to(&uses, "src/shapes.rs", 2) && goes_to(&uses, "src/lib.rs", 4));

    write(&root, &[("src/lib.rs", "mod shapes;\npub use shapes::Square;\n\npub fn area(s: &Square) -> u32 {\n    s.sides\n}\n")]);
    diagnostics_until(&pool, &mut rx, &root, "src/lib.rs", |d| d.iter().any(|d| d.severity == Severity::Error && d.line == 5)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn typescript() {
    if !installed("typescript-language-server") {
        return eprintln!("skipped: typescript-language-server isn't installed");
    }
    let (_dir, root, pool) = setup();
    // Like any TypeScript project, the workspace has its own `typescript`.
    let global = std::process::Command::new("npm").args(["root", "-g"]).output().unwrap();
    let global = std::path::PathBuf::from(String::from_utf8_lossy(&global.stdout).trim()).join("typescript");
    if !global.join("lib/tsserver.js").exists() {
        return eprintln!("skipped: no global typescript with tsserver.js to link (npm i -g typescript@5)");
    }
    std::fs::create_dir_all(root.join("node_modules")).unwrap();
    std::os::unix::fs::symlink(&global, root.join("node_modules/typescript")).unwrap();
    write(
        &root,
        &[
            ("tsconfig.json", r#"{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext" } }"#),
            ("src/quota.ts", "/** How much is left. */\nexport interface Quota {\n  remaining: number;\n}\n"),
            (
                "src/badge.ts",
                "import type { Quota } from \"./quota\";\n\nexport function label(q: Quota): string {\n  return `${q.remaining} left`;\n}\n",
            ),
        ],
    );
    let mut rx = pool.diagnostics();
    ask_until(&pool, &root, "src/badge.ts", CodeQuery::Definition, 3, 26, |a| goes_to(a, "src/quota.ts", 2)).await;
    ask_until(&pool, &root, "src/badge.ts", CodeQuery::TypeDefinition, 3, 23, |a| goes_to(a, "src/quota.ts", 2)).await;
    ask_until(&pool, &root, "src/badge.ts", CodeQuery::Hover, 3, 26, |a| hover_has(a, "How much is left")).await;

    write(
        &root,
        &[(
            "src/badge.ts",
            "import type { Quota } from \"./quota\";\n\nexport function label(q: Quota): string {\n  return q.remaining;\n}\n",
        )],
    );
    diagnostics_until(&pool, &mut rx, &root, "src/badge.ts", |d| d.iter().any(|d| d.severity == Severity::Error && d.line == 4)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn python() {
    if !installed("pyright-langserver") {
        return eprintln!("skipped: pyright isn't installed");
    }
    let (_dir, root, pool) = setup();
    write(
        &root,
        &[
            ("pyproject.toml", "[project]\nname = \"demo\"\n"),
            (
                "tools/common.py",
                "def percent(part: int, whole: int) -> float:\n    \"\"\"Part of whole, in percent.\"\"\"\n    return 100 * part / whole\n",
            ),
            ("tools/report.py", "from common import percent\n\nprint(percent(1, 2))\n"),
        ],
    );
    let mut rx = pool.diagnostics();
    ask_until(&pool, &root, "tools/report.py", CodeQuery::Definition, 3, 7, |a| goes_to(a, "tools/common.py", 1)).await;
    ask_until(&pool, &root, "tools/report.py", CodeQuery::Hover, 3, 7, |a| hover_has(a, "Part of whole")).await;
    write(&root, &[("tools/report.py", "from common import percent\n\nprint(percent(1, \"2\"))\n")]);
    diagnostics_until(&pool, &mut rx, &root, "tools/report.py", |d| d.iter().any(|d| d.severity == Severity::Error && d.line == 3)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn go() {
    if !installed("gopls") {
        return eprintln!("skipped: gopls isn't installed");
    }
    let (_dir, root, pool) = setup();
    write(
        &root,
        &[
            ("go.mod", "module demo\n\ngo 1.21\n"),
            ("flags.go", "package main\n\n// Flags for the probe.\ntype Flags struct {\n\tURL string\n}\n"),
            ("main.go", "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tf := Flags{URL: \"x\"}\n\tfmt.Println(f.URL)\n}\n"),
        ],
    );
    let mut rx = pool.diagnostics();
    ask_until(&pool, &root, "main.go", CodeQuery::Definition, 6, 7, |a| goes_to(a, "flags.go", 4)).await;
    ask_until(&pool, &root, "main.go", CodeQuery::TypeDefinition, 7, 13, |a| goes_to(a, "flags.go", 4)).await;
    ask_until(&pool, &root, "main.go", CodeQuery::Hover, 6, 7, |a| hover_has(a, "Flags for the probe")).await;
    write(&root, &[("main.go", "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tf := Flags{URL: \"x\"}\n\tfmt.Println(f.Nope)\n}\n")]);
    diagnostics_until(&pool, &mut rx, &root, "main.go", |d| d.iter().any(|d| d.severity == Severity::Error && d.line == 7)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn nix() {
    if !installed("nil") {
        return eprintln!("skipped: nil isn't installed");
    }
    let (_dir, root, pool) = setup();
    write(&root, &[("flake.nix", "let\n  version = \"1.0\";\n  name = \"demo-${version}\";\nin\n{ inherit name; }\n")]);
    let mut rx = pool.diagnostics();
    // `version` inside the string on line 3 goes to its binding on line 2.
    ask_until(&pool, &root, "flake.nix", CodeQuery::Definition, 3, 20, |a| goes_to(a, "flake.nix", 2)).await;
    write(&root, &[("flake.nix", "let\n  version = \"1.0\";\nin\n{ name = missing; }\n")]);
    diagnostics_until(&pool, &mut rx, &root, "flake.nix", |d| d.iter().any(|d| d.severity == Severity::Error && d.line == 4)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn yaml() {
    if !installed("yaml-language-server") {
        return eprintln!("skipped: yaml-language-server isn't installed");
    }
    let (_dir, root, pool) = setup();
    write(&root, &[("ci.yml", "name: ci\njobs:\n  test:\n    steps: [\n")]);
    let mut rx = pool.diagnostics();
    diagnostics_until(&pool, &mut rx, &root, "ci.yml", |d| d.iter().any(|d| d.severity == Severity::Error)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn several_languages_at_once_and_graceful_misses() {
    let (_dir, root, pool) = setup();
    write(&root, &[("README.md", "# hi\n"), ("x.unknownext", "?")]);
    match pool.ask(&root, "README.md", CodeQuery::Hover, 1, 2).await {
        CodeAnswer::Unavailable { reason } => assert!(reason.contains(".md"), "{reason}"),
        other => panic!("{other:?}"),
    }
    // A configured server that isn't installed says so instead of hanging.
    let mut config = Config::default();
    config.lsp.servers.get_mut("gopls").unwrap().command = "definitely-not-installed-lsp".into();
    let pool = LspPool::new(Arc::new(config));
    write(&root, &[("go.mod", "module x\n"), ("a.go", "package x\n")]);
    match pool.ask(&root, "a.go", CodeQuery::Hover, 1, 1).await {
        CodeAnswer::Unavailable { reason } => assert!(reason.contains("isn't available"), "{reason}"),
        other => panic!("{other:?}"),
    }
}

/// A pool around the fake server in `fixtures/fake_lsp.py`, for `.fake` files.
fn fake_pool(max_open_files: usize, log: &Path) -> Option<Arc<LspPool>> {
    if !installed("python3") {
        eprintln!("skipped: python3 isn't installed");
        return None;
    }
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_lsp.py");
    let config = Config::parse(&format!(
        "[lsp]\nmax_open_files = {max_open_files}\n[lsp.servers.fake]\ncommand = \"python3\"\nargs = [{script:?}]\n\
         languages = {{ fake = [\"fake\"] }}\nenv = {{ FAKE_LSP_LOG = {log:?} }}\n"
    ))
    .unwrap();
    Some(LspPool::new(Arc::new(config)))
}

/// Wait until the fake server's log has `line`.
async fn logged(log: &Path, line: &str) -> String {
    for _ in 0..100 {
        let text = std::fs::read_to_string(log).unwrap_or_default();
        if text.lines().any(|l| l == line) {
            return text;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the server never logged `{line}`: {}", std::fs::read_to_string(log).unwrap_or_default());
}

#[tokio::test]
async fn open_files_are_bounded_and_deleted_ones_closed() {
    let dir = tempfile::tempdir().unwrap();
    let (root, log) = (dir.path().join("repo"), dir.path().join("log"));
    let Some(pool) = fake_pool(2, &log) else { return };
    write(&root, &[("a.fake", "a"), ("b.fake", "b"), ("c.fake", "c")]);
    for f in ["a.fake", "b.fake", "c.fake"] {
        pool.sync(&root, f).await;
    }
    let text = logged(&log, "didClose a.fake").await;
    assert!(text.contains("didOpen c.fake") && !text.contains("didClose b.fake"), "the oldest goes first:\n{text}");

    std::fs::remove_file(root.join("b.fake")).unwrap();
    pool.sync(&root, "b.fake").await;
    logged(&log, "didClose b.fake").await;
}

#[tokio::test]
async fn a_crashing_server_is_restarted_then_given_up_on() {
    let dir = tempfile::tempdir().unwrap();
    let (root, log) = (dir.path().join("repo"), dir.path().join("log"));
    let Some(pool) = fake_pool(10, &log) else { return };
    write(&root, &[("a.fake", "a")]);
    let mut reasons = Vec::new();
    for _ in 0..5 {
        match pool.ask(&root, "a.fake", CodeQuery::Hover, 1, 1).await {
            CodeAnswer::Unavailable { reason } => reasons.push(reason),
            other => panic!("the fake server never answers a hover: {other:?}"),
        }
        // Let the pool see the exit.
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let crashes = std::fs::read_to_string(&log).unwrap().lines().filter(|l| *l == "crash").count();
    assert_eq!(crashes, 3, "restarted after each crash, up to the limit: {reasons:?}");
    assert!(reasons.last().unwrap().contains("keeps crashing"), "{reasons:?}");
}
