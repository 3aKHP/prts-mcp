//! HTTP transport: Express-parity routing on `/mcp` + `/health`.
//!
//! Wire contract comes from contracts/wire/ (session lifecycle, era
//! boundary, transport edges, channel captures); every status code and body
//! shape below cites that evidence.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde_json::{json, Map, Value};
use tokio_stream::wrappers::ReceiverStream;

use crate::protocol::dispatch::{self, ConnectionState, StatusHint, WireOutcome};
use crate::protocol::jsonrpc;
use crate::protocol::session::SessionTable;
use crate::tools::output::{parse_channel_with, OutputChannel};
use crate::tools::{AppHandle, ToolEntry};

pub struct Shared {
    pub app: AppHandle,
    pub tools: Arc<Vec<ToolEntry>>,
    pub sessions: Arc<SessionTable>,
    pub env_channel: OutputChannel,
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let mut response = axum::Json(value).into_response();
    *response.status_mut() = status;
    response
}

fn transport_error(status: StatusCode, code: i64, message: &str, id: Value) -> Response {
    json_response(status, jsonrpc::error(id, code, message, None))
}

/// SSE framing exactly as the oracle writes it: one event per message.
fn sse_payload(message: &Value) -> String {
    format!(
        "event: message\ndata: {}\n\n",
        serde_json::to_string(message).unwrap_or_default()
    )
}

fn sse_response(messages: &[Value], session_id: Option<String>) -> Response {
    let mut body = String::new();
    for m in messages {
        body.push_str(&sse_payload(m));
    }
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/event-stream"),
    );
    if let Some(id) = session_id {
        if let Ok(v) = header::HeaderValue::from_str(&id) {
            response.headers_mut().insert("mcp-session-id", v);
        }
    }
    response
}

fn accept_allows_event_stream(accept: Option<&str>) -> bool {
    accept.is_some_and(|a| {
        a.split(',')
            .any(|p| p.trim().starts_with("text/event-stream"))
    })
}

fn accept_allows_json(accept: Option<&str>) -> bool {
    accept.is_some_and(|a| {
        a.split(',')
            .any(|p| p.trim().starts_with("application/json"))
    })
}

fn content_type_is_json(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|ct| {
        ct.split(';')
            .next()
            .is_some_and(|media| media.trim() == "application/json")
    })
}

/// resolveOutputChannel: query value (first string) > header > env; invalid
/// values warn (oracle wording) and fall back to content.
fn resolve_channel(
    query: &std::collections::HashMap<String, String>,
    headers: &HeaderMap,
    env_channel: OutputChannel,
) -> OutputChannel {
    let mut warn = |message: &str| crate::log_warn(message);
    if let Some(value) = query.get("output_channel") {
        return parse_channel_with(Some(value), "output_channel", &mut warn);
    }
    if let Some(value) = headers
        .get("x-prts-output-channel")
        .and_then(|v| v.to_str().ok())
    {
        return parse_channel_with(Some(value), "x-prts-output-channel", &mut warn);
    }
    env_channel
}

fn body_id(body: &Value) -> Value {
    body.get("id").cloned().unwrap_or(Value::Null)
}

/// messages(): a single object or a batch array of messages.
fn messages_of(body: &Value) -> Vec<&Value> {
    match body {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

pub async fn run_http(shared: Arc<Shared>, host: &str, port: u16) -> std::io::Result<()> {
    let app = Router::new()
        .route("/mcp", any(mcp_endpoint))
        .route("/health", axum::routing::get(health))
        .with_state(shared);
    let listener = tokio::net::TcpListener::bind((host, port)).await?;
    crate::log_info(&format!(
        "PRTS MCP Server {} listening on {host}:{port} (StreamableHTTP at /mcp)",
        crate::SERVER_VERSION
    ));
    axum::serve(listener, app).await
}

async fn health() -> Response {
    json_response(StatusCode::OK, json!({ "status": "ok" }))
}

async fn mcp_endpoint(
    State(shared): State<Arc<Shared>>,
    method: Method,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let accept = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok());
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    let session_header = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let modern_version_header = headers
        .get("mcp-protocol-version")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let mcp_method_header = headers
        .get("mcp-method")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    if method == Method::GET {
        return handle_get(shared, accept, session_header).await;
    }
    if method == Method::DELETE {
        return handle_delete(shared, session_header).await;
    }
    if method != Method::POST {
        return transport_error(
            StatusCode::METHOD_NOT_ALLOWED,
            -32000,
            "Method not allowed.",
            Value::Null,
        );
    }

    // Guards in the observed order: media type, then accept.
    if !content_type_is_json(content_type) {
        return transport_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
            Value::Null,
        );
    }
    if !accept_allows_event_stream(accept) || !accept_allows_json(accept) {
        return transport_error(
            StatusCode::NOT_ACCEPTABLE,
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
            Value::Null,
        );
    }

    let body: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            // The oracle answers with an Express HTML error page here; that
            // page is a framework artifact (reported in P1, outside the case
            // set) — this adapter answers with the JSON error family.
            return transport_error(StatusCode::BAD_REQUEST, -32700, "Parse error", Value::Null);
        }
    };

    // Era classification (wire: era-boundary + supplemental probes).
    let messages = messages_of(&body);
    let any_envelope = messages
        .iter()
        .any(|m| m.is_object() && jsonrpc::has_modern_envelope(m));
    let has_modern_headers = modern_version_header.is_some() || mcp_method_header.is_some();

    if any_envelope {
        // Modern headers must agree with the envelope.
        if modern_version_header.is_some() && mcp_method_header.is_none() {
            return json_response(
                    StatusCode::BAD_REQUEST,
                    jsonrpc::error(
                        body_id(&body),
                        -32020,
                        &format!(
                            "Bad Request: the request headers and body disagree: the body names method {} but the required Mcp-Method header is absent",
                            jsonrpc::method_of(messages[0]).unwrap_or("")
                        ),
                        Some(json!({ "mismatch": { "header": "(missing)", "body": format!("the body names method {}", jsonrpc::method_of(messages[0]).unwrap_or("")) } })),
                    ),
                );
        }
        return handle_modern(shared, messages, query, headers).await;
    }
    if has_modern_headers {
        // Modern headers without envelope must not fall back to legacy.
        return json_response(
            StatusCode::BAD_REQUEST,
            jsonrpc::error(
                body_id(&body),
                -32602,
                &format!(
                    "Invalid params: the MCP-Protocol-Version header names protocol revision {}, but the request is missing the required per-request envelope key(s): _meta",
                    modern_version_header.as_deref().unwrap_or_default()
                ),
                Some(json!({ "envelope": { "missing": ["_meta"] } })),
            ),
        );
    }
    handle_legacy_post(shared, body, session_header, query, headers).await
}

async fn handle_get(
    shared: Arc<Shared>,
    accept: Option<&str>,
    session_header: Option<String>,
) -> Response {
    if !accept_allows_event_stream(accept) {
        return transport_error(
            StatusCode::NOT_ACCEPTABLE,
            -32000,
            "Not Acceptable: Client must accept text/event-stream",
            Value::Null,
        );
    }
    let Some(session_id) = session_header else {
        return transport_error(
            StatusCode::BAD_REQUEST,
            -32000,
            "Bad Request: Server not initialized",
            Value::Null,
        );
    };
    if !shared.sessions.contains(&session_id).await {
        return transport_error(
            StatusCode::NOT_FOUND,
            -32002,
            "MCP session lost (server may have restarted for data sync). Please ask the user to disconnect and reconnect the MCP server in the client settings — typically by toggling the MCP connection off and on, or restarting the client application.",
            Value::Null,
        );
    }
    // Hold the SSE stream open; the server has nothing to push (no
    // subscriptions in this protocol slice).
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
    std::mem::forget(tx); // keep the stream open forever
    let stream = ReceiverStream::new(rx);
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/event-stream"),
    );
    response
}

async fn handle_delete(shared: Arc<Shared>, session_header: Option<String>) -> Response {
    let Some(session_id) = session_header else {
        return transport_error(
            StatusCode::BAD_REQUEST,
            -32000,
            "Bad Request: Server not initialized",
            Value::Null,
        );
    };
    if !shared.sessions.contains(&session_id).await {
        return transport_error(
            StatusCode::NOT_FOUND,
            -32002,
            "MCP session lost (server may have restarted for data sync). Please ask the user to disconnect and reconnect the MCP server in the client settings — typically by toggling the MCP connection off and on, or restarting the client application.",
            Value::Null,
        );
    }
    shared.sessions.remove(&session_id).await;
    crate::log_info(&format!("Session {session_id} closed."));
    StatusCode::OK.into_response()
}

async fn handle_modern(
    shared: Arc<Shared>,
    messages: Vec<&Value>,
    query: std::collections::HashMap<String, String>,
    headers: HeaderMap,
) -> Response {
    let channel = resolve_channel(&query, &headers, shared.env_channel);
    let mut responses = Vec::new();
    let mut worst = StatusHint::Ok;
    for message in messages {
        if !message.is_object() {
            responses.push(jsonrpc::error(Value::Null, -32600, "Invalid Request", None));
            worst = worst.max(StatusHint::BadRequest);
            continue;
        }
        let dispatched = dispatch::handle_http_modern(message, channel, &shared.app, &shared.tools);
        let status = dispatched.status_hint;
        match dispatched.outcome {
            WireOutcome::Response(v) => {
                if status == StatusHint::NotFound {
                    worst = worst.max(StatusHint::NotFound);
                }
                responses.push(v);
            }
            WireOutcome::Accepted => {}
        }
    }
    if responses.is_empty() {
        return StatusCode::ACCEPTED.into_response();
    }
    let status = match worst {
        StatusHint::Ok => StatusCode::OK,
        StatusHint::BadRequest => StatusCode::BAD_REQUEST,
        StatusHint::NotFound => StatusCode::NOT_FOUND,
    };
    if responses.len() == 1 {
        json_response(status, responses.remove(0))
    } else {
        json_response(status, Value::Array(responses))
    }
}

async fn handle_legacy_post(
    shared: Arc<Shared>,
    body: Value,
    session_header: Option<String>,
    query: std::collections::HashMap<String, String>,
    headers: HeaderMap,
) -> Response {
    let env_channel = shared.env_channel;
    let channel_for = || resolve_channel(&query, &headers, env_channel);

    match session_header {
        Some(session_id) if shared.sessions.contains(&session_id).await => {
            let Some((mut state, channel)) = shared.sessions.touch(&session_id).await else {
                return transport_error(
                    StatusCode::NOT_FOUND,
                    -32002,
                    "MCP session lost (server may have restarted for data sync). Please ask the user to disconnect and reconnect the MCP server in the client settings — typically by toggling the MCP connection off and on, or restarting the client application.",
                    Value::Null,
                );
            };
            let mut responses = Vec::new();
            let mut protocol_error: Option<Response> = None;
            for message in messages_of(&body) {
                if !message.is_object() {
                    responses.push(jsonrpc::error(Value::Null, -32600, "Invalid Request", None));
                    continue;
                }
                let dispatched = dispatch::handle_http_legacy(
                    &mut state,
                    message,
                    channel,
                    &shared.app,
                    &shared.tools,
                );
                match dispatched.status_hint {
                    StatusHint::BadRequest => {
                        // e.g. double initialize: plain JSON 400, no SSE.
                        let id = jsonrpc::request_id(message);
                        if let WireOutcome::Response(v) = dispatched.outcome {
                            let mut map = Map::new();
                            if let Some(err) = v.get("error") {
                                map.insert("jsonrpc".into(), json!("2.0"));
                                map.insert("error".into(), err.clone());
                                map.insert("id".into(), id);
                            }
                            protocol_error =
                                Some(json_response(StatusCode::BAD_REQUEST, Value::Object(map)));
                        }
                        break;
                    }
                    _ => match dispatched.outcome {
                        WireOutcome::Response(v) => responses.push(v),
                        WireOutcome::Accepted => {}
                    },
                }
            }
            if let Some(error) = protocol_error {
                return error;
            }
            shared.sessions.set_state(&session_id, state).await;
            if responses.is_empty() {
                return StatusCode::ACCEPTED.into_response();
            }
            sse_response(&responses, Some(session_id))
        }
        Some(session_id) => {
            // Unknown session: initialize may recover (strip + fresh session);
            // everything else gets the spec 404.
            let is_init = !body.is_array()
                && body.get("method").and_then(|m| m.as_str()) == Some("initialize");
            if !is_init {
                crate::log_info(&format!("Session {session_id} not found; returning 404."));
                return transport_error(
                    StatusCode::NOT_FOUND,
                    -32002,
                    "MCP session lost (server may have restarted for data sync). Please ask the user to disconnect and reconnect the MCP server in the client settings — typically by toggling the MCP connection off and on, or restarting the client application.",
                    body_id(&body),
                );
            }
            crate::log_info(&format!(
                "Session {session_id} not found; allowing re-initialization."
            ));
            run_fresh_initialize(shared, &body, channel_for()).await
        }
        None => {
            let is_init = !body.is_array()
                && body.get("method").and_then(|m| m.as_str()) == Some("initialize");
            if !is_init {
                // Fresh transport, never initialized: SDK-level 400.
                return transport_error(
                    StatusCode::BAD_REQUEST,
                    -32000,
                    "Bad Request: Server not initialized",
                    Value::Null,
                );
            }
            run_fresh_initialize(shared, &body, channel_for()).await
        }
    }
}

async fn run_fresh_initialize(
    shared: Arc<Shared>,
    body: &Value,
    channel: OutputChannel,
) -> Response {
    let session_id = shared.sessions.create(channel).await;
    crate::log_info(&format!("Session {session_id} initialized."));
    let mut state = ConnectionState::default();
    let dispatched =
        dispatch::handle_http_legacy(&mut state, body, channel, &shared.app, &shared.tools);
    shared.sessions.set_state(&session_id, state).await;
    match dispatched.outcome {
        WireOutcome::Response(v) => sse_response(&[v], Some(session_id)),
        WireOutcome::Accepted => StatusCode::ACCEPTED.into_response(),
    }
}
