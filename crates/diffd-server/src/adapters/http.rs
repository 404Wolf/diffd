//! The web server: pages, the page's WebSocket, a small JSON API, and `/mcp`.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use diffd_core::model::{Author, FileDiff, ReviewId, Revision, Snapshot};
use diffd_core::protocol::{Boot, ClientMsg, ReviewState, ReviewSummary, ServerMsg};
use futures::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use tokio::sync::broadcast::error::RecvError;
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;
use tower_http::compression::CompressionLayer;
use tungstenite::Message as WsMessage;
use tungstenite::extensions::compression::deflate::DeflateConfig;
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::{Role, WebSocketConfig};
use utoipa::{IntoParams, OpenApi};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use super::mcp::DiffdMcp;
use crate::app::{App, AppError, WakeNotice};

/// Where the page bundle puts the boot data.
const BOOT_MARKER: &str = "<!--diffd-boot-->";

#[derive(Clone)]
struct Web {
    app: Arc<App>,
    template: &'static str,
    /// Cancelled when the server stops: long-lived connections end then.
    shutdown: CancellationToken,
}

/// Which `Host`s the review pages answer to. Loopback names always work; a
/// server shared over a private network (a tailnet, say) adds its names here.
/// `/mcp` never uses this list: agents run on this machine, so MCP stays
/// loopback-only however the server is exposed.
#[derive(Debug, Clone, Default)]
pub struct Access {
    /// Extra host names or IP addresses, without ports, matched
    /// case-insensitively.
    pub allowed_hosts: Vec<String>,
}

impl Access {
    fn allows(&self, hostname: &str) -> bool {
        is_loopback(hostname) || self.allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(hostname))
    }
}

fn is_loopback(hostname: &str) -> bool {
    matches!(hostname, "localhost" | "127.0.0.1" | "[::1]")
}

/// Build the router for a localhost-only server. `template` is the
/// single-file page bundle. Cancelling `shutdown` closes WebSockets and MCP
/// sessions (an agent waiting for feedback, say), so a graceful shutdown
/// doesn't wait on them.
pub fn router(app: Arc<App>, template: &'static str, shutdown: CancellationToken) -> Router {
    router_with_access(app, template, shutdown, Access::default())
}

/// [`router`], also answering page requests for the hosts in `access`.
pub fn router_with_access(app: Arc<App>, template: &'static str, shutdown: CancellationToken, access: Access) -> Router {
    let mcp_app = app.clone();
    // The default config already only accepts loopback `Host`s.
    let mut mcp_config = StreamableHttpServerConfig::default();
    mcp_config.cancellation_token = shutdown.child_token();
    let mcp = StreamableHttpService::new(move || Ok(DiffdMcp::new(mcp_app.clone())), Arc::new(LocalSessionManager::default()), mcp_config);
    let web = Web { app, template, shutdown };
    let (api, doc) = api().split_for_parts();
    let doc = Arc::new(doc);
    Router::new()
        .route("/", get(home))
        .route("/r/{id}", get(review_page))
        .route("/api/reviews/{id}/ws", get(ws))
        .route("/api/openapi.json", get(move || std::future::ready(axum::Json(doc.clone()))))
        .merge(api)
        .with_state(web)
        // Pages and JSON, compressed: a review is megabytes of code, and the page may
        // be shared over a network. The WebSocket compresses its own messages, and
        // `/mcp` (nested below, so not covered) streams its answers.
        .layer(CompressionLayer::new())
        .nest_service("/mcp", mcp)
        .layer(middleware::from_fn(move |req, next| local_only(access.clone(), req, next)))
}

/// The JSON API, with its OpenAPI description. The page's client is generated
/// from it (`just gen`), so the two can't drift.
fn api() -> OpenApiRouter<Web> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(list_reviews))
        .routes(routes!(review_state, delete_review))
        .routes(routes!(range))
        .routes(routes!(repo_files))
        .routes(routes!(context_file))
        .routes(routes!(wake, cancel_wake))
}

/// diffd's HTTP API. The WebSocket's messages and the page's boot data aren't
/// HTTP responses, but they're listed as schemas so the page's types all come
/// from here.
#[derive(OpenApi)]
#[openapi(
    info(title = "diffd", description = "Reviews of code changes, between an agent and you."),
    components(schemas(ServerMsg, ClientMsg, Boot))
)]
struct ApiDoc;

/// The OpenAPI description of the JSON API (for generating the page's client).
pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut doc = api().into_openapi();
    if let Some(components) = doc.components.as_mut() {
        for schema in components.schemas.values_mut() {
            every_field_required(schema);
        }
    }
    doc
}

/// Our types always serialize every field (an absent `Option` is `null`), but
/// utoipa lists `Option` fields as not required, which would make them
/// optional in the page's types. Mark every property of every object required.
fn every_field_required(schema: &mut utoipa::openapi::RefOr<utoipa::openapi::Schema>) {
    use utoipa::openapi::schema::{ArrayItems, Schema};
    let utoipa::openapi::RefOr::T(schema) = schema else { return };
    match schema {
        Schema::Object(object) => {
            object.required = object.properties.keys().cloned().collect();
            for property in object.properties.values_mut() {
                every_field_required(property);
            }
        }
        Schema::Array(array) => {
            if let ArrayItems::RefOrSchema(items) = &mut array.items {
                every_field_required(items);
            }
        }
        Schema::OneOf(one) => one.items.iter_mut().for_each(every_field_required),
        Schema::AllOf(all) => all.items.iter_mut().for_each(every_field_required),
        Schema::AnyOf(any) => any.items.iter_mut().for_each(every_field_required),
        _ => {}
    }
}

/// Only answer requests addressed to this machine (or a host in `access`),
/// only let MCP in over loopback, and only accept state-changing requests
/// from our own pages. Comments become LLM input, so another website must not
/// be able to post them.
async fn local_only(access: Access, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let hostname = host.rsplit_once(':').map_or(host, |(h, port)| if port.chars().all(|c| c.is_ascii_digit()) { h } else { host });
    let path = req.uri().path();
    let is_mcp = path.starts_with("/mcp");
    if is_mcp && !is_loopback(hostname) {
        return (StatusCode::FORBIDDEN, "diffd only answers MCP requests for localhost").into_response();
    }
    // The agents' hooks (`diffd hook`) run on this machine, like MCP; and the
    // wake notice quotes the user's comments.
    if path.starts_with("/api/wake") && !is_loopback(hostname) {
        return (StatusCode::FORBIDDEN, "diffd only answers agent hooks for localhost").into_response();
    }
    if !access.allows(hostname) {
        return (StatusCode::FORBIDDEN, "diffd only answers requests for localhost and its configured hosts").into_response();
    }
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

/// Recent reviews, newest first.
#[utoipa::path(get, path = "/api/reviews", responses((status = 200, body = Vec<ReviewSummary>)))]
async fn list_reviews(State(web): State<Web>) -> Response {
    match recent(&web.app).await {
        Ok(r) => axum::Json(r).into_response(),
        Err(e) => error_response(e),
    }
}

/// Everything the page needs to show a review.
#[utoipa::path(get, path = "/api/reviews/{id}", params(("id" = String, Path, description = "The review's id")),
    responses((status = 200, body = ReviewState), (status = 404, body = String)))]
async fn review_state(State(web): State<Web>, Path(id): Path<String>) -> Response {
    match web.app.state(&ReviewId(id)).await {
        Ok(s) => axum::Json(s).into_response(),
        Err(e) => error_response(e),
    }
}

#[derive(serde::Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct RangeQuery {
    from: String,
    /// A commit; omitted for the working tree.
    to: Option<String>,
}

/// The diff between two points in a review's history.
#[utoipa::path(get, path = "/api/reviews/{id}/range", params(("id" = String, Path), RangeQuery),
    responses((status = 200, body = Snapshot), (status = 400, body = String), (status = 404, body = String)))]
async fn range(State(web): State<Web>, Path(id): Path<String>, Query(q): Query<RangeQuery>) -> Response {
    match web.app.range(&ReviewId(id), &q.from, q.to).await {
        Ok(snap) => axum::Json(&*snap).into_response(),
        Err(e) => error_response(e),
    }
}

/// Every file in the review's repository, for browsing beyond the diff.
#[utoipa::path(get, path = "/api/reviews/{id}/files", params(("id" = String, Path)),
    responses((status = 200, body = Vec<String>), (status = 404, body = String)))]
async fn repo_files(State(web): State<Web>, Path(id): Path<String>) -> Response {
    match web.app.repo_files(&ReviewId(id)).await {
        Ok(paths) => axum::Json(paths).into_response(),
        Err(e) => error_response(e),
    }
}

/// Waits longer than this are cut short (the hook just waits again).
const MAX_WAKE_WAIT: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

#[derive(serde::Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct WakeQuery {
    /// The agent's working directory: reviews of that repository wake it.
    cwd: String,
    /// The harness session, e.g. `claude:<session id>`; a newer wait replaces an older one.
    waiter: String,
    timeout_secs: Option<u64>,
}

/// Long-poll until the user leaves feedback an agent here should hear about
/// (200, with the notice), or the wait ends (204). Used by `diffd hook`.
#[utoipa::path(get, path = "/api/wake", params(WakeQuery),
    responses((status = 200, body = WakeNotice), (status = 204, description = "The wait ended with nothing to say")))]
async fn wake(State(web): State<Web>, Query(q): Query<WakeQuery>) -> Response {
    let timeout = q.timeout_secs.map_or(MAX_WAKE_WAIT, std::time::Duration::from_secs).min(MAX_WAKE_WAIT);
    let wait = web.app.wait_for_wake(std::path::Path::new(&q.cwd), &q.waiter, timeout);
    tokio::select! {
        result = wait => match result {
            Ok(Some(notice)) => axum::Json(notice).into_response(),
            Ok(None) => StatusCode::NO_CONTENT.into_response(),
            Err(e) => error_response(e),
        },
        () = web.shutdown.cancelled() => StatusCode::NO_CONTENT.into_response(),
    }
}

#[derive(serde::Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct CancelWakeQuery {
    waiter: String,
}

/// Stop waiting for this waiter (its session ended).
#[utoipa::path(delete, path = "/api/wake", params(CancelWakeQuery), responses((status = 204)))]
async fn cancel_wake(State(web): State<Web>, Query(q): Query<CancelWakeQuery>) -> Response {
    web.app.cancel_wake(&q.waiter);
    StatusCode::NO_CONTENT.into_response()
}

#[derive(serde::Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct ContextQuery {
    path: String,
}

/// One file outside the diff, highlighted.
#[utoipa::path(get, path = "/api/reviews/{id}/context", params(("id" = String, Path), ContextQuery),
    responses((status = 200, body = FileDiff), (status = 400, body = String), (status = 404, body = String)))]
async fn context_file(State(web): State<Web>, Path(id): Path<String>, Query(q): Query<ContextQuery>) -> Response {
    match web.app.context_file(&ReviewId(id), &q.path).await {
        Ok(file) => axum::Json(file).into_response(),
        Err(e) => error_response(e),
    }
}

/// Delete a review, its threads and its history.
#[utoipa::path(delete, path = "/api/reviews/{id}", params(("id" = String, Path, description = "The review's id")),
    responses((status = 204), (status = 404, body = String)))]
async fn delete_review(State(web): State<Web>, Path(id): Path<String>) -> Response {
    match web.app.delete(&ReviewId(id)).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_response(e),
    }
}

/// The page's socket: tungstenite (Signal's fork) over the connection hyper hands over.
type WebSocket = WebSocketStream<TokioIo<hyper::upgrade::Upgraded>>;

/// Upgrade to the page's WebSocket, compressed with permessage-deflate when
/// the browser offers it (they all do). The handshake is done here rather
/// than by axum so the compression can be negotiated.
/// Browsers always send `Origin` on WebSocket requests, and `local_only` has checked it.
async fn ws(State(web): State<Web>, Path(id): Path<String>, Query(q): Query<WsQuery>, mut req: Request) -> Response {
    let headers = req.headers();
    let is_upgrade = headers.get(header::UPGRADE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let version_13 = headers.get(header::SEC_WEBSOCKET_VERSION).is_some_and(|v| v == "13");
    let Some(key) = headers.get(header::SEC_WEBSOCKET_KEY).filter(|_| is_upgrade && version_13).cloned() else {
        return (StatusCode::UPGRADE_REQUIRED, "this endpoint speaks WebSocket (version 13)").into_response();
    };
    let deflate = offers_deflate(headers.get_all(header::SEC_WEBSOCKET_EXTENSIONS));
    let upgrading = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        let io = match upgrading.await {
            Ok(upgraded) => TokioIo::new(upgraded),
            Err(e) => return tracing::debug!(error = %e, "websocket upgrade failed"),
        };
        let mut config = WebSocketConfig::default();
        if deflate {
            config.extensions.permessage_deflate = Some(DeflateConfig::default());
        }
        let socket = WebSocketStream::from_raw_socket(io, Role::Server, Some(config)).await;
        if let Err(e) = session(web.app, ReviewId(id), q.revision, socket, web.shutdown).await {
            tracing::debug!(error = %format!("{e:#}"), "websocket closed");
        }
    });
    let mut res = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_ACCEPT, derive_accept_key(key.as_bytes()));
    if deflate {
        // Default parameters on both sides: 15-bit windows, context takeover.
        res = res.header(header::SEC_WEBSOCKET_EXTENSIONS, "permessage-deflate");
    }
    res.body(axum::body::Body::empty()).expect("a valid response")
}

/// Whether the browser offered permessage-deflate in a form we accept as is
/// (RFC 7692): with no parameters, or only `client_max_window_bits` (a hint
/// we may ignore) and `client_no_context_takeover` (the client's own choice).
/// Offers asking things of the server are declined, and the socket stays uncompressed.
fn offers_deflate(values: axum::http::header::GetAll<'_, axum::http::HeaderValue>) -> bool {
    values.iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(',')).any(|offer| {
        let mut parts = offer.split(';').map(str::trim);
        parts.next() == Some("permessage-deflate")
            && parts.all(|p| matches!(p.split('=').next().map(str::trim), Some("client_max_window_bits" | "client_no_context_takeover")))
    })
}

async fn send(tx: &mut futures::stream::SplitSink<WebSocket, WsMessage>, msg: &ServerMsg) -> anyhow::Result<()> {
    tx.send(WsMessage::Text(serde_json::to_string(msg)?.into())).await?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct WsQuery {
    /// The revision the page already has, if any: its snapshot isn't sent again.
    revision: Option<Revision>,
}

/// Bring a page up to date: everything, or everything but the snapshot when
/// the page already has this revision. Returns the revision the page now has.
async fn catch_up(
    app: &App,
    id: &ReviewId,
    has: Option<Revision>,
    tx: &mut futures::stream::SplitSink<WebSocket, WsMessage>,
) -> anyhow::Result<Revision> {
    let (snapshot, state) = app.live_state(id).await?;
    let revision = snapshot.revision;
    let msg = if has == Some(revision) {
        ServerMsg::Resume { state: Box::new(state) }
    } else {
        ServerMsg::State { state: Box::new(ReviewState::new((*snapshot).clone(), state)) }
    };
    send(tx, &msg).await?;
    Ok(revision)
}

/// One page's connection: push review events, apply what the page sends.
/// `has` is the revision the page already has, if any.
async fn session(app: Arc<App>, id: ReviewId, has: Option<Revision>, socket: WebSocket, shutdown: CancellationToken) -> anyhow::Result<()> {
    let (mut tx, mut rx) = socket.split();
    let mut events = match app.subscribe(&id).await {
        Ok(events) => events,
        Err(e @ AppError::NotFound(_)) => {
            send(&mut tx, &ServerMsg::Gone { message: e.to_string() }).await?;
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };
    let mut has = catch_up(&app, &id, has, &mut tx).await?;
    // Language servers run for the review while this page (or another) shows it.
    let _viewing = app.view(&id).await?;
    // Answers for this page only (language server questions), as opposed to review-wide events.
    let (direct, mut answers) = tokio::sync::mpsc::unbounded_channel::<ServerMsg>();
    let mut drafting = false;
    let result = loop {
        tokio::select! {
            () = shutdown.cancelled() => {
                let _ = tx.send(WsMessage::Close(None)).await;
                break Ok(());
            }
            Some(msg) = answers.recv() => send(&mut tx, &msg).await?,
            event = events.recv() => match event {
                // Revisions come as changes to the one before, which this page may not have.
                Ok(ServerMsg::Revision { delta, .. }) if delta.revision <= has => {}
                Ok(ServerMsg::Revision { delta, .. }) if delta.base != has => has = catch_up(&app, &id, Some(has), &mut tx).await?,
                Ok(msg) => {
                    send(&mut tx, &msg).await?;
                    match msg {
                        ServerMsg::Gone { .. } => break Ok(()),
                        ServerMsg::Revision { delta, .. } => has = delta.revision,
                        _ => {}
                    }
                }
                Err(RecvError::Lagged(_)) => has = catch_up(&app, &id, Some(has), &mut tx).await?,
                // The review's events end only when it's deleted.
                Err(RecvError::Closed) => {
                    send(&mut tx, &ServerMsg::Gone { message: crate::app::DELETED_MESSAGE.into() }).await?;
                    break Ok(());
                }
            },
            incoming = rx.next() => {
                let Some(Ok(frame)) = incoming else { break Ok(()) };
                let WsMessage::Text(text) = frame else { continue };
                let text = text.as_str();
                match serde_json::from_str::<ClientMsg>(text) {
                    // Language servers can take a while: answer in the background, in any order.
                    Ok(ClientMsg::Code { request_id, query, path, line, col }) => {
                        let (app, id, direct) = (app.clone(), id.clone(), direct.clone());
                        tokio::spawn(async move {
                            let answer = match app.code(&id, query, &path, line, col).await {
                                Ok(answer) => answer,
                                Err(e) => diffd_core::model::CodeAnswer::Unavailable { reason: e.to_string() },
                            };
                            let _ = direct.send(ServerMsg::Code { request_id, answer });
                        });
                    }
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
                            // Details of our own failures go to the log, not the page.
                            Err(AppError::Internal(e)) => {
                                tracing::error!(error = %format!("{e:#}"), "a page's request failed");
                                send(&mut tx, &ServerMsg::Error { message: "diffd hit an internal error; its log has the details".into() }).await?;
                            }
                        }
                    }
                    Err(e) => send(&mut tx, &ServerMsg::Error { message: format!("bad message: {e}") }).await?,
                }
            }
        }
    };
    if drafting && let Err(e) = app.drafting(&id, false).await {
        tracing::debug!(review = %id, error = %e, "couldn't end the draft of a page that left");
    }
    result
}

async fn handle(app: &App, id: &ReviewId, msg: ClientMsg, drafting: &mut bool) -> Result<(), AppError> {
    match msg {
        ClientMsg::Comment { thread_id, message_id, anchor, body } => {
            app.comment(id, Some((thread_id, message_id)), anchor, &body).await.map(drop)
        }
        ClientMsg::Reply { thread_id, message_id, body } => {
            app.check_thread_in(id, &thread_id).await?;
            app.reply(&thread_id, Some(message_id), Author::User, &body, None).await.map(drop)
        }
        ClientMsg::Resolve { thread_id, resolved } => {
            app.check_thread_in(id, &thread_id).await?;
            app.resolve(&thread_id, resolved).await.map(drop)
        }
        ClientMsg::Drafting { drafting: on } => {
            if on == *drafting {
                return Ok(());
            }
            *drafting = on;
            app.drafting(id, on).await
        }
        ClientMsg::Chat { message_id, body } => app.chat_user(id, Some(message_id), &body).await,
        ClientMsg::Read { seq } => app.mark_read(id, seq).await,
        // Answered in `session`, off the message loop.
        ClientMsg::Code { .. } => Ok(()),
    }
}
