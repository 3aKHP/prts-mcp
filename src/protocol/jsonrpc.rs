//! JSON-RPC message shaping for the thin adapter.
//!
//! Key order follows the oracle's most common shapes; the differential
//! comparator ignores object key order, so consistency matters more than
//! byte-matching a particular capture.

use serde_json::{json, Map, Value};

pub fn request_id(message: &Value) -> Value {
    message.get("id").cloned().unwrap_or(Value::Null)
}

pub fn is_notification(message: &Value) -> bool {
    message.get("id").is_none()
}

/// Build a success response `{jsonrpc, id, result}`.
pub fn response(id: Value, result: Value) -> Value {
    let mut map = Map::new();
    map.insert("jsonrpc".into(), json!("2.0"));
    map.insert("id".into(), id);
    map.insert("result".into(), result);
    Value::Object(map)
}

/// Build an error response `{jsonrpc, id, error{code,message[,data]}}`.
pub fn error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut err = Map::new();
    err.insert("code".into(), json!(code));
    err.insert("message".into(), json!(message));
    if let Some(data) = data {
        err.insert("data".into(), data);
    }
    let mut map = Map::new();
    map.insert("jsonrpc".into(), json!("2.0"));
    map.insert("id".into(), id);
    map.insert("error".into(), Value::Object(err));
    Value::Object(map)
}

/// Extract `method`/`params` from a parsed message.
pub fn method_of(message: &Value) -> Option<&str> {
    message.get("method").and_then(|m| m.as_str())
}

pub fn params_of(message: &Value) -> Option<&Value> {
    message.get("params")
}

/// Whether the message carries the modern per-request envelope (the
/// `io.modelcontextprotocol/protocolVersion` key inside `params._meta`).
/// An empty `_meta: {}` does NOT count — verified against the oracle.
pub fn has_modern_envelope(message: &Value) -> bool {
    message
        .get("params")
        .and_then(|p| p.get("_meta"))
        .and_then(|m| m.get(super::ENVELOPE_PROTOCOL_VERSION))
        .is_some()
}

pub fn envelope_version(message: &Value) -> Option<String> {
    message
        .get("params")
        .and_then(|p| p.get("_meta"))
        .and_then(|m| m.get(super::ENVELOPE_PROTOCOL_VERSION))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_detection_ignores_empty_meta() {
        let with_envelope: Value =
            serde_json::from_str(r#"{"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#).unwrap();
        assert!(has_modern_envelope(&with_envelope));
        let empty_meta: Value = serde_json::from_str(
            r#"{"method":"tools/call","params":{"name":"list_stages","arguments":{},"_meta":{}}}"#,
        )
        .unwrap();
        assert!(!has_modern_envelope(&empty_meta));
        let no_meta: Value =
            serde_json::from_str(r#"{"method":"tools/list","params":{}}"#).unwrap();
        assert!(!has_modern_envelope(&no_meta));
    }
}
