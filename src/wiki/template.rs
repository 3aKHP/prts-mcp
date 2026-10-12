//! Template extraction and batch rendering — port of TS
//! `api/templateRenderer.ts` plus `renderTemplateBatch` from prtsWiki.ts.
//!
//! The XML document model mirrors fast-xml-parser's preserveOrder output
//! (see `template_xml`); the marker protocol (PRTSMCP_<uuid>_BEGIN_<i>_)
//! batches every needs-render field into ONE POST so server-side template
//! expansion sees a single page context, then slices the rendered text back
//! apart. Markers must never leak into the final tool text.

use serde_json::Value;
use uuid::Uuid;

use super::client::WikiTransport;
use super::template_xml::{parse_lenient, XmlNode};

/// Tool-facing failure; the message is the TS error text.
#[derive(Debug)]
pub struct TemplateRenderError(pub String);

impl TemplateRenderError {
    fn invalid_format() -> Self {
        Self("页面模板数据格式无效。".to_string())
    }
}

/// prts_page(template) error layering: TemplateRenderError instances get the
/// tool's fixed advice message (the original text is discarded), while plain
/// errors surface bare — exactly the `e instanceof TemplateRenderError` split
/// in prtsTools.ts.
pub enum WikiError {
    Template(TemplateRenderError),
    Plain(String),
}

// --- FXP preserveOrder shims over XmlNode ------------------------------------

/// `elements(content, tag)`: every child element with this tag, in order.
fn elements<'a>(content: &'a [XmlNode], tag: &str) -> Vec<&'a XmlNode> {
    content
        .iter()
        .filter(|n| matches!(n, XmlNode::Element { tag: t, .. } if t == tag))
        .collect()
}

fn first_element<'a>(content: &'a [XmlNode], tag: &str) -> Option<&'a XmlNode> {
    elements(content, tag).into_iter().next()
}

fn attrs_of(node: &XmlNode) -> &[(String, String)] {
    match node {
        XmlNode::Element { attrs, .. } => attrs,
        _ => &[],
    }
}

fn children_of(node: &XmlNode) -> &[XmlNode] {
    match node {
        XmlNode::Element { children, .. } => children,
        _ => &[],
    }
}

/// Concatenate text of this subtree, skipping comments: both XML-level
/// `#comment` nodes and wikitext `<comment>` elements are excluded (the TS
/// skip list names both), every other element child is entered.
fn text_without_comments(content: &[XmlNode]) -> String {
    let mut text = String::new();
    for node in content {
        match node {
            XmlNode::Text(t) => text.push_str(t),
            XmlNode::Comment(_) => {}
            XmlNode::Element { tag, children, .. } if tag == "comment" => {}
            XmlNode::Element { children, .. } => text.push_str(&text_without_comments(children)),
        }
    }
    text
}

fn has_attr(node: &XmlNode, name: &str) -> bool {
    attrs_of(node).iter().any(|(k, _)| k == name)
}

// --- wikitext reconstruction --------------------------------------------------

fn part_to_wikitext(part: &XmlNode) -> Result<String, TemplateRenderError> {
    let content = children_of(part);
    let value = first_element(content, "value")
        .ok_or_else(|| TemplateRenderError("模板字段缺少 value 节点。".to_string()))?;
    let rendered_value = content_to_wikitext(children_of(value))?;
    let name = first_element(content, "name");
    match name {
        None => Ok(format!("|{rendered_value}")),
        Some(n) if has_attr(n, "index") => Ok(format!("|{rendered_value}")),
        Some(n) => {
            let rendered_name = text_without_comments(children_of(n)).trim().to_string();
            if rendered_name.is_empty() {
                Ok(format!("|{rendered_value}"))
            } else {
                Ok(format!("|{rendered_name}={rendered_value}"))
            }
        }
    }
}

fn element_to_wikitext(tag: &str, content: &[XmlNode]) -> Result<String, TemplateRenderError> {
    match tag {
        "template" | "tplarg" => {
            // Oracle quirk (probed on the dist build): a tplarg OPENS with
            // three braces but CLOSES with two — `{{{参数}}`.
            let open = if tag == "template" { "{{" } else { "{{{" };
            let close = "}}";
            let name = first_element(content, "title")
                .map(|t| text_without_comments(children_of(t)).trim().to_string())
                .unwrap_or_default();
            if name.is_empty() {
                return Err(TemplateRenderError(if tag == "template" {
                    "嵌套模板缺少 title 节点。".to_string()
                } else {
                    "模板参数缺少 title 节点。".to_string()
                }));
            }
            let mut out = format!("{open}{name}");
            for part in elements(content, "part") {
                out.push_str(&part_to_wikitext(part)?);
            }
            out.push_str(close);
            Ok(out)
        }
        "link" => {
            let target_text = match first_element(content, "target") {
                Some(t) => content_to_wikitext(children_of(t))?.trim().to_string(),
                None => String::new(),
            };
            if target_text.is_empty() {
                return Err(TemplateRenderError("链接缺少 target 节点。".to_string()));
            }
            let mut out = format!("[[{target_text}");
            for part in elements(content, "part") {
                out.push_str(&part_to_wikitext(part)?);
            }
            out.push_str("]]");
            Ok(out)
        }
        other => Err(TemplateRenderError(format!(
            "不支持的模板字段节点：{other}。"
        ))),
    }
}

fn content_to_wikitext(content: &[XmlNode]) -> Result<String, TemplateRenderError> {
    let mut text = String::new();
    for node in content {
        match node {
            XmlNode::Text(t) => text.push_str(t),
            XmlNode::Comment(c) => {
                text.push_str("<!--");
                text.push_str(c);
                text.push_str("-->");
            }
            // Wikitext `<comment>` elements render back as wikitext comments
            // (their text content, comments stripped).
            XmlNode::Element { tag, children, .. } if tag == "comment" => {
                text.push_str("<!--");
                text.push_str(&text_without_comments(children));
                text.push_str("-->");
            }
            XmlNode::Element { tag, children, .. } => {
                text.push_str(&element_to_wikitext(tag, children)?);
            }
        }
    }
    Ok(text)
}

// --- parseTemplates -----------------------------------------------------------

#[derive(Debug)]
struct TemplatePart {
    name: Option<String>,
    value: String,
    needs_render: bool,
}

#[derive(Debug)]
struct TemplateEntry {
    name: String,
    parts: Vec<TemplatePart>,
    comment: String,
}

fn parse_templates(xml: &str) -> Result<Vec<TemplateEntry>, TemplateRenderError> {
    let parsed = parse_lenient(xml).map_err(|_| TemplateRenderError::invalid_format())?;
    let Some(root) = first_element(&parsed, "root") else {
        return Err(TemplateRenderError::invalid_format());
    };

    let mut templates = Vec::new();
    for template in elements(children_of(root), "template") {
        let content = children_of(template);
        let Some(title) = first_element(content, "title") else {
            continue;
        };
        let name = text_without_comments(children_of(title)).trim().to_string();
        if name.is_empty() {
            continue;
        }
        let comment = first_element(children_of(title), "comment")
            .map(|c| text_without_comments(children_of(c)).trim().to_string())
            .unwrap_or_default();
        let mut parts = Vec::new();
        for part in elements(content, "part") {
            let part_content = children_of(part);
            let Some(value) = first_element(part_content, "value") else {
                continue;
            };
            let value_children = children_of(value);
            let name_element = first_element(part_content, "name");
            let part_name = match name_element {
                Some(n) if !has_attr(n, "index") => {
                    let trimmed = text_without_comments(children_of(n)).trim().to_string();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    }
                }
                _ => None,
            };
            // needsRender: any child that is not plain text or a comment —
            // wikitext <comment> ELEMENTS are on the skip list too (probed:
            // a value of "text<comment>x</comment>" renders as plain text).
            let needs_render = value_children.iter().any(|n| {
                !matches!(n, XmlNode::Text(_) | XmlNode::Comment(_))
                    && !matches!(n, XmlNode::Element { tag, .. } if tag == "comment")
            });
            let raw_value = if needs_render {
                content_to_wikitext(value_children)?
            } else {
                text_without_comments(value_children)
            };
            let normalized = raw_value.trim().to_string();
            if !normalized.is_empty() {
                parts.push(TemplatePart {
                    name: part_name,
                    value: normalized,
                    needs_render,
                });
            }
        }
        templates.push(TemplateEntry {
            name,
            parts,
            comment,
        });
    }
    Ok(templates)
}

// --- batch rendering ----------------------------------------------------------

/// Marker protocol: one POST renders every needs-render field; the response
/// is sliced apart by `PRTSMCP_<uuid>_BEGIN_<i>_` / `_END_<i>_` pairs.
pub async fn render_template_batch(
    transport: &dyn WikiTransport,
    title: &str,
    values: &[String],
) -> Result<Vec<String>, TemplateRenderError> {
    if values.is_empty() {
        return Ok(Vec::new());
    }

    let prefix = format!("PRTSMCP_{}", Uuid::new_v4().simple());
    let markers: Vec<(String, String)> = values
        .iter()
        .enumerate()
        .map(|(index, _)| {
            (
                format!("{prefix}_BEGIN_{index}_"),
                format!("{prefix}_END_{index}_"),
            )
        })
        .collect();
    let text = values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let (begin, end) = &markers[index];
            format!("{begin}\n{value}\n{end}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let data = transport
        .post(&[
            ("action".into(), "parse".into()),
            ("title".into(), title.to_string()),
            ("text".into(), text),
            ("prop".into(), "text".into()),
            ("format".into(), "json".into()),
        ])
        .await
        .map_err(|_| TemplateRenderError("模板字段渲染请求失败。".to_string()))?;

    let Some(response) = data.as_object() else {
        return Err(TemplateRenderError(
            "模板字段渲染响应格式无效。".to_string(),
        ));
    };
    if let Some(error) = response.get("error") {
        let Some(info) = error.as_object().and_then(|e| e.get("info")) else {
            return Err(TemplateRenderError(
                "模板字段渲染响应格式无效。".to_string(),
            ));
        };
        let Some(info) = info.as_str() else {
            return Err(TemplateRenderError(
                "模板字段渲染响应格式无效。".to_string(),
            ));
        };
        if !info.is_empty() {
            return Err(TemplateRenderError("模板字段渲染请求失败。".to_string()));
        }
    }

    let text_node = data
        .get("parse")
        .and_then(|p| p.get("text"))
        .and_then(|t| t.get("*"));
    let Some(rendered_raw) = text_node.and_then(|t| t.as_str()) else {
        return Err(TemplateRenderError(
            "模板字段渲染响应格式无效。".to_string(),
        ));
    };

    let rendered = super::text_ops::strip_html(rendered_raw)
        .map_err(|_| TemplateRenderError("模板字段渲染响应格式无效。".to_string()))?;
    if rendered.is_empty() {
        return Err(TemplateRenderError("模板字段渲染结果为空。".to_string()));
    }

    // The markers must interleave exactly begin₀<end₀<begin₁<end₁… (stable
    // sort by first occurrence; a missing marker is -1 and breaks the order
    // unless every marker is missing, which the per-marker split check then
    // rejects).
    #[derive(Clone, Copy, PartialEq)]
    enum Kind {
        Begin,
        End,
    }
    let marker_positions: Vec<(i64, Kind, usize)> = markers
        .iter()
        .enumerate()
        .flat_map(|(index, (begin, end))| {
            vec![
                (
                    rendered.find(begin).map(|p| p as i64).unwrap_or(-1),
                    Kind::Begin,
                    index,
                ),
                (
                    rendered.find(end).map(|p| p as i64).unwrap_or(-1),
                    Kind::End,
                    index,
                ),
            ]
        })
        .collect();
    let mut sorted_positions = marker_positions.clone();
    sorted_positions.sort_by_key(|(position, _, _)| *position);
    let actual_order: Vec<(Kind, usize)> = sorted_positions
        .into_iter()
        .map(|(_, k, i)| (k, i))
        .collect();
    let expected_order: Vec<(Kind, usize)> = markers
        .iter()
        .enumerate()
        .flat_map(|(index, _)| [(Kind::Begin, index), (Kind::End, index)])
        .collect();
    if actual_order != expected_order {
        return Err(TemplateRenderError("模板字段渲染边界无效。".to_string()));
    }

    let mut out = Vec::with_capacity(markers.len());
    for (begin, end) in &markers {
        // Exactly one occurrence of each marker.
        if rendered.split(begin).count() != 2 || rendered.split(end).count() != 2 {
            return Err(TemplateRenderError("模板字段渲染边界无效。".to_string()));
        }
        let begin_index = rendered
            .find(begin)
            .expect("position known from order check");
        let finish = rendered.find(end).expect("position known from order check");
        if (finish as i64) < (begin_index + begin.len()) as i64 {
            return Err(TemplateRenderError("模板字段渲染边界无效。".to_string()));
        }
        out.push(
            rendered[begin_index + begin.len()..finish]
                .trim()
                .to_string(),
        );
    }
    Ok(out)
}

/// getTemplateData → structured template map. Key order follows first
/// insertion (serde_json preserve_order); duplicate template names overwrite.
pub async fn render_template_data(
    transport: &dyn WikiTransport,
    title: &str,
    xml: &str,
) -> Result<Value, TemplateRenderError> {
    let templates = parse_templates(xml)?;
    let sources: Vec<String> = templates
        .iter()
        .flat_map(|t| {
            t.parts
                .iter()
                .filter(|p| p.needs_render)
                .map(|p| p.value.clone())
                .collect::<Vec<_>>()
        })
        .collect();
    let rendered = if !sources.is_empty() {
        render_template_batch(transport, title, &sources).await?
    } else {
        Vec::new()
    };
    if rendered.len() != sources.len() {
        return Err(TemplateRenderError(
            "模板字段渲染结果数量不匹配。".to_string(),
        ));
    }

    let mut rendered_iter = rendered.into_iter();
    let mut result = serde_json::Map::new();
    for template in &templates {
        let mut entry = serde_json::Map::new();
        let mut positional: Vec<Value> = Vec::new();
        for part in &template.parts {
            let value = if part.needs_render {
                rendered_iter.next()
            } else {
                Some(part.value.clone())
            };
            let Some(value) = value else {
                continue;
            };
            match &part.name {
                Some(name) => {
                    entry.insert(name.clone(), Value::String(value));
                }
                None => positional.push(Value::String(value)),
            }
        }
        if !positional.is_empty() {
            entry.insert("_positional".to_string(), Value::Array(positional));
        }
        if !template.comment.is_empty() {
            entry.insert(
                "_comment".to_string(),
                Value::String(template.comment.clone()),
            );
        }
        if !entry.is_empty() {
            result.insert(template.name.clone(), Value::Object(entry));
        }
    }
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsetree(inner: &str) -> String {
        format!("<root>{inner}</root>")
    }

    #[test]
    fn flat_template_with_named_parts() {
        let xml = parsetree(
            "<template><title>干员信息</title><part><name>名称</name><value>阿米娅</value></part>\
             <part><name>星级</name><value>★★★★★</value></part></template>",
        );
        let templates = parse_templates(&xml).unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].name, "干员信息");
        assert_eq!(templates[0].parts.len(), 2);
        assert!(!templates[0].parts[0].needs_render);
        assert_eq!(templates[0].parts[0].name.as_deref(), Some("名称"));
        // Raw wikitext reconstruction for needs-render values:
        let nested = parsetree(
            "<template><title>外</title><part><name>字段</name><value><template><title>内</title>\
             <part><value>值</value></part></template></value></part></template>",
        );
        let t = parse_templates(&nested).unwrap();
        assert!(t[0].parts[0].needs_render);
        assert_eq!(t[0].parts[0].value, "{{内|值}}");
    }

    #[test]
    fn positional_and_comment_and_empty_values() {
        // A wikitext <comment> ELEMENT inside the title feeds _comment (its
        // text), while an XML-level <!-- --> comment vanishes from the name.
        let xml = parsetree(
            "<template><title>敌人<comment>备注</comment>信息</title>\
             <part><name index=\"1\"/><value>进化</value></part>\
             <part><name></name><value>  </value></part>\
             <part><value>等级1</value></part></template>",
        );
        let t = parse_templates(&xml).unwrap();
        assert_eq!(t[0].name, "敌人信息");
        assert_eq!(t[0].comment, "备注");
        assert_eq!(t[0].parts.len(), 2, "blank part dropped");
        assert_eq!(t[0].parts[0].name, None, "index attr → positional");
        assert_eq!(t[0].parts[1].name, None, "empty name → positional");
    }

    #[test]
    fn tplarg_and_link_reconstruction() {
        let xml = parsetree(
            "<template><title>道具</title><part><value>\
             <tplarg><title>参数</title><part><name>1</name><value>x</value></part></tplarg>\
             [[目标|显示]]\
             </value></part></template>",
        );
        let t = parse_templates(&xml).unwrap();
        assert_eq!(t[0].parts[0].value, "{{{参数|1=x}}[[目标|显示]]");
    }

    #[test]
    fn unsupported_node_in_value_is_an_error() {
        let xml = parsetree(
            "<template><title>坏</title><part><value><ext><title>x</title></ext></value></part></template>",
        );
        let err = parse_templates(&xml).unwrap_err();
        assert_eq!(err.0, "不支持的模板字段节点：ext。");
    }

    #[tokio::test]
    async fn batch_marker_extraction() {
        use crate::wiki::client::WikiTransport;
        struct Fake;
        #[async_trait::async_trait]
        impl WikiTransport for Fake {
            async fn get(&self, _: &[(String, String)]) -> Result<Value, String> {
                unreachable!("batch is POST-only")
            }
            async fn post(&self, params: &[(String, String)]) -> Result<Value, String> {
                let text = &params
                    .iter()
                    .find(|(k, _)| k == "text")
                    .expect("text param")
                    .1;
                // Echo each marked segment with a prefix.
                let mut html = String::new();
                for (i, seg) in text.split("\n\n").enumerate() {
                    html.push_str(&format!("R{i}: {seg} "));
                }
                Ok(serde_json::json!({ "parse": { "text": { "*": format!("<p>{html}</p>") } } }))
            }
        }
        let out = render_template_batch(&Fake, "页面", &["a".into(), "b{{x}}".into()])
            .await
            .unwrap();
        // The fake echoes each marked segment wrapped in "R{i}: … "; the
        // extraction keeps exactly the value between the markers.
        assert_eq!(out, vec!["a".to_string(), "b{{x}}".to_string()]);
        assert!(!out[0].contains("PRTSMCP_"), "markers must not leak");
    }

    #[tokio::test]
    async fn batch_error_shapes() {
        use crate::wiki::client::WikiTransport;
        struct Resp(Value);
        #[async_trait::async_trait]
        impl WikiTransport for Resp {
            async fn get(&self, _: &[(String, String)]) -> Result<Value, String> {
                unreachable!()
            }
            async fn post(&self, _: &[(String, String)]) -> Result<Value, String> {
                match self.0 {
                    Value::Null => Err("network down".into()),
                    ref v => Ok(v.clone()),
                }
            }
        }
        // Transport failure.
        let e = render_template_batch(&Resp(Value::Null), "t", &["x".into()])
            .await
            .unwrap_err();
        assert_eq!(e.0, "模板字段渲染请求失败。");
        // API error with info.
        let e = render_template_batch(
            &Resp(serde_json::json!({ "error": { "info": "internal_api_error" } })),
            "t",
            &["x".into()],
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, "模板字段渲染请求失败。");
        // API error with empty info falls through to the missing-parse shape.
        let e = render_template_batch(
            &Resp(serde_json::json!({ "error": { "info": "" } })),
            "t",
            &["x".into()],
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, "模板字段渲染响应格式无效。");
        // Rendered body empty after stripping.
        let e = render_template_batch(
            &Resp(serde_json::json!({ "parse": { "text": { "*": "   " } } })),
            "t",
            &["x".into()],
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, "模板字段渲染结果为空。");
    }
}
