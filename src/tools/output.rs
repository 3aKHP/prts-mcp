//! Unified result wrapping — port of TS `output.ts`.
//!
//! content: full Markdown only; both: Markdown + structuredContent;
//! structured: short summary text + structuredContent. Errors and narrative
//! text results stay text-only regardless of channel.

use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputChannel {
    Content,
    Structured,
    Both,
}

impl OutputChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            OutputChannel::Content => "content",
            OutputChannel::Structured => "structured",
            OutputChannel::Both => "both",
        }
    }
}

/// parseChannel: trim + lowercase against the closed set; anything else
/// (including the empty string) falls back to content. The Chinese warning
/// mirrors the oracle verbatim for stderr parity.
pub fn parse_channel(raw: Option<&str>) -> OutputChannel {
    parse_channel_with(raw, "PRTS_OUTPUT_CHANNEL", &mut |message| {
        eprintln!("{message}");
    })
}

pub fn parse_channel_with(
    raw: Option<&str>,
    source: &str,
    warn: &mut dyn FnMut(&str),
) -> OutputChannel {
    let Some(raw) = raw else {
        return OutputChannel::Content;
    };
    if raw.is_empty() {
        return OutputChannel::Content;
    }
    let value = raw.trim().to_lowercase();
    match value.as_str() {
        "content" => OutputChannel::Content,
        "structured" => OutputChannel::Structured,
        "both" => OutputChannel::Both,
        _ => {
            warn(&format!(
                "{source}={} 不合法（可选 content/structured/both），回退到 content。",
                serde_json::to_string(raw).unwrap_or_default()
            ));
            OutputChannel::Content
        }
    }
}

/// A tool result before channel wrapping: full Markdown, optional structured
/// payload, optional explicit summary override, isError flag, and the
/// artwork image block (kept after the text block on EVERY channel).
pub struct ToolOutcome {
    pub markdown: String,
    pub structured: Option<Value>,
    pub summary_override: Option<String>,
    pub is_error: bool,
    pub image: Option<ImageBlock>,
}

/// One MCP image content block: standard base64 + MIME.
#[derive(Clone)]
pub struct ImageBlock {
    pub data: String,
    pub mime: String,
}

impl ToolOutcome {
    pub fn text(markdown: impl Into<String>) -> Self {
        Self {
            markdown: markdown.into(),
            structured: None,
            summary_override: None,
            is_error: false,
            image: None,
        }
    }

    /// `renderImageResult`: image block after the text on every channel;
    /// structured mode summarizes the text and keeps structuredContent.
    pub fn image_result(
        markdown: impl Into<String>,
        structured: Option<Value>,
        summary: Option<String>,
        image: ImageBlock,
    ) -> Self {
        Self {
            markdown: markdown.into(),
            structured,
            summary_override: summary,
            is_error: false,
            image: Some(image),
        }
    }

    pub fn structured(markdown: impl Into<String>, structured: Value) -> Self {
        Self {
            markdown: markdown.into(),
            structured: Some(structured),
            summary_override: None,
            is_error: false,
            image: None,
        }
    }

    pub fn error_text(markdown: impl Into<String>) -> Self {
        Self {
            is_error: true,
            ..Self::text(markdown)
        }
    }

    /// Wrap into a CallToolResult JSON object with the oracle's key order
    /// (content, structuredContent, isError — serde_json preserve_order).
    pub fn render(&self, channel: OutputChannel) -> Value {
        let image_block = self
            .image
            .as_ref()
            .map(|image| json!({ "type": "image", "data": image.data, "mimeType": image.mime }));
        let text_body = |text: &str| -> Value {
            let mut blocks = vec![content_block(text)];
            if let Some(image) = &image_block {
                blocks.push(image.clone());
            }
            Value::Array(blocks)
        };
        let Some(data) = self.structured.as_ref() else {
            let mut map = Map::new();
            map.insert("content".into(), text_body(&self.markdown));
            if self.is_error {
                map.insert("isError".into(), Value::Bool(true));
            }
            return Value::Object(map);
        };
        match channel {
            OutputChannel::Content => {
                let mut map = Map::new();
                map.insert("content".into(), text_body(&self.markdown));
                if self.is_error {
                    map.insert("isError".into(), Value::Bool(true));
                }
                Value::Object(map)
            }
            OutputChannel::Both => {
                let mut map = Map::new();
                map.insert("content".into(), text_body(&self.markdown));
                map.insert("structuredContent".into(), data.clone());
                if self.is_error {
                    map.insert("isError".into(), Value::Bool(true));
                }
                Value::Object(map)
            }
            OutputChannel::Structured => {
                let mut map = Map::new();
                map.insert(
                    "content".into(),
                    text_body(&summarize(data, self.summary_override.as_deref())),
                );
                map.insert("structuredContent".into(), data.clone());
                if self.is_error {
                    map.insert("isError".into(), Value::Bool(true));
                }
                Value::Object(map)
            }
        }
    }

    /// Consume a dispatched result without copying its payload. Summary
    /// generation borrows the structured data before it moves into the result.
    pub fn into_result(self, channel: OutputChannel) -> Value {
        let text = match (&self.structured, channel) {
            (Some(data), OutputChannel::Structured) => {
                summarize(data, self.summary_override.as_deref())
            }
            _ => self.markdown,
        };
        let mut text_block = Map::new();
        text_block.insert("type".into(), Value::String("text".into()));
        text_block.insert("text".into(), Value::String(text));
        let mut blocks = vec![Value::Object(text_block)];
        if let Some(image) = self.image {
            let mut block = Map::new();
            block.insert("type".into(), Value::String("image".into()));
            block.insert("data".into(), Value::String(image.data));
            block.insert("mimeType".into(), Value::String(image.mime));
            blocks.push(Value::Object(block));
        }
        let mut result = Map::new();
        result.insert("content".into(), Value::Array(blocks));
        if channel != OutputChannel::Content {
            if let Some(data) = self.structured {
                result.insert("structuredContent".into(), data);
            }
        }
        if self.is_error {
            result.insert("isError".into(), Value::Bool(true));
        }
        Value::Object(result)
    }
}

fn content_block(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

/// summarize(): explicit override, else the integer `total` wording, else the
/// generic wording — byte-identical to output.ts.
fn summarize(data: &Value, summary: Option<&str>) -> String {
    if let Some(s) = summary {
        return s.to_string();
    }
    if let Some(total) = data.get("total") {
        if let Some(n) = total.as_i64() {
            return format!("（结构化结果共 {n} 条，详见 structuredContent）");
        }
        if let Some(f) = total.as_f64() {
            if f.fract() == 0.0 && f.is_finite() {
                // JS Number.isInteger sees integral floats as integers.
                return format!("（结构化结果共 {f:.0} 条，详见 structuredContent）");
            }
        }
    }
    "（结构化结果详见 structuredContent）".to_string()
}

/// Wrapped CallToolResult JSON object.
#[allow(dead_code)]
pub fn render_result(outcome: &ToolOutcome, channel: OutputChannel) -> Value {
    outcome.render(channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consuming_render_matches_borrowed_bytes_for_all_channels() {
        let payloads = [
            None,
            Some(Value::Null),
            Some(json!([])),
            Some(json!(false)),
            Some(json!({"z":null,"a":["🙂",{"total":2}]})),
            Some(json!({"total":4})),
            Some(json!({"total":4.0})),
            Some(json!({"total":4.5})),
            Some(json!({"total":"4"})),
        ];
        for structured in payloads {
            for summary in [None, Some(""), Some("摘要🙂\n")] {
                for error in [false, true] {
                    for image in [false, true] {
                        for channel in [
                            OutputChannel::Content,
                            OutputChannel::Structured,
                            OutputChannel::Both,
                        ] {
                            let outcome = ToolOutcome {
                                markdown: "# 正文\n🙂".into(),
                                structured: structured.clone(),
                                summary_override: summary.map(str::to_owned),
                                is_error: error,
                                image: image.then(|| ImageBlock {
                                    data: "AA+/==".into(),
                                    mime: "image/png".into(),
                                }),
                            };
                            let expected = serde_json::to_vec(&outcome.render(channel)).unwrap();
                            assert_eq!(
                                expected,
                                serde_json::to_vec(&outcome.into_result(channel)).unwrap()
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn parse_channel_variants() {
        let mut warnings = Vec::new();
        let mut warn = |m: &str| warnings.push(m.to_string());
        assert_eq!(
            parse_channel_with(None, "x", &mut warn),
            OutputChannel::Content
        );
        assert_eq!(
            parse_channel_with(Some(""), "x", &mut warn),
            OutputChannel::Content
        );
        assert_eq!(
            parse_channel_with(Some(" both "), "x", &mut warn),
            OutputChannel::Both
        );
        assert_eq!(
            parse_channel_with(Some("STRUCTURED",), "x", &mut warn),
            OutputChannel::Structured
        );
        assert_eq!(
            parse_channel_with(Some("nonsense",), "x", &mut warn),
            OutputChannel::Content
        );
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("nonsense"));
        assert!(warnings[0].contains("不合法"));
    }

    #[test]
    fn channel_wrapping_shapes() {
        let outcome = ToolOutcome::structured("# MD", json!({"total": 4}));
        let content = render_result(&outcome, OutputChannel::Content);
        assert_eq!(content["content"][0]["text"], "# MD");
        assert!(content.get("structuredContent").is_none());

        let both = render_result(&outcome, OutputChannel::Both);
        assert_eq!(both["content"][0]["text"], "# MD");
        assert_eq!(both["structuredContent"]["total"], 4);

        let structured = render_result(&outcome, OutputChannel::Structured);
        assert_eq!(
            structured["content"][0]["text"],
            "（结构化结果共 4 条，详见 structuredContent）"
        );
        assert_eq!(structured["structuredContent"]["total"], 4);
    }
}
