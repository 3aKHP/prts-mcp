//! Shared message router: one code path serves HTTP (both eras) and stdio,
//! parameterized by per-connection/session state and the resolved channel.

use serde_json::{json, Map, Value};

use super::jsonrpc;
use super::{
    ENVELOPE_CLIENT_CAPABILITIES, ENVELOPE_CLIENT_INFO, ENVELOPE_PROTOCOL_VERSION,
    LEGACY_FALLBACK_VERSION, LEGACY_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSION,
};
use crate::tools::output::OutputChannel;
use crate::tools::{AppHandle, ToolEntry};

/// Per-connection (stdio) / per-session (HTTP legacy) protocol state.
#[derive(Default, Clone)]
pub struct ConnectionState {
    pub legacy_initialized: bool,
    pub modern_established: bool,
}

/// What a processed message yields for the transport layer.
pub enum WireOutcome {
    /// JSON-RPC response to send (era + transport decide framing/status).
    Response(Value),
    /// Notification accepted — HTTP 202 / stdio silence.
    Accepted,
}

/// Transport-level annotations an error may carry (status codes differ by
/// era; see contracts/wire for the mapping evidence).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum StatusHint {
    Ok,
    BadRequest,
    NotFound,
}

pub struct Dispatched {
    pub outcome: WireOutcome,
    pub status_hint: StatusHint,
}

fn server_info() -> Value {
    json!({
        "name": crate::SERVER_NAME,
        "version": crate::SERVER_VERSION,
    })
}

fn initialize_result(requested: &str) -> Value {
    let negotiated = if LEGACY_PROTOCOL_VERSIONS.contains(&requested) {
        requested
    } else {
        LEGACY_FALLBACK_VERSION
    };
    json!({
        "protocolVersion": negotiated,
        "capabilities": { "tools": { "listChanged": true } },
        "serverInfo": server_info(),
    })
}

fn discover_result() -> Value {
    json!({
        "supportedVersions": [MODERN_PROTOCOL_VERSION],
        "capabilities": { "tools": { "listChanged": true } },
        "resultType": "complete",
        "ttlMs": 0,
        "cacheScope": "private",
        "_meta": { "io.modelcontextprotocol/serverInfo": server_info() },
    })
}

/// The SDK-level `Invalid tools/call request: [...]` pretty-printed zod issue.
fn invalid_tools_call_issue(expected: &str, path: &[&str], received: &str) -> String {
    let mut path_arr = Vec::new();
    for p in path {
        path_arr.push(json!(p));
    }
    let issue = json!({
        "expected": expected,
        "code": "invalid_type",
        "path": path_arr,
        "message": format!("Invalid input: expected {expected}, received {received}"),
    });
    format!(
        "Invalid tools/call request: {}",
        serde_json::to_string_pretty(&json!([issue])).unwrap_or_default()
    )
}

fn js_received(value: Option<&Value>) -> &str {
    match value {
        None => "undefined",
        Some(v) => match v {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        },
    }
}

fn tools_list_result(tools: &[ToolEntry]) -> Value {
    let declarations: Vec<Value> = tools.iter().map(|t| t.declaration.clone()).collect();
    json!({ "tools": declarations })
}

/// Modern-era responses carry stateless metadata (wire: modern-flow +
/// stdio-modern transcripts): `resultType: "complete"` always; tools/list and
/// discover additionally carry `ttlMs`/`cacheScope`; `_meta.serverInfo`
/// everywhere — including isError tool results (golden:
/// stage.list.modern.limit-schema-reject). Legacy responses carry none.
fn modernize_result(mut result: Value, include_cache_fields: bool) -> Value {
    if let Some(map) = result.as_object_mut() {
        map.insert("resultType".into(), json!("complete"));
        if include_cache_fields {
            map.insert("ttlMs".into(), json!(0));
            map.insert("cacheScope".into(), json!("private"));
        }
        map.insert(
            "_meta".into(),
            json!({ "io.modelcontextprotocol/serverInfo": server_info() }),
        );
    }
    result
}

/// Handle one already-classified legacy message on an established connection.
fn handle_legacy_message(
    state: &mut ConnectionState,
    message: &Value,
    channel: OutputChannel,
    app: &AppHandle,
    tools: &[ToolEntry],
) -> Dispatched {
    let id = jsonrpc::request_id(message);
    let method = jsonrpc::method_of(message).unwrap_or("");
    let params = jsonrpc::params_of(message);

    match method {
        "initialize" => {
            if state.legacy_initialized {
                return Dispatched {
                    outcome: WireOutcome::Response(jsonrpc::error(
                        id,
                        -32600,
                        "Invalid Request: Server already initialized",
                        None,
                    )),
                    status_hint: StatusHint::BadRequest,
                };
            }
            state.legacy_initialized = true;
            let requested = params
                .and_then(|p| p.get("protocolVersion"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Dispatched {
                outcome: WireOutcome::Response(jsonrpc::response(id, initialize_result(requested))),
                status_hint: StatusHint::Ok,
            }
        }
        "notifications/initialized" => Dispatched {
            outcome: WireOutcome::Accepted,
            status_hint: StatusHint::Ok,
        },
        "tools/list" => Dispatched {
            outcome: WireOutcome::Response(jsonrpc::response(id, tools_list_result(tools))),
            status_hint: StatusHint::Ok,
        },
        "tools/call" => {
            let Some(params) = params.filter(|p| p.is_object()) else {
                return Dispatched {
                    outcome: WireOutcome::Response(jsonrpc::error(
                        id,
                        -32602,
                        &invalid_tools_call_issue("object", &["params"], js_received(params)),
                        None,
                    )),
                    status_hint: StatusHint::Ok,
                };
            };
            let name = params.get("name");
            let Some(name) = name.and_then(|v| v.as_str()) else {
                return Dispatched {
                    outcome: WireOutcome::Response(jsonrpc::error(
                        id,
                        -32602,
                        &invalid_tools_call_issue("string", &["params", "name"], js_received(name)),
                        None,
                    )),
                    status_hint: StatusHint::Ok,
                };
            };
            // arguments absent → {} (defaults apply); present-but-not-record → error.
            let arguments = match params.get("arguments") {
                None => json!({}),
                Some(v) if v.is_object() => v.clone(),
                Some(v) => {
                    return Dispatched {
                        outcome: WireOutcome::Response(jsonrpc::error(
                            id,
                            -32602,
                            &invalid_tools_call_issue(
                                "record",
                                &["params", "arguments"],
                                js_received(Some(v)),
                            ),
                            None,
                        )),
                        status_hint: StatusHint::Ok,
                    };
                }
            };
            let Some(tool) = tools.iter().find(|t| t.name == name) else {
                return Dispatched {
                    outcome: WireOutcome::Response(jsonrpc::error(
                        id,
                        -32602,
                        &format!("Tool {name} not found"),
                        None,
                    )),
                    status_hint: StatusHint::Ok,
                };
            };
            let result = (tool.dispatch)(app, &arguments);
            let rendered = match result {
                crate::tools::DispatchResult::Outcome(outcome) => outcome.render(channel),
                crate::tools::DispatchResult::RpcError(code, message) => {
                    return Dispatched {
                        outcome: WireOutcome::Response(jsonrpc::error(id, code, &message, None)),
                        status_hint: StatusHint::Ok,
                    };
                }
            };
            Dispatched {
                outcome: WireOutcome::Response(jsonrpc::response(id, rendered)),
                status_hint: StatusHint::Ok,
            }
        }
        _ if jsonrpc::is_notification(message) => {
            // Unknown notifications on an established session: 202, no body.
            Dispatched {
                outcome: WireOutcome::Accepted,
                status_hint: StatusHint::Ok,
            }
        }
        _ => Dispatched {
            outcome: WireOutcome::Response(jsonrpc::error(id, -32601, "Method not found", None)),
            status_hint: StatusHint::NotFound,
        },
    }
}

/// Envelope validation for modern messages (wire: era-boundary + stderr of
/// the oracle runs). Returns Err(error_response) when the envelope is bad.
fn validate_modern_envelope(message: &Value) -> Result<(), (Value, StatusHint)> {
    let id = jsonrpc::request_id(message);
    let meta = message
        .get("params")
        .and_then(|p| p.get("_meta"))
        .cloned()
        .unwrap_or(json!({}));
    for key in [
        ENVELOPE_PROTOCOL_VERSION,
        ENVELOPE_CLIENT_INFO,
        ENVELOPE_CLIENT_CAPABILITIES,
    ] {
        if meta.get(key).is_none() {
            return Err((
                jsonrpc::error(
                    id,
                    -32602,
                    &format!(
                        "Invalid _meta envelope for protocol revision {MODERN_PROTOCOL_VERSION}: {key}: missing"
                    ),
                    Some(json!({ "envelope": { "key": key, "problem": "missing" } })),
                ),
                StatusHint::BadRequest,
            ));
        }
    }
    let version = jsonrpc::envelope_version(message).unwrap_or_default();
    if version != MODERN_PROTOCOL_VERSION {
        return Err((
            jsonrpc::error(
                id,
                -32022,
                &format!("Unsupported protocol version: {version}"),
                Some(json!({ "supported": [MODERN_PROTOCOL_VERSION], "requested": version })),
            ),
            StatusHint::BadRequest,
        ));
    }
    Ok(())
}

/// Handle a modern-envelope message (stateless).
fn handle_modern_message(
    message: &Value,
    channel: OutputChannel,
    app: &AppHandle,
    tools: &[ToolEntry],
) -> Dispatched {
    let id = jsonrpc::request_id(message);
    if let Err((error, hint)) = validate_modern_envelope(message) {
        return Dispatched {
            outcome: WireOutcome::Response(error),
            status_hint: hint,
        };
    }
    let method = jsonrpc::method_of(message).unwrap_or("");
    let params = jsonrpc::params_of(message);
    match method {
        "server/discover" => Dispatched {
            outcome: WireOutcome::Response(jsonrpc::response(id, discover_result())),
            status_hint: StatusHint::Ok,
        },
        "initialize" => Dispatched {
            // Modern has no initialize; the oracle answers 404 + -32601.
            outcome: WireOutcome::Response(jsonrpc::error(id, -32601, "Method not found", None)),
            status_hint: StatusHint::NotFound,
        },
        "tools/list" => Dispatched {
            outcome: WireOutcome::Response(jsonrpc::response(
                id,
                modernize_result(tools_list_result(tools), true),
            )),
            status_hint: StatusHint::Ok,
        },
        "tools/call" => {
            let Some(params) = params.filter(|p| p.is_object()) else {
                return Dispatched {
                    outcome: WireOutcome::Response(jsonrpc::error(
                        id,
                        -32602,
                        &invalid_tools_call_issue("object", &["params"], js_received(params)),
                        None,
                    )),
                    status_hint: StatusHint::Ok,
                };
            };
            let name = params.get("name");
            let Some(name) = name.and_then(|v| v.as_str()) else {
                return Dispatched {
                    outcome: WireOutcome::Response(jsonrpc::error(
                        id,
                        -32602,
                        &invalid_tools_call_issue("string", &["params", "name"], js_received(name)),
                        None,
                    )),
                    status_hint: StatusHint::Ok,
                };
            };
            let arguments = match params.get("arguments") {
                None => json!({}),
                Some(v) if v.is_object() => v.clone(),
                Some(v) => {
                    return Dispatched {
                        outcome: WireOutcome::Response(jsonrpc::error(
                            id,
                            -32602,
                            &invalid_tools_call_issue(
                                "record",
                                &["params", "arguments"],
                                js_received(Some(v)),
                            ),
                            None,
                        )),
                        status_hint: StatusHint::Ok,
                    };
                }
            };
            let Some(tool) = tools.iter().find(|t| t.name == name) else {
                return Dispatched {
                    outcome: WireOutcome::Response(jsonrpc::error(
                        id,
                        -32602,
                        &format!("Tool {name} not found"),
                        None,
                    )),
                    status_hint: StatusHint::Ok,
                };
            };
            let result = (tool.dispatch)(app, &arguments);
            let rendered = match result {
                crate::tools::DispatchResult::Outcome(outcome) => outcome.render(channel),
                crate::tools::DispatchResult::RpcError(code, message) => {
                    return Dispatched {
                        outcome: WireOutcome::Response(jsonrpc::error(id, code, &message, None)),
                        status_hint: StatusHint::Ok,
                    };
                }
            };
            Dispatched {
                outcome: WireOutcome::Response(jsonrpc::response(
                    id,
                    modernize_result(rendered, false),
                )),
                status_hint: StatusHint::Ok,
            }
        }
        _ if jsonrpc::is_notification(message) => Dispatched {
            outcome: WireOutcome::Accepted,
            status_hint: StatusHint::Ok,
        },
        _ => Dispatched {
            outcome: WireOutcome::Response(jsonrpc::error(id, -32601, "Method not found", None)),
            status_hint: StatusHint::NotFound,
        },
    }
}

/// Entry point for stdio: one line = one message; era follows the observed
/// rules (modern envelope works on a legacy connection; a legacy initialize
/// after modern is established is rejected with -32022).
pub fn handle_stdio_message(
    state: &mut ConnectionState,
    message: &Value,
    channel: OutputChannel,
    app: &AppHandle,
    tools: &[ToolEntry],
) -> Option<Value> {
    if jsonrpc::has_modern_envelope(message) {
        state.modern_established = true;
        let dispatched = handle_modern_message(message, channel, app, tools);
        return match dispatched.outcome {
            WireOutcome::Response(v) => Some(v),
            WireOutcome::Accepted => None,
        };
    }
    let id = jsonrpc::request_id(message);
    if jsonrpc::method_of(message) == Some("initialize") && state.modern_established {
        let requested = message
            .get("params")
            .and_then(|p| p.get("protocolVersion"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return Some(jsonrpc::error(
            id,
            -32022,
            &format!("Unsupported protocol version: {requested}"),
            Some(json!({ "supported": [MODERN_PROTOCOL_VERSION], "requested": requested })),
        ));
    }
    let dispatched = handle_legacy_message(state, message, channel, app, tools);
    match dispatched.outcome {
        WireOutcome::Response(v) => Some(v),
        WireOutcome::Accepted => None,
    }
}

/// Legacy HTTP entry point on a live session.
pub fn handle_http_legacy(
    state: &mut ConnectionState,
    message: &Value,
    channel: OutputChannel,
    app: &AppHandle,
    tools: &[ToolEntry],
) -> Dispatched {
    handle_legacy_message(state, message, channel, app, tools)
}

/// Modern HTTP entry point (stateless).
pub fn handle_http_modern(
    message: &Value,
    channel: OutputChannel,
    app: &AppHandle,
    tools: &[ToolEntry],
) -> Dispatched {
    handle_modern_message(message, channel, app, tools)
}

/// JSON of a Map helper used by tests to keep imports tidy.
#[allow(dead_code)]
fn _map() -> Map<String, Value> {
    Map::new()
}
