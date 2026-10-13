//! search_prts domain flow — port of TS `prtsWiki.searchPrts` and
//! `tools/prtsTools.buildPrtsSearch/renderPrtsSearch`.

use serde_json::{json, Value};

use super::client::WikiTransport;
use super::text_ops;
use crate::text::sanitizer::strip_wikitext;

pub struct SearchResult {
    pub title: String,
    pub snippet: String,
}

pub struct SearchResponse {
    pub total_hits: i64,
    pub results: Vec<SearchResult>,
}

/// One redirect-title follow-up query (action=query&redirects=1); any
/// failure keeps the original title (fail-open).
async fn resolve_redirect_title(transport: &dyn WikiTransport, title: &str) -> Option<String> {
    let data = transport
        .get(&[
            ("action".into(), "query".into()),
            ("redirects".into(), "1".into()),
            ("titles".into(), title.to_string()),
            ("format".into(), "json".into()),
        ])
        .await
        .ok()?;
    let redirects = data.get("query").and_then(|q| q.get("redirects"))?;
    for item in redirects.as_array()? {
        let from = item.get("from").and_then(|f| f.as_str());
        let to = item.get("to").and_then(|t| t.as_str());
        if from == Some(title) {
            if let Some(to) = to {
                return Some(to.to_string());
            }
        }
    }
    None
}

/// searchPrts(query, limit, searchMode, filterTechnical).
pub async fn search_prts(
    transport: &dyn WikiTransport,
    query: &str,
    limit: i64,
    search_mode: &str,
    filter_technical: bool,
) -> Result<SearchResponse, String> {
    let fetch_limit = if filter_technical { limit * 2 } else { limit };
    let mut params: Vec<(String, String)> = vec![
        ("action".into(), "query".into()),
        ("list".into(), "search".into()),
        ("srsearch".into(), query.to_string()),
        ("srlimit".into(), fetch_limit.to_string()),
        ("srnamespace".into(), "0".into()),
        ("srinfo".into(), "totalhits".into()),
        ("srprop".into(), "snippet|redirecttitle".into()),
        ("format".into(), "json".into()),
    ];
    if search_mode == "title" {
        params.push(("srwhat".into(), "title".into()));
    }
    let data = transport.get(&params).await?;
    let query_obj = data.get("query").cloned().unwrap_or(Value::Null);
    let total_hits = query_obj
        .get("searchinfo")
        .and_then(|s| s.get("totalhits"))
        .and_then(|t| t.as_i64())
        .unwrap_or(0);
    let mut results = Vec::new();
    let search = query_obj
        .get("search")
        .and_then(|s| s.as_array().cloned())
        .unwrap_or_default();
    for item in &search {
        let mut title = item
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let raw_snippet = item
            .get("snippet")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let has_redirecttitle = item.get("redirecttitle").is_some_and(|r| !r.is_null());
        if !has_redirecttitle && text_ops::is_redirect_like(&raw_snippet)? {
            if let Some(resolved) = resolve_redirect_title(transport, &title).await {
                title = resolved;
            }
        }
        if filter_technical && text_ops::is_technical_page(&title)? {
            continue;
        }
        if results.len() as i64 >= limit {
            break;
        }
        let snippet = strip_wikitext(&raw_snippet);
        let snippet = text_ops::unescape_html_entities(&snippet)?;
        let snippet = text_ops::clean_snippet(&snippet)?;
        results.push(SearchResult { title, snippet });
    }
    Ok(SearchResponse {
        total_hits,
        results,
    })
}

/// buildPrtsSearch payload; domain-level mode validation returns the bare
/// message string (tool layer renders it as text).
pub async fn build_prts_search(
    transport: &dyn WikiTransport,
    query: &str,
    limit: i64,
    search_mode: &str,
    filter_technical: bool,
) -> Result<Value, String> {
    if search_mode != "text" && search_mode != "title" {
        return Err("无效的 search_mode 参数，可选值：text、title。".to_string());
    }
    let result = search_prts(transport, query, limit, search_mode, filter_technical).await?;
    let results: Vec<Value> = result
        .results
        .iter()
        .map(|r| json!({ "title": r.title, "snippet": r.snippet }))
        .collect();
    Ok(json!({
        "query": query,
        "search_mode": search_mode,
        "filters": {
            "limit": limit,
            "filter_technical": filter_technical,
        },
        "total": result.total_hits,
        "results": results,
    }))
}

pub fn render_prts_search(data: &Value) -> String {
    let results = data
        .get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let query = data.get("query").and_then(|q| q.as_str()).unwrap_or("");
    if results.is_empty() {
        return format!("未找到与 '{query}' 相关的词条。");
    }
    let total = data.get("total").and_then(|t| t.as_i64()).unwrap_or(0);
    let body = results
        .iter()
        .map(|r| {
            format!(
                "**{}**\n{}",
                r.get("title").and_then(|t| t.as_str()).unwrap_or(""),
                r.get("snippet").and_then(|s| s.as_str()).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    format!("# 搜索 \"{query}\"（共 {total} 条匹配）\n{body}")
}

// --- tests with a scriptable fake transport -----------------------------------

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    pub type RecordedCall = (String, Vec<(String, String)>);

    pub struct FakeTransport {
        pub calls: Mutex<Vec<RecordedCall>>,
        pub responses: Mutex<VecDeque<Result<Value, String>>>,
    }

    impl FakeTransport {
        pub fn new(responses: Vec<Result<Value, String>>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                responses: Mutex::new(responses.into()),
            }
        }
    }

    #[async_trait::async_trait]
    impl WikiTransport for FakeTransport {
        async fn get(&self, params: &[(String, String)]) -> Result<Value, String> {
            self.calls
                .lock()
                .unwrap()
                .push(("GET".into(), params.to_vec()));
            self.responses.lock().unwrap().pop_front().unwrap()
        }
        async fn post(&self, params: &[(String, String)]) -> Result<Value, String> {
            self.calls
                .lock()
                .unwrap()
                .push(("POST".into(), params.to_vec()));
            self.responses.lock().unwrap().pop_front().unwrap()
        }
        async fn download_image(&self, _: &str) -> Result<Vec<u8>, String> {
            unreachable!("search fakes never download images")
        }
    }

    fn search_item(title: &str, snippet: &str) -> Value {
        json!({ "title": title, "snippet": snippet })
    }

    #[tokio::test]
    async fn doubles_fetch_limit_when_filtering() {
        let t = FakeTransport::new(vec![Ok(json!({
            "query": { "searchinfo": { "totalhits": 3 }, "search": [
                search_item("阿米娅", "罗德岛公开领袖"),
            ] }
        }))]);
        let out = search_prts(&t, "阿米娅", 5, "text", true).await.unwrap();
        assert_eq!(out.total_hits, 3);
        assert_eq!(out.results.len(), 1);
        let calls = t.calls.lock().unwrap();
        assert_eq!(
            calls[0].1.iter().find(|(k, _)| k == "srlimit").unwrap().1,
            "10"
        );
        assert!(calls[0].1.iter().all(|(k, _)| k != "srwhat"));
    }

    #[tokio::test]
    async fn title_mode_adds_srwhat() {
        let t = FakeTransport::new(vec![Ok(json!({ "query": { "search": [] } }))]);
        search_prts(&t, "刀", 5, "title", false).await.unwrap();
        let calls = t.calls.lock().unwrap();
        assert_eq!(
            calls[0].1.iter().find(|(k, _)| k == "srwhat").unwrap().1,
            "title"
        );
        assert_eq!(
            calls[0].1.iter().find(|(k, _)| k == "srlimit").unwrap().1,
            "5"
        );
    }

    #[tokio::test]
    async fn redirect_follow_up_and_fail_open() {
        // Redirect-like snippet without redirecttitle → follow-up query.
        let t = FakeTransport::new(vec![
            Ok(json!({ "query": { "search": [
                search_item("阿米亚", "#REDIRECT [[阿米娅]]"),
            ] } })),
            Ok(json!({ "query": { "redirects": [
                { "from": "阿米亚", "to": "阿米娅" },
            ] } })),
        ]);
        let out = search_prts(&t, "阿米亚", 5, "text", true).await.unwrap();
        assert_eq!(out.results[0].title, "阿米娅");
        assert_eq!(out.results[0].snippet, "阿米娅"); // marker stripped, target kept

        // Follow-up failure keeps the original title.
        let t = FakeTransport::new(vec![
            Ok(json!({ "query": { "search": [
                search_item("阿米亚", "#REDIRECT [[阿米娅]]"),
            ] } })),
            Err("PRTS API error: HTTP 500".into()),
        ]);
        let out = search_prts(&t, "阿米亚", 5, "text", true).await.unwrap();
        assert_eq!(out.results[0].title, "阿米亚");

        // redirecttitle already present → no follow-up call at all.
        let t = FakeTransport::new(vec![Ok(json!({ "query": { "search": [
            json!({ "title": "阿米亚", "snippet": "#REDIRECT [[阿米娅]]", "redirecttitle": "阿米娅" }),
        ] } }))]);
        let out = search_prts(&t, "阿米亚", 5, "text", true).await.unwrap();
        assert_eq!(out.results[0].title, "阿米亚");
        assert_eq!(t.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn technical_filter_and_limit_break() {
        let t = FakeTransport::new(vec![Ok(json!({ "query": { "search": [
            search_item("关卡/data/1-7", "数据页"),
            search_item("Widget:卡片", "组件"),
            search_item("阿米娅", "干员"),
        ] } }))]);
        let out = search_prts(&t, "x", 5, "text", true).await.unwrap();
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].title, "阿米娅");

        // filter_technical=false keeps everything; limit trims after fetch.
        let t = FakeTransport::new(vec![Ok(json!({ "query": { "search": [
            search_item("a", "1"), search_item("b", "2"), search_item("c", "3"),
        ] } }))]);
        let out = search_prts(&t, "x", 2, "text", false).await.unwrap();
        assert_eq!(out.results.len(), 2);
    }

    #[test]
    fn render_shapes() {
        let empty = json!({ "query": "无", "total": 0, "results": [] });
        assert_eq!(render_prts_search(&empty), "未找到与 '无' 相关的词条。");
        let data = json!({
            "query": "罗德岛", "total": 7,
            "results": [
                { "title": "罗德岛", "snippet": "制药公司" },
                { "title": "整合运动", "snippet": "感染者组织" },
            ],
        });
        assert_eq!(
            render_prts_search(&data),
            "# 搜索 \"罗德岛\"（共 7 条匹配）\n**罗德岛**\n制药公司\n\n---\n\n**整合运动**\n感染者组织"
        );
    }
}
