//! prts_page actions — port of TS `prtsWiki.readPage/listSections/
//! getCategories/getLinks/getTemplateData` and the prtsTools layering.

use serde_json::Value;

use super::client::WikiTransport;
use super::template::render_template_data;
pub use super::template::WikiError;
use super::text_ops;

/// readPage(title, sectionIndex?) — missing/empty pages produce the shared
/// "not found or empty" text (NOT an error).
pub async fn read_page(
    transport: &dyn WikiTransport,
    title: &str,
    section_index: Option<i64>,
) -> Result<String, String> {
    let mut params: Vec<(String, String)> = vec![
        ("action".into(), "parse".into()),
        ("page".into(), title.to_string()),
        ("prop".into(), "text".into()),
        ("format".into(), "json".into()),
    ];
    if let Some(section) = section_index {
        params.push(("section".into(), section.to_string()));
    }
    let data = transport.get(&params).await?;
    if error_info_present(&data) {
        return Ok(format!("页面 '{title}' 未找到或内容为空。"));
    }
    let html_text = data
        .get("parse")
        .and_then(|p| p.get("text"))
        .and_then(|t| t.get("*"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if html_text.is_empty() {
        return Ok(format!("页面 '{title}' 未找到或内容为空。"));
    }
    text_ops::strip_html(html_text)
}

/// TS `if (data.error?.info)` — the key must exist with a truthy value.
fn error_info_present(data: &Value) -> bool {
    data.get("error")
        .and_then(|e| e.get("info"))
        .is_some_and(|i| !i.is_null() && i != &Value::String(String::new()))
}

#[derive(Debug)]
pub struct Section {
    pub index: String,
    pub level: String,
    pub line: String,
    pub from_title: String,
}

pub async fn list_sections(
    transport: &dyn WikiTransport,
    title: &str,
) -> Result<Vec<Section>, String> {
    let data = transport
        .get(&[
            ("action".into(), "parse".into()),
            ("page".into(), title.to_string()),
            ("prop".into(), "sections".into()),
            ("format".into(), "json".into()),
        ])
        .await?;
    if error_info_present(&data) {
        return Err(format!("页面 '{title}' 未找到。"));
    }
    let sections = data
        .get("parse")
        .and_then(|p| p.get("sections"))
        .and_then(|s| s.as_array().cloned())
        .unwrap_or_default();
    Ok(sections
        .iter()
        .map(|s| Section {
            index: s
                .get("index")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            level: s
                .get("level")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            line: s
                .get("line")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            from_title: s
                .get("fromtitle")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect())
}

pub async fn get_categories(
    transport: &dyn WikiTransport,
    title: &str,
) -> Result<Vec<String>, String> {
    let data = transport
        .get(&[
            ("action".into(), "parse".into()),
            ("page".into(), title.to_string()),
            ("prop".into(), "categories".into()),
            ("format".into(), "json".into()),
        ])
        .await?;
    if error_info_present(&data) {
        return Err(format!("页面 '{title}' 未找到。"));
    }
    let cats = data
        .get("parse")
        .and_then(|p| p.get("categories"))
        .and_then(|c| c.as_array().cloned())
        .unwrap_or_default();
    Ok(cats
        .iter()
        .map(|c| {
            c.get("*")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect())
}

pub struct LinksResult {
    pub links: Vec<String>,
    pub total: usize,
    pub has_more: bool,
}

pub async fn get_links(
    transport: &dyn WikiTransport,
    title: &str,
    direction: &str,
    limit: usize,
) -> Result<LinksResult, String> {
    if direction == "outbound" {
        let data = transport
            .get(&[
                ("action".into(), "parse".into()),
                ("page".into(), title.to_string()),
                ("prop".into(), "links".into()),
                ("format".into(), "json".into()),
            ])
            .await?;
        if error_info_present(&data) {
            return Err(format!("页面 '{title}' 未找到。"));
        }
        let all_links = data
            .get("parse")
            .and_then(|p| p.get("links"))
            .and_then(|l| l.as_array().cloned())
            .unwrap_or_default();
        let all: Vec<String> = all_links
            .iter()
            .map(|l| {
                l.get("*")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        return Ok(LinksResult {
            links: all.iter().take(limit).cloned().collect(),
            total: all.len(),
            has_more: all.len() > limit,
        });
    }

    // inbound: list=backlinks
    let data = transport
        .get(&[
            ("action".into(), "query".into()),
            ("list".into(), "backlinks".into()),
            ("bltitle".into(), title.to_string()),
            ("bllimit".into(), limit.min(500).to_string()),
            ("blnamespace".into(), "0".into()),
            ("format".into(), "json".into()),
        ])
        .await?;
    let backlinks = data
        .get("query")
        .and_then(|q| q.get("backlinks"))
        .and_then(|b| b.as_array().cloned())
        .unwrap_or_default();
    let links: Vec<String> = backlinks
        .iter()
        .map(|bl| {
            bl.get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect();
    Ok(LinksResult {
        links: links.iter().take(limit).cloned().collect(),
        total: links.len(),
        has_more: data.as_object().is_some_and(|o| o.contains_key("continue")),
    })
}

/// getTemplateData: parsetree fetch + renderTemplateData. Transport and
/// lookup failures are Plain (bare text); render failures are Template
/// (the tool's fixed advice message).
pub async fn get_template_data(
    transport: &dyn WikiTransport,
    title: &str,
) -> Result<Value, WikiError> {
    let data = transport
        .get(&[
            ("action".into(), "parse".into()),
            ("page".into(), title.to_string()),
            ("prop".into(), "parsetree".into()),
            ("format".into(), "json".into()),
        ])
        .await
        .map_err(WikiError::Plain)?;
    if error_info_present(&data) {
        return Err(WikiError::Plain(format!("页面 '{title}' 未找到。")));
    }
    let xml = data
        .get("parse")
        .and_then(|p| p.get("parsetree"))
        .and_then(|p| p.get("*"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if xml.is_empty() {
        return Err(WikiError::Plain(format!(
            "页面 '{title}' 无 parsetree 数据。"
        )));
    }
    render_template_data(transport, title, xml)
        .await
        .map_err(WikiError::Template)
}

/// JSON.stringify(templates, null, 2) — serde_json's pretty printer uses the
/// same 2-space indent and `": "` separators; UTF-8 stays literal.
pub fn templates_to_json_text(templates: &Value) -> String {
    serde_json::to_string_pretty(templates).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wiki::search::tests::FakeTransport;
    use serde_json::json;

    #[tokio::test]
    async fn read_page_shapes() {
        let t = FakeTransport::new(vec![
            Ok(json!({ "parse": { "text": { "*": "<p>你好 <b>世界</b></p>" } } })),
            Ok(json!({ "error": { "info": "The page you specified doesn't exist." } })),
            Ok(json!({ "parse": { "text": { "*": "" } } })),
        ]);
        assert_eq!(read_page(&t, "阿米娅", None).await.unwrap(), "你好 世界");
        assert_eq!(
            read_page(&t, "不存在", None).await.unwrap(),
            "页面 '不存在' 未找到或内容为空。"
        );
        assert_eq!(
            read_page(&t, "空页", None).await.unwrap(),
            "页面 '空页' 未找到或内容为空。"
        );
        // section param flows through
        let t = FakeTransport::new(vec![Ok(json!({ "parse": { "text": { "*": "x" } } }))]);
        read_page(&t, "页", Some(3)).await.unwrap();
        let calls = t.calls.lock().unwrap();
        assert_eq!(
            calls[0].1.iter().find(|(k, _)| k == "section").unwrap().1,
            "3"
        );
    }

    #[tokio::test]
    async fn sections_and_categories_error_layering() {
        let t = FakeTransport::new(vec![
            Ok(json!({ "parse": { "sections": [
                { "index": "1", "level": "2", "line": "基础", "fromtitle": "阿米娅" },
            ] } })),
            Ok(json!({ "error": { "info": "missing page" } })),
        ]);
        let s = list_sections(&t, "阿米娅").await.unwrap();
        assert_eq!(s[0].index, "1");
        assert_eq!(s[0].from_title, "阿米娅");
        assert_eq!(
            list_sections(&t, "无").await.unwrap_err(),
            "页面 '无' 未找到。"
        );

        let t = FakeTransport::new(vec![Ok(
            json!({ "parse": { "categories": [ { "*": "干员" } ] } }),
        )]);
        assert_eq!(get_categories(&t, "x").await.unwrap(), vec!["干员"]);
    }

    #[tokio::test]
    async fn links_outbound_pagination_and_inbound_continue() {
        let t = FakeTransport::new(vec![Ok(json!({ "parse": { "links": [
            { "*": "a" }, { "*": "b" }, { "*": "c" },
        ] } }))]);
        let out = get_links(&t, "页", "outbound", 2).await.unwrap();
        assert_eq!(out.links, vec!["a", "b"]);
        assert_eq!(out.total, 3);
        assert!(out.has_more);

        let t = FakeTransport::new(vec![Ok(json!({
            "query": { "backlinks": [ { "title": "链1" }, { "title": "链2" } ] },
            "continue": { "blcontinue": "0|x", "continue": "gblcontinue||" }
        }))]);
        let out = get_links(&t, "页", "inbound", 30).await.unwrap();
        assert_eq!(out.links, vec!["链1", "链2"]);
        assert!(out.has_more);
        let calls = t.calls.lock().unwrap();
        assert_eq!(
            calls[0].1.iter().find(|(k, _)| k == "bllimit").unwrap().1,
            "30"
        );
    }

    #[tokio::test]
    async fn template_missing_page_and_no_parsetree() {
        let t = FakeTransport::new(vec![Ok(json!({ "error": { "info": "nope" } }))]);
        let WikiError::Plain(msg) = get_template_data(&t, "无").await.unwrap_err() else {
            panic!("plain error expected");
        };
        assert_eq!(msg, "页面 '无' 未找到。");
        let t = FakeTransport::new(vec![Ok(json!({ "parse": { "parsetree": { "*": "" } } }))]);
        let WikiError::Plain(msg) = get_template_data(&t, "空").await.unwrap_err() else {
            panic!("plain error expected");
        };
        assert_eq!(msg, "页面 '空' 无 parsetree 数据。");
        // Transport failure → Plain (bare message at the tool layer).
        let t = FakeTransport::new(vec![Err("PRTS API error: HTTP 500".into())]);
        let WikiError::Plain(msg) = get_template_data(&t, "x").await.unwrap_err() else {
            panic!("plain error expected");
        };
        assert_eq!(msg, "PRTS API error: HTTP 500");
    }
}
