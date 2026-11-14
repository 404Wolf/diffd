//! Showing boards: presenting files, what may be read, and the board pages.

mod common;

use std::path::Path;
use std::sync::Arc;

use diffd_core::model::{BoardItemId, BoardItemKind, BoardItemState};
use diffd_server::App;
use diffd_server::adapters::git::GitCli;
use diffd_server::adapters::http;
use diffd_server::adapters::store::Store;
use diffd_server::app::{AppError, Caller, PresentPolicy, PresentRequest};
use diffd_server::ports::SystemClock;
use serde_json::{Value, json};

/// The smallest valid PNG header: enough for diffd's check, which reads the signature.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

fn write_bytes(dir: &Path, path: &str, bytes: &[u8]) {
    let p = dir.join(path);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, bytes).unwrap();
}

fn request(file: impl AsRef<Path>) -> PresentRequest {
    PresentRequest { file: file.as_ref().to_string_lossy().into_owned(), ..PresentRequest::default() }
}

fn worker() -> Caller {
    Caller {
        terminal: Some("t1n7".into()),
        role: Some("worker".into()),
        project: Some("herdr-android".into()),
        machine: Some("server".into()),
        agent: Some("Claude".into()),
    }
}

fn invalid(result: Result<impl std::fmt::Debug, AppError>) -> String {
    match result {
        Err(AppError::Invalid(message)) => message,
        other => panic!("expected an invalid request, got {other:?}"),
    }
}

/// A repository with a report that shows two images (one missing) and a remote one.
fn report_repo() -> common::Repo {
    let repo = common::Repo::new();
    repo.write(
        "reports/plan.md",
        "# The plan\n\nIntro.\n\n![shot](shots/cover.png)\n![gone](missing.png)\n![remote](https://example.com/x.png)\n",
    );
    write_bytes(&repo.path(), "reports/shots/cover.png", PNG);
    repo
}

#[tokio::test]
async fn presenting_a_report_bundles_its_images_and_updates_in_place() {
    let repo = report_repo();
    let app = common::app().await;
    let plan = repo.path().join("reports/plan.md");
    let mut req = request(&plan);
    req.message = Some("  the plan,\n  needs your OK ".into());
    let first = app.present_file(req, worker()).await.unwrap();
    assert_eq!(first.scope, "herdr-android", "a worker's items go on its project's board");
    assert_eq!(first.kind, BoardItemKind::Markdown);
    assert_eq!(first.title, "The plan");
    assert_eq!((first.revision, first.replaced), (1, false));
    assert_eq!(first.url, format!("http://localhost:3433/show/herdr-android/{}", first.id));
    assert_eq!(first.board, "http://localhost:3433/show/herdr-android");
    assert_eq!(first.skipped.len(), 1, "the missing image is reported; the remote one is just a link: {:?}", first.skipped);
    assert_eq!(first.skipped[0].path, "missing.png");
    assert_eq!(first.skipped[0].reason, "not found");

    let id = BoardItemId(first.id.clone());
    let items = app.board(Some("herdr-android")).await.unwrap();
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.assets, ["shots/cover.png"]);
    assert_eq!(item.message.as_deref(), Some("the plan, needs your OK"));
    assert_eq!(item.source.path, plan.to_string_lossy());
    assert_eq!(item.source.terminal.as_deref(), Some("t1n7"));
    assert_eq!(item.source.machine.as_deref(), Some("server"));
    assert_eq!((item.state, item.seen_revision), (BoardItemState::Open, 0));
    assert!(app.board(Some("deacon")).await.unwrap().is_empty());
    assert_eq!(app.board(None).await.unwrap().len(), 1);

    let content = app.board_item(&id).await.unwrap();
    assert!(content.text.as_deref().unwrap().starts_with("# The plan"));
    assert!(content.syntax.is_empty());
    let image = app.board_asset(&id, "shots/cover.png").await.unwrap();
    assert_eq!((image.mime.as_str(), image.bytes.as_slice()), ("image/png", PNG));
    assert!(matches!(app.board_asset(&id, "missing.png").await, Err(AppError::NotFound(_))));
    assert!(matches!(app.board_asset(&id, "").await, Err(AppError::NotFound(_))), "a document's own text isn't an image");

    // Wolf put it away and saw it; then the agent presents a new version: one item, back in view, with news.
    app.set_board_item_state(&id, Some(BoardItemState::Hidden), Some(1)).await.unwrap();
    repo.write("reports/plan.md", "# The plan, v2\n\nNo images now.\n");
    let second = app.present_file(request(&plan), worker()).await.unwrap();
    assert_eq!((second.id.as_str(), second.revision, second.replaced), (first.id.as_str(), 2, true));
    let items = app.board(Some("herdr-android")).await.unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!((items[0].state, items[0].seen_revision, items[0].revision), (BoardItemState::Open, 1, 2));
    assert_eq!(items[0].title, "The plan, v2");
    assert!(items[0].assets.is_empty());
    assert!(matches!(app.board_asset(&id, "shots/cover.png").await, Err(AppError::NotFound(_))), "old images go with the old revision");

    // `new` keeps the old item and adds another.
    let mut again = request(&plan);
    again.new = true;
    let third = app.present_file(again, worker()).await.unwrap();
    assert_ne!(third.id, first.id);
    assert_eq!(app.board(Some("herdr-android")).await.unwrap().len(), 2);
}

#[tokio::test]
async fn leads_choose_boards_and_others_get_their_own() {
    let repo = report_repo();
    let app = common::app().await;
    let plan = repo.path().join("reports/plan.md");
    let mut escalate = request(&plan);
    escalate.scope = Some("deacon".into());
    assert!(invalid(app.present_file(escalate.clone(), worker()).await).contains("ask your manager"));
    let pm = Caller { role: Some("pm".into()), terminal: Some("t1jf".into()), ..worker() };
    assert_eq!(app.present_file(escalate, pm).await.unwrap().scope, "deacon");
    let deacon = Caller { role: Some("deacon".into()), project: None, terminal: Some("t16b".into()), ..Caller::default() };
    assert_eq!(app.present_file(request(&plan), deacon).await.unwrap().scope, "deacon");
    // Outside Herdr: the repository's name, or `default` when it makes a poor URL (a temp dir's `.tmpXYZ`).
    assert_eq!(app.present_file(request(&plan), Caller::default()).await.unwrap().scope, "default");
}

#[tokio::test]
async fn only_allowed_files_are_read() {
    let repo = report_repo();
    repo.write(".gitignore", "build/\n");
    repo.write(".env", "TOKEN=secret\n");
    repo.write("config/.env.local", "TOKEN=secret\n");
    repo.write("certs/server.pem", "-----BEGIN-----\n");
    repo.write("build/out.md", "# Built\n");
    repo.write("notes.txt", "fine\n");
    let outside = tempfile::tempdir().unwrap();
    let outside_dir = outside.path().canonicalize().unwrap();
    std::fs::write(outside_dir.join("elsewhere.md"), "# Elsewhere\n").unwrap();
    std::os::unix::fs::symlink(outside_dir.join("elsewhere.md"), repo.path().join("link.md")).unwrap();
    let app = common::app().await;
    let present = |file: std::path::PathBuf| app.present_file(request(file), worker());

    for private in [".env", "config/.env.local", "certs/server.pem", ".git/config"] {
        assert!(invalid(present(repo.path().join(private)).await).contains("looks private"), "{private}");
    }
    assert!(invalid(present(repo.path().join("build/out.md")).await).contains("ignored by git"));
    assert!(invalid(present(outside_dir.join("elsewhere.md")).await).contains("outside every git repository"));
    // A symlink or `..` leads to the real file, which is checked.
    assert!(invalid(present(repo.path().join("link.md")).await).contains("outside every git repository"));
    let mut dotdot = request(format!("../{}/elsewhere.md", outside_dir.file_name().unwrap().to_string_lossy()));
    dotdot.cwd = Some(repo.path().to_string_lossy().into_owned());
    if outside_dir.parent() == repo.path().parent() {
        assert!(invalid(app.present_file(dotdot, worker()).await).contains("outside every git repository"));
    }
    // Relative paths need the caller's directory.
    assert!(invalid(app.present_file(request("notes.txt"), worker()).await).contains("cwd"));
    let mut relative = request("notes.txt");
    relative.cwd = Some(repo.path().to_string_lossy().into_owned());
    assert_eq!(app.present_file(relative, worker()).await.unwrap().kind, BoardItemKind::Text);
    assert!(invalid(present(repo.path().join("nope.md")).await).contains("can't open"));
    assert!(invalid(present(repo.path().join("reports")).await).contains("isn't a file"));

    // Roots allow files outside git, and ignored ones, but never private-looking ones.
    let roots = [outside_dir.to_string_lossy().into_owned(), repo.path().join("build").to_string_lossy().into_owned()];
    app.set_present_policy(PresentPolicy::new(&roots, &["*.txt".into()]).unwrap());
    assert_eq!(present(outside_dir.join("elsewhere.md")).await.unwrap().title, "Elsewhere");
    assert_eq!(present(repo.path().join("build/out.md")).await.unwrap().title, "Built");
    assert!(invalid(present(repo.path().join("notes.txt")).await).contains("looks private"), "deny patterns from the config");
    std::fs::write(outside_dir.join(".env"), "X=1\n").unwrap();
    assert!(invalid(present(outside_dir.join(".env")).await).contains("looks private"));
}

#[tokio::test]
async fn sizes_and_contents_are_checked() {
    let repo = common::Repo::new();
    repo.write("big.md", &"x".repeat(2 * 1024 * 1024 + 1));
    write_bytes(&repo.path(), "blob.txt", b"text\0with a NUL");
    write_bytes(&repo.path(), "latin1.txt", b"caf\xe9\n");
    repo.write("fake.png", "<svg onload=alert(1)>");
    write_bytes(&repo.path(), "real.png", PNG);
    repo.write("doc.md", "# Doc\n![fake](fake.png)\n![out](../../../../../../etc/hostname.png)\n");
    let app = common::app().await;
    let present = |file: &str| app.present_file(request(repo.path().join(file)), worker());
    assert!(invalid(present("big.md").await).contains("more than"));
    assert!(invalid(present("blob.txt").await).contains("binary"));
    assert!(invalid(present("latin1.txt").await).contains("UTF-8"));
    assert!(invalid(present("fake.png").await).contains("doesn't look like"));
    let image = present("real.png").await.unwrap();
    assert_eq!(image.kind, BoardItemKind::Image);
    let id = BoardItemId(image.id);
    assert_eq!(app.board_asset(&id, "").await.unwrap().bytes, PNG);
    assert!(app.board_item(&id).await.unwrap().text.is_none());
    let doc = present("doc.md").await.unwrap();
    let reasons: Vec<_> = doc.skipped.iter().map(|s| (s.path.as_str(), s.reason.as_str())).collect();
    assert_eq!(reasons.len(), 2, "{reasons:?}");
    assert!(reasons[0].1.contains("doesn't look like"), "{reasons:?}");
}

#[tokio::test]
async fn code_is_highlighted_and_long_files_cut() {
    let repo = common::Repo::new();
    repo.write("src/main.rs", "fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}\n");
    repo.write("change.diff", "--- a\n+++ b\n-old\n+new\n");
    repo.write("long.log", &(1..=6000).map(|n| format!("line {n}\n")).collect::<String>());
    repo.write("doc.md", "# Doc\n");
    let app = common::app().await;
    let mut req = request(repo.path().join("src/main.rs"));
    req.lines = Some([2, 3]);
    let code = app.present_file(req, worker()).await.unwrap();
    assert_eq!((code.kind, code.title.as_str()), (BoardItemKind::Code, "main.rs"));
    let content = app.board_item(&BoardItemId(code.id)).await.unwrap();
    assert_eq!(content.item.lines, Some([2, 3]));
    assert_eq!(content.item.language.as_deref(), Some("Rust"));
    assert_eq!(content.syntax.len(), content.text.as_deref().unwrap().split('\n').count());
    assert!(content.syntax.iter().any(|runs| !runs.is_empty()), "Rust gets highlighted");

    let diff = app.present_file(request(repo.path().join("change.diff")), worker()).await.unwrap();
    let content = app.board_item(&BoardItemId(diff.id)).await.unwrap();
    assert_eq!((content.item.kind, content.item.language.as_deref()), (BoardItemKind::Code, Some("Diff")));

    let long = app.present_file(request(repo.path().join("long.log")), worker()).await.unwrap();
    let content = app.board_item(&BoardItemId(long.id)).await.unwrap();
    assert_eq!(content.item.kind, BoardItemKind::Text);
    assert_eq!(content.total_lines, Some(6001), "6000 lines and the empty one after the last newline");
    let text = content.text.unwrap();
    assert_eq!(text.lines().count(), 5000);
    assert!(text.ends_with("line 5000"));

    let mut bad = request(repo.path().join("src/main.rs"));
    bad.lines = Some([0, 3]);
    assert!(invalid(app.present_file(bad, worker()).await).contains("lines"));
    let mut ignored = request(repo.path().join("doc.md"));
    ignored.lines = Some([1, 1]);
    assert_eq!(app.board(None).await.unwrap().len(), 3);
    let doc = app.present_file(ignored, worker()).await.unwrap();
    assert_eq!(app.board_item(&BoardItemId(doc.id)).await.unwrap().item.lines, None, "lines are for code and text");
}

#[tokio::test]
async fn seen_never_goes_backwards_or_past_the_latest() {
    let repo = report_repo();
    let app = common::app().await;
    let id = BoardItemId(app.present_file(request(repo.path().join("reports/plan.md")), worker()).await.unwrap().id);
    let item = app.set_board_item_state(&id, None, Some(9)).await.unwrap();
    assert_eq!((item.seen_revision, item.state), (1, BoardItemState::Open));
    let item = app.set_board_item_state(&id, Some(BoardItemState::Minimised), Some(0)).await.unwrap();
    assert_eq!((item.seen_revision, item.state), (1, BoardItemState::Minimised));
    assert!(matches!(app.set_board_item_state(&BoardItemId("missing".into()), None, Some(1)).await, Err(AppError::NotFound(_))));
}

#[tokio::test]
async fn board_items_survive_a_restart() {
    let repo = report_repo();
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", dir.path().join("diffd.db").display());
    let open = || async {
        let store = Store::open(&url).await.unwrap();
        App::new(store, Arc::new(GitCli), common::engine(), Arc::new(SystemClock), "http://localhost:3433".into())
    };
    let app = open().await;
    let id = app.present_file(request(repo.path().join("reports/plan.md")), worker()).await.unwrap().id;
    app.set_board_item_state(&BoardItemId(id.clone()), Some(BoardItemState::Minimised), Some(1)).await.unwrap();
    drop(app);
    // The checkout can go too: the item is a snapshot.
    drop(repo);
    let app = open().await;
    let items = app.board(None).await.unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!((items[0].id.0.as_str(), items[0].state, items[0].seen_revision), (id.as_str(), BoardItemState::Minimised, 1));
    let id = BoardItemId(id);
    assert!(app.board_item(&id).await.unwrap().text.unwrap().contains("The plan"));
    assert_eq!(app.board_asset(&id, "shots/cover.png").await.unwrap().bytes, PNG);
}

/// The board over HTTP: who may present, what the pages and images send.
#[tokio::test]
async fn the_board_over_http() {
    let repo = report_repo();
    let app = common::app().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let access = http::Access { allowed_hosts: vec!["box.tailnet.ts.net".into()] };
    tokio::spawn(async move {
        let page = "<!doctype html><title>t</title><!--diffd-boot-->";
        axum::serve(listener, http::router_with_access(app, page, tokio_util::sync::CancellationToken::new(), access)).await.unwrap();
    });
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();
    let body = json!({ "file": "reports/plan.md", "cwd": repo.path() });
    let post = |host: &'static str, origin: Option<&'static str>| {
        let mut req = client.post(format!("{base}/api/present")).header("host", host).json(&body);
        if let Some(origin) = origin {
            req = req.header("origin", origin);
        }
        req.send()
    };

    // Only programs on this machine may make diffd read a file: not the tailnet, not a page.
    assert_eq!(post("box.tailnet.ts.net", None).await.unwrap().status(), 403);
    assert_eq!(post("localhost:3433", Some("http://localhost:3433")).await.unwrap().status(), 403);
    let presented = post("localhost:3433", None).await.unwrap();
    assert_eq!(presented.status(), 200);
    let presented: Value = presented.json().await.unwrap();
    let (id, scope) = (presented["id"].as_str().unwrap().to_owned(), presented["scope"].as_str().unwrap().to_owned());
    let bad: reqwest::Response = client.post(format!("{base}/api/present")).json(&json!({ "file": "/etc/passwd" })).send().await.unwrap();
    assert_eq!(bad.status(), 400);
    assert!(bad.text().await.unwrap().contains("outside every git repository"));

    let get = |host: &'static str, path: String| client.get(format!("{base}{path}")).header("host", host).send();
    // The pages: the item opened on its board, with a strict CSP.
    let page = get("box.tailnet.ts.net", format!("/show/{scope}/{id}")).await.unwrap();
    assert_eq!(page.status(), 200);
    let csp = page.headers()["content-security-policy"].to_str().unwrap().to_owned();
    assert!(csp.contains("default-src 'none'") && csp.contains("img-src 'self' data: blob:"), "{csp}");
    let html = page.text().await.unwrap();
    assert!(html.contains(r#""page":"board""#) && html.contains(&id), "{html}");
    // A link naming another board still shows the item on its own.
    let html = get("box.tailnet.ts.net", format!("/show/elsewhere/{id}")).await.unwrap().text().await.unwrap();
    assert!(html.contains(&format!(r#""scope":"{scope}""#)), "{html}");
    assert_eq!(get("box.tailnet.ts.net", "/show/x/s-missing".into()).await.unwrap().status(), 404);
    assert_eq!(get("box.tailnet.ts.net", "/show".into()).await.unwrap().status(), 200);
    assert_eq!(get("evil.example", "/show".into()).await.unwrap().status(), 403);

    // The JSON API the page uses.
    let items: Value = get("box.tailnet.ts.net", format!("/api/board?scope={scope}")).await.unwrap().json().await.unwrap();
    assert_eq!(items[0]["id"], id.as_str());
    assert_eq!(items[0]["assets"], json!(["shots/cover.png"]));
    let content: Value = get("box.tailnet.ts.net", format!("/api/board/{id}")).await.unwrap().json().await.unwrap();
    assert_eq!(content["item"]["kind"], "markdown");

    // Images are served inert.
    let image = get("box.tailnet.ts.net", format!("/api/board/{id}/asset?name=shots%2Fcover.png&rev=1")).await.unwrap();
    assert_eq!(image.status(), 200);
    assert_eq!(image.headers()["content-type"], "image/png");
    assert_eq!(image.headers()["x-content-type-options"], "nosniff");
    assert!(image.headers()["content-security-policy"].to_str().unwrap().contains("sandbox"));
    assert_eq!(image.bytes().await.unwrap().as_ref(), PNG);
    assert_eq!(get("box.tailnet.ts.net", format!("/api/board/{id}/asset?name=..%2F.env")).await.unwrap().status(), 404);

    // Changing state: from the board's own origin only.
    let change = |origin: &'static str| {
        client
            .post(format!("{base}/api/board/{id}/state"))
            .header("host", "box.tailnet.ts.net")
            .header("origin", origin)
            .json(&json!({ "state": "hidden", "seen": 1 }))
            .send()
    };
    assert_eq!(change("https://evil.example").await.unwrap().status(), 403);
    let changed = change("https://box.tailnet.ts.net").await.unwrap();
    assert_eq!(changed.status(), 200);
    let changed: Value = changed.json().await.unwrap();
    assert_eq!((changed["state"].as_str(), changed["seenRevision"].as_u64()), (Some("hidden"), Some(1)));
}

/// Agents present through MCP, with the same rules.
#[tokio::test]
async fn agents_present_over_mcp() {
    use rmcp::ServiceExt;
    use rmcp::model::CallToolRequestParams;
    use rmcp::transport::StreamableHttpClientTransport;

    let repo = report_repo();
    let app = common::app().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let page = "<!doctype html><title>t</title><!--diffd-boot-->";
        axum::serve(listener, http::router(app, page, tokio_util::sync::CancellationToken::new())).await.unwrap();
    });
    let client = ().serve(StreamableHttpClientTransport::from_uri(format!("http://127.0.0.1:{port}/mcp"))).await.unwrap();
    let info = client.peer_info().unwrap();
    assert!(info.instructions.as_deref().unwrap_or("").contains("call present"));
    let tools = client.list_all_tools().await.unwrap();
    let present = tools.iter().find(|t| t.name == "present").expect("a present tool");
    assert!(present.description.as_deref().unwrap().contains("instead of telling the user a file path"));
    for field in ["file", "cwd", "title", "message", "lines", "scope", "new"] {
        assert!(present.input_schema["properties"][field].is_object(), "{field}");
    }
    let call = |args: Value| client.call_tool(CallToolRequestParams::new("present").with_arguments(args.as_object().unwrap().clone()));
    let result = call(json!({ "file": "reports/plan.md", "cwd": repo.path(), "message": "for you" })).await.unwrap();
    assert_ne!(result.is_error, Some(true));
    let text = serde_json::to_value(&result.content[0]).unwrap()["text"].as_str().unwrap().to_owned();
    let answer: Value = serde_json::from_str(&text).unwrap();
    assert!(answer["url"].as_str().unwrap().starts_with("http://localhost:3433/show/"));
    assert_eq!(answer["title"], "The plan");
    let refused = call(json!({ "file": repo.path().join(".git/config") })).await.unwrap();
    assert_eq!(refused.is_error, Some(true));
    client.cancel().await.unwrap();
}
