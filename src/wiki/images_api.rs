//! MediaWiki image discovery — port of TS `prtsWiki.listAllimages /
//! getImageinfo` (the LOCAL_IMAGE=false artwork backend's discovery half;
//! the download half lives on the transport as `download_image`).

use serde_json::Value;

use super::client::WikiTransport;

#[derive(Debug)]
pub struct AllimagesEntry {
    pub name: String,
    pub size: i64,
    pub mime: String,
}

/// `listAllimages`: paginate allimages by prefix until no `continue`; more
/// than 50 pages is an error (mirrors the oracle's guard).
pub async fn list_allimages(
    transport: &dyn WikiTransport,
    prefix: &str,
    limit: i64,
) -> Result<Vec<AllimagesEntry>, String> {
    let mut params: Vec<(String, String)> = vec![
        ("action".into(), "query".into()),
        ("list".into(), "allimages".into()),
        ("aiprefix".into(), prefix.to_string()),
        ("ailimit".into(), limit.to_string()),
        ("aiprop".into(), "name|size|mime".into()),
        ("format".into(), "json".into()),
    ];
    let mut results: Vec<AllimagesEntry> = Vec::new();
    let mut pages = 0usize;
    loop {
        pages += 1;
        if pages > 50 {
            return Err("allimages pagination exceeded 50 pages".to_string());
        }
        let data = transport.get(&params).await?;
        for a in data
            .get("query")
            .and_then(|q| q.get("allimages"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
        {
            results.push(AllimagesEntry {
                name: a
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                size: a.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
                mime: a
                    .get("mime")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
        // Object.assign(params, continue): the continue keys merge in-place;
        // their insertion order lands after the existing keys.
        let cont = data
            .get("continue")
            .and_then(|c| c.as_object())
            .cloned()
            .unwrap_or_default();
        if cont.is_empty() {
            break;
        }
        for (key, value) in &cont {
            let rendered = match value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if let Some(existing) = params.iter_mut().find(|(k, _)| k == key) {
                existing.1 = rendered;
            } else {
                params.push((key.clone(), rendered));
            }
        }
    }
    Ok(results)
}

pub struct Imageinfo {
    pub url: Option<String>,
    pub thumburl: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub mime: Option<String>,
    pub size: Option<i64>,
}

/// `getImageinfo`: one page's first imageinfo entry; None when absent.
pub async fn get_imageinfo(
    transport: &dyn WikiTransport,
    title: &str,
    width: Option<i64>,
) -> Result<Option<Imageinfo>, String> {
    let full_title = if title.starts_with("File:") {
        title.to_string()
    } else {
        format!("File:{title}")
    };
    let mut params: Vec<(String, String)> = vec![
        ("action".into(), "query".into()),
        ("titles".into(), full_title),
        ("prop".into(), "imageinfo".into()),
        ("iiprop".into(), "url|size|mime".into()),
        ("format".into(), "json".into()),
    ];
    if let Some(width) = width {
        params.push(("iiurlwidth".into(), width.to_string()));
    }
    let data = transport.get(&params).await?;
    let pages = data
        .get("query")
        .and_then(|q| q.get("pages"))
        .and_then(|p| p.as_object())
        .cloned()
        .unwrap_or_default();
    for page in pages.values() {
        if let Some(infos) = page.get("imageinfo").and_then(|i| i.as_array()) {
            if let Some(info) = infos.first() {
                return Ok(Some(Imageinfo {
                    url: info.get("url").and_then(|v| v.as_str()).map(str::to_string),
                    thumburl: info
                        .get("thumburl")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    width: info.get("width").and_then(|v| v.as_i64()),
                    height: info.get("height").and_then(|v| v.as_i64()),
                    mime: info
                        .get("mime")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    size: info.get("size").and_then(|v| v.as_i64()),
                }));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wiki::search::tests::FakeTransport;
    use serde_json::json;
    use std::collections::VecDeque;

    #[tokio::test]
    async fn allimages_paginates_via_continue() {
        let t = FakeTransport::new(vec![
            Ok(json!({
                "query": { "allimages": [ { "name": "立绘_阿米娅_1.png", "size": 10, "mime": "image/png" } ] },
                "continue": { "aicontinue": "next", "continue": "gaicontinue||" }
            })),
            Ok(json!({
                "query": { "allimages": [ { "name": "立绘_阿米娅_2.png", "size": 20, "mime": "image/png" } ] }
            })),
        ]);
        let out = list_allimages(&t, "立绘_阿米娅_", 50).await.unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "立绘_阿米娅_1.png");
        let calls = t.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        // The continue key merged into the second request.
        assert_eq!(
            calls[1]
                .1
                .iter()
                .find(|(k, _)| k == "aicontinue")
                .unwrap()
                .1,
            "next"
        );
    }

    #[tokio::test]
    async fn imageinfo_shapes() {
        let t = FakeTransport::new(vec![
            Ok(json!({ "query": { "pages": { "12": { "imageinfo": [
                { "url": "https://media.prts.wiki/a.png", "thumburl": "https://media.prts.wiki/a.1024.png", "width": 2048, "height": 2048, "mime": "image/png", "size": 123 }
            ] } } } })),
            Ok(json!({ "query": { "pages": { "13": { "title": "File:none" } } } })),
        ]);
        let info = get_imageinfo(&t, "立绘_阿米娅_1.png", Some(1024))
            .await
            .unwrap()
            .expect("info present");
        assert_eq!(info.width, Some(2048));
        assert_eq!(
            info.thumburl.as_deref(),
            Some("https://media.prts.wiki/a.1024.png")
        );
        // File: prefix is not doubled (values collected, lock released).
        let (titles, width) = {
            let calls = t.calls.lock().unwrap();
            (
                calls[0]
                    .1
                    .iter()
                    .find(|(k, _)| k == "titles")
                    .unwrap()
                    .1
                    .clone(),
                calls[0]
                    .1
                    .iter()
                    .find(|(k, _)| k == "iiurlwidth")
                    .unwrap()
                    .1
                    .clone(),
            )
        };
        assert_eq!(titles, "File:立绘_阿米娅_1.png");
        assert_eq!(width, "1024");
        assert!(get_imageinfo(&t, "无文件.png", None)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn pagination_guard() {
        let page = json!({ "query": { "allimages": [] }, "continue": { "aicontinue": "x", "continue": "y" } });
        let t = FakeTransport {
            calls: std::sync::Mutex::new(Vec::new()),
            responses: std::sync::Mutex::new(VecDeque::from(vec![Ok(page); 60])),
        };
        let err = list_allimages(&t, "x", 50).await.unwrap_err();
        assert_eq!(err, "allimages pagination exceeded 50 pages");
    }
}
