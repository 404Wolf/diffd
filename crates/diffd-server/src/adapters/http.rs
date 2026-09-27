//! The web server: pages, the page's WebSocket, a small JSON API, and `/mcp`.

use std::sync::Arc;

use axum::Router;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use diffd_core::model::{Author, ReviewId};
use diffd_core::protocol::{Boot, ClientMsg, ReviewSummary, ServerMsg};
use futures::{SinkExt, StreamExt};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use tokio::sync::broadcast::error::RecvError;

use super::mcp::DiffdMcp;
use crate::app::{App, AppError};

/// Where the page bundle puts the boot data.
const BOOT_MARKER: &str = "<!--diffd-boot-->";

#[derive(Clone)]
struct Web {
    app: Arc<App>,
    template: &'static str,
}

/// Build the router. `template` is the single-file page bundle.
pub fn router(app: Arc<App>, template: &'static str) -> Router {
    let mcp_app = app.clone();
    // The default config already only accepts loopback `Host`s.
    let mcp_config = StreamableHttpServerConfig::default();
    let mcp = StreamableHttpService::new(move || Ok(DiffdMcp::new(mcp_app.clone())), Arc::new(LocalSessionManager::default()), mcp_config);
    let web = Web { app, template };
    Router::new()
        .route("/", get(home))
        .route("/r/{id}", get(review_page))
        .route("/api/reviews", get(list_reviews))
        .route("/api/reviews/{id}", get(review_state).delete(delete_review))
        .route("/api/reviews/{id}/range", get(range))
        .route("/api/reviews/{id}/files", get(repo_files))
        .route("/api/reviews/{id}/context", get(context_file))
        .route("/api/reviews/{id}/ws", get(ws))
        .with_state(web)
        .nest_service("/mcp", mcp)
        .layer(middleware::from_fn(local_only))
}

/// Only answer requests addressed to this machine, and only accept
/// state-changing requests from our own pages. Comments become LLM input, so
/// another website must not be able to post them.
async fn local_only(req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let hostname = host.rsplit_once(':').map_or(host, |(h, port)| if port.chars().all(|c| c.is_ascii_digit()) { h } else { host });
    if !matches!(hostname, "localhost" | "127.0.0.1" | "[::1]") {
        return (StatusCode::FORBIDDEN, "diffd only answers requests for localhost").into_response();
    }
    let is_mcp = req.uri().path().starts_with("/mcp");
    if !is_mcp && let Some(origin) = req.headers().get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        let expected = [format!("http://{host}"), format!("https://{host}")];
        if !expected.iter().any(|e| e == origin) {
            return (StatusCode::FORBIDDEN, "cross-origin requests are not allowed").into_response();
        }
    }
    next.run(req).await
}

fn error_response(e: AppError) -> Response {
    match e {
        AppError::NotFound(m) => (StatusCode::NOT_FOUND, m).into_response(),
        AppError::Invalid(m) => (StatusCode::BAD_REQUEST, m).into_response(),
        AppError::Internal(e) => {
            tracing::error!(error = %format!("{e:#}"), "request failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

/// Render the page with `boot` embedded, escaped so it can't close the script tag.
fn page(template: &str, boot: &Boot, status: StatusCode) -> Response {
    let json = serde_json::to_string(boot).unwrap_or_else(|_| "null".into()).replace('<', "\\u003c");
    let script = format!(r#"<script id="diffd-boot" type="application/json">{json}</script>"#);
    let html = if template.contains(BOOT_MARKER) { template.replacen(BOOT_MARKER, &script, 1) } else { format!("{template}{script}") };
    (status, [(header::CACHE_CONTROL, "no-store")], Html(html)).into_response()
}

async fn recent(app: &App) -> Result<Vec<ReviewSummary>, AppError> {
    Ok(app.store().recent(100).await?.into_iter().map(|(review, unread)| ReviewSummary { review, unread }).collect())
}

async fn home(State(web): State<Web>) -> Response {
    match recent(&web.app).await {
        Ok(reviews) => page(web.template, &Boot::Home { reviews }, StatusCode::OK),
        Err(e) => error_response(e),
    }
}

async fn review_page(State(web): State<Web>, Path(id): Path<String>) -> Response {
    match web.app.state(&ReviewId(id)).await {
        Ok(state) => page(web.template, &Boot::Review { state: Box::new(state) }, StatusCode::OK),
        Err(AppError::NotFound(message)) => page(web.template, &Boot::NotFound { message }, StatusCode::NOT_FOUND),
        Err(e) => error_response(e),
    }
}

async fn list_reviews(State(web): State<Web>) -> Response {
    match recent(&web.app).await {
        Ok(r) => axum::Json(r).into_response(),
        Err(e) => error_response(e),
    }
}

async fn review_state(State(web): State<Web>, Path(id): Path<String>) -> Response {
    match web.app.state(&ReviewId(id)).await {
        Ok(s) => axum::Json(s).into_response(),
        Err(e) => error_response(e),
    }
}

#[derive(serde::Deserialize)]
struct RangeQuery {
    from: String,
    /// A commit; omitted for the working tree.
    to: Option<String>,
}

/// The diff between two points in a review's history.
async fn range(State(web): State<Web>, Path(id): Path<String>, Query(q): Query<RangeQuery>) -> Response {
    match web.app.range(&ReviewId(id), &q.from, q.to).await {
        Ok(snap) => axum::Json(&*snap).into_response(),
        Err(e) => error_response(e),
    }
}

/// Every file in the review's repository, for browsing beyond the diff.
async fn repo_files(State(web): State<Web>, Path(id): Path<String>) -> Response {
    match web.app.repo_files(&ReviewId(id)).await {
        Ok(paths) => axum::Json(paths).into_response(),
        Err(e) => error_response(e),
    }
}

#[derive(serde::Deserialize)]
struct ContextQuery {
    path: String,
}

/// One file outside the diff, highlighted.
async fn context_file(State(web): State<Web>, Path(id): Path<String>, Query(q): Query<ContextQuery>) -> Response {
    match web.app.context_file(&ReviewId(id), &q.path).await {
        Ok(file) => axum::Json(file).into_response(),
        Err(e) => error_response(e),
    }
}

async fn delete_review(State(web): State<Web>, Path(id): Path<String>) -> Response {
    match web.app.delete(&ReviewId(id)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_response(e),
    }
}

/// Browsers always send `Origin` on WebSocket requests, and `local_only` has checked it.
async fn ws(State(web): State<Web>, Path(id): Path<String>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| async move {
        if let Err(e) = session(web.app, ReviewId(id), socket).await {
            tracing::debug!(error = %format!("{e:#}"), "websocket closed");
        }
    })
}

async fn send(tx: &mut futures::stream::SplitSink<WebSocket, WsMessage>, msg: &ServerMsg) -> anyhow::Result<()> {
    tx.send(WsMessage::Text(serde_json::to_string(msg)?.into())).await?;
    Ok(())
}

/// One page's connection: push review events, apply what the page sends.
async fn session(app: Arc<App>, id: ReviewId, socket: WebSocket) -> anyhow::Result<()> {
    let (mut tx, mut rx) = socket.split();
    let mut events = app.subscribe(&id).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let state = app.state(&id).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    send(&mut tx, &ServerMsg::State { state: Box::new(state) }).await?;
    let mut drafting = false;
    let result = loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(msg) => send(&mut tx, &msg).await?,
                Err(RecvError::Lagged(_)) => {
                    let state = app.state(&id).await.map_err(|e| anyhow::anyhow!("{e}"))?;
                    send(&mut tx, &ServerMsg::State { state: Box::new(state) }).await?;
                }
                Err(RecvError::Closed) => break Ok(()),
            },
            incoming = rx.next() => {
                let Some(Ok(frame)) = incoming else { break Ok(()) };
                let WsMessage::Text(text) = frame else { continue };
                match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(msg) => {
                        let ack = msg.ack_id().cloned();
                        match handle(&app, &id, msg, &mut drafting).await {
                            Ok(()) => {
                                if let Some(id) = ack {
                                    send(&mut tx, &ServerMsg::Ack { id }).await?;
                                }
                            }
                            // Invalid requests can never succeed: ack them so the page stops retrying.
                            Err(e @ (AppError::Invalid(_) | AppError::NotFound(_))) => {
                                if let Some(id) = ack {
                                    send(&mut tx, &ServerMsg::Ack { id }).await?;
                                }
                                send(&mut tx, &ServerMsg::Error { message: e.to_string() }).await?;
                            }
                            Err(e) => send(&mut tx, &ServerMsg::Error { message: e.to_string() }).await?,
                        }
                    }
                    Err(e) => send(&mut tx, &ServerMsg::Error { message: format!("bad message: {e}") }).await?,
                }
            }
        }
    };
    if drafting {
        let _ = app.drafting(&id, false).await;
    }
    result
}

async fn handle(app: &App, id: &ReviewId, msg: ClientMsg, drafting: &mut bool) -> Result<(), AppError> {
    match msg {
        ClientMsg::Comment { thread_id, message_id, anchor, body } => {
            app.comment(id, Some((thread_id, message_id)), anchor, &body).await.map(drop)
        }
        ClientMsg::Reply { thread_id, message_id, body } => {
            app.reply(&thread_id, Some(message_id), Author::User, &body, None).await.map(drop)
        }
        ClientMsg::Resolve { thread_id, resolved } => app.resolve(&thread_id, resolved).await.map(drop),
        ClientMsg::Drafting { drafting: on } => {
            if on == *drafting {
                return Ok(());
            }
            *drafting = on;
            app.drafting(id, on).await
        }
        ClientMsg::Chat { message_id, body } => app.chat_user(id, Some(message_id), &body).await,
        ClientMsg::Read { seq } => app.mark_read(id, seq).await,
    }
}
