//! The server over the wire: MCP over Streamable HTTP for the agent, the
//! page's WebSocket for the user, and the page itself.

mod common;

use std::time::Duration;

use diffd_server::adapters::http;
use futures::{SinkExt, StreamExt};
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::transport::StreamableHttpClientTransport;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

async fn serve() -> u16 {
    let app = common::app().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(
            listener,
            http::router(app, "<!doctype html><title>t</title><!--diffd-boot-->", tokio_util::sync::CancellationToken::new()),
        )
        .await
        .unwrap();
    });
    port
}

async fn call(client: &rmcp::Peer<rmcp::RoleClient>, tool: &'static str, args: Value) -> Value {
    let params = CallToolRequestParams::new(tool).with_arguments(args.as_object().unwrap().clone());
    let result = client.call_tool(params).await.unwrap();
    let text = serde_json::to_value(&result.content[0]).unwrap()["text"].as_str().unwrap().to_owned();
    assert_ne!(result.is_error, Some(true), "{tool} failed: {text}");
    serde_json::from_str(&text).unwrap_or(Value::String(text))
}

async fn next_json(ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin)) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.unwrap().unwrap().unwrap();
        if let Message::Text(t) = msg {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

#[tokio::test]
async fn agent_and_page_talk_through_the_server() {
    let repo = common::Repo::new();
    repo.write("src/main.rs", "fn main() {\n    println!(\"hi\");\n}\n");
    repo.commit("init");
    repo.write("src/main.rs", "fn main() {\n    println!(\"hello\");\n}\n");
    let port = serve().await;
    let base = format!("http://127.0.0.1:{port}");

    let transport = StreamableHttpClientTransport::from_uri(format!("{base}/mcp"));
    let client = ().serve(transport).await.unwrap();
    let info = client.peer_info().unwrap();
    assert!(info.instructions.as_deref().unwrap_or("").contains("wait_for_feedback"));
    let tools: Vec<String> = client.list_all_tools().await.unwrap().into_iter().map(|t| t.name.into_owned()).collect();
    for t in ["share_diff", "wait_for_feedback", "reply", "annotate", "say", "show", "refresh", "get_review"] {
        assert!(tools.contains(&t.to_owned()), "missing tool {t}: {tools:?}");
    }

    let shared = call(
        &client,
        "share_diff",
        json!({
            "repo_path": repo.path(), "from": "HEAD", "title": "Say hello",
            "annotations": [{ "file": "src/main.rs", "lines": [2, 2], "body": "Friendlier greeting.", "kind": "why" }]
        }),
    )
    .await;
    let id = shared["review_id"].as_str().unwrap().to_owned();

    // The page is served with its state embedded.
    let page = reqwest::get(format!("{base}/r/{id}")).await.unwrap();
    assert_eq!(page.status(), 200);
    let html = page.text().await.unwrap();
    assert!(html.contains(r#"<script id="diffd-boot" type="application/json">{"page":"review""#));
    // Requests for other hosts are refused (DNS rebinding).
    let evil = reqwest::Client::new().get(format!("{base}/")).header("host", "evil.example").send().await.unwrap();
    assert_eq!(evil.status(), 403);
    let cross =
        reqwest::Client::new().delete(format!("{base}/api/reviews/{id}")).header("origin", "https://evil.example").send().await.unwrap();
    assert_eq!(cross.status(), 403);

    // The page connects, with permessage-deflate like a browser, and gets the full state.
    let url = format!("ws://127.0.0.1:{port}/api/reviews/{id}/ws");
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.extensions.permessage_deflate = Some(tokio_tungstenite::tungstenite::extensions::compression::deflate::DeflateConfig::default());
    let (mut ws, response) = tokio_tungstenite::connect_async_with_config(&url, Some(config), false).await.unwrap();
    let agreed = response.headers().get("sec-websocket-extensions").map(|v| v.to_str().unwrap().to_owned());
    assert_eq!(agreed.as_deref(), Some("permessage-deflate"), "compression is negotiated");
    // A client that doesn't offer compression works too.
    let (mut plain, response) = tokio_tungstenite::connect_async(&url).await.unwrap();
    assert!(response.headers().get("sec-websocket-extensions").is_none());
    assert_eq!(next_json(&mut plain).await["type"], "state");
    let first = next_json(&mut ws).await;
    assert_eq!(first["type"], "state");
    assert_eq!(first["state"]["threads"].as_array().unwrap().len(), 1);

    // The agent waits; the user comments from the page.
    let waiting = {
        let client = client.peer().clone();
        tokio::spawn(async move { call(&client, "wait_for_feedback", json!({ "timeout_seconds": 20 })).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let comment = json!({ "type": "comment", "threadId": "t-page-00001", "messageId": "m-page-00001", "anchor": { "path": "src/main.rs", "side": "new", "start": 2, "end": 2, "text": "" }, "body": "Why not \"hey\"?" });
    ws.send(Message::Text(comment.to_string().into())).await.unwrap();
    // Sent twice (as after a reconnect): acknowledged twice, applied once.
    ws.send(Message::Text(comment.to_string().into())).await.unwrap();
    let batch = waiting.await.unwrap();
    let item = &batch["items"][0];
    assert_eq!(item["type"], "thread");
    assert_eq!(item["code"], "    println!(\"hello\");");
    let thread_id = item["thread_id"].as_str().unwrap().to_owned();

    // The agent answers in the thread; the page hears it.
    call(&client, "reply", json!({ "thread_id": thread_id, "body": "\"hello\" matches the docs." })).await;
    let mut saw_reply = false;
    for _ in 0..20 {
        let msg = next_json(&mut ws).await;
        if msg["type"] == "thread" && msg["thread"]["messages"].as_array().unwrap().len() == 2 {
            assert_eq!(msg["thread"]["messages"][1]["author"], "agent");
            saw_reply = true;
            break;
        }
    }
    assert!(saw_reply);

    call(&client, "show", json!({ "file": "src/main.rs", "lines": [1, 3], "message": "the whole function" })).await;
    loop {
        let msg = next_json(&mut ws).await;
        if msg["type"] == "show" {
            assert_eq!(msg["request"]["message"], "the whole function");
            break;
        }
    }

    let overview = call(&client, "get_review", json!({})).await;
    assert_eq!(overview["threads"].as_array().unwrap().len(), 2, "the repeated comment made no second thread");
    let err = CallToolRequestParams::new("reply").with_arguments(json!({ "thread_id": "nope", "body": "x" }).as_object().unwrap().clone());
    let result = client.call_tool(err).await.unwrap();
    assert_eq!(result.is_error, Some(true));
    client.cancel().await.unwrap();
}
