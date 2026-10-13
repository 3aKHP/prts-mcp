//! MediaWiki artwork backend — port of TS `data/artworkMediawiki.ts`
//! (LOCAL_IMAGE=false): filename→label parsing, the 256 MiB LRU image
//! cache, and the list/get orchestrations over the P5 wiki client.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::format::{normalized_artwork_form_name, render_list, BASE_ILLUST_LABELS};
use crate::wiki::client::WikiTransport;
use crate::wiki::images_api::{get_imageinfo, list_allimages};
use crate::wiki::page::get_template_data;
use crate::wiki::page::WikiError;

pub const VARIANT_WIDTH_LARGE: i64 = 1024;
pub const VARIANT_WIDTH_PREVIEW: i64 = 256;
const IMAGE_CACHE_MAX_BYTES: usize = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// LRU image cache (insertion-ordered; most-recent at the back)
// ---------------------------------------------------------------------------

struct LruCache {
    entries: std::collections::VecDeque<(String, Vec<u8>)>,
    index: HashMap<String, usize>,
    total: usize,
    max_bytes: usize,
}

impl LruCache {
    fn new() -> Self {
        Self::with_limit(IMAGE_CACHE_MAX_BYTES)
    }

    fn with_limit(max_bytes: usize) -> Self {
        Self {
            entries: Default::default(),
            index: Default::default(),
            total: 0,
            max_bytes,
        }
    }

    fn total_bytes(&self) -> usize {
        self.total
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn get(&mut self, key: &str) -> Option<Vec<u8>> {
        let pos = *self.index.get(key)?;
        let value = self.entries.remove(pos)?.1;
        self.index.remove(key);
        for (_, idx) in self.index.iter_mut() {
            if *idx > pos {
                *idx -= 1;
            }
        }
        self.entries.push_back((key.to_string(), value.clone()));
        self.index.insert(key.to_string(), self.entries.len() - 1);
        Some(value)
    }

    fn put(&mut self, key: String, data: Vec<u8>) {
        if let Some(pos) = self.index.remove(&key) {
            if let Some((_, old)) = self.entries.remove(pos) {
                self.total -= old.len();
            }
            for (_, idx) in self.index.iter_mut() {
                if *idx > pos {
                    *idx -= 1;
                }
            }
        }
        self.total += data.len();
        self.entries.push_back((key.clone(), data));
        self.index.insert(key, self.entries.len() - 1);
        while self.total > self.max_bytes && !self.entries.is_empty() {
            let Some((oldest_key, oldest)) = self.entries.pop_front() else {
                break;
            };
            self.index.remove(&oldest_key);
            self.total -= oldest.len();
        }
    }
}

use std::sync::Mutex;
static IMAGE_CACHE: Mutex<Option<LruCache>> = Mutex::new(None);

const IMAGE_CACHE_SLOT: &str = "artwork_mediawiki:image_cache";

fn image_cache_get(artwork_id: &str, variant: &str) -> Option<Vec<u8>> {
    let mut guard = IMAGE_CACHE.lock().expect("image cache lock");
    let cache = guard.get_or_insert_with(LruCache::new);
    let hit = cache.get(&format!("{artwork_id}|{variant}"));
    if hit.is_some() {
        crate::diagnostics::record_hit(IMAGE_CACHE_SLOT);
    } else {
        crate::diagnostics::record_miss(IMAGE_CACHE_SLOT);
    }
    hit
}

fn image_cache_put(artwork_id: &str, variant: &str, data: Vec<u8>) {
    let mut guard = IMAGE_CACHE.lock().expect("image cache lock");
    let cache = guard.get_or_insert_with(LruCache::new);
    cache.put(format!("{artwork_id}|{variant}"), data);
    crate::diagnostics::record_bytes(
        IMAGE_CACHE_SLOT,
        cache.total_bytes() as u64,
        cache.len() as u64,
    );
}

// ---------------------------------------------------------------------------
// Filename → label parsing
// ---------------------------------------------------------------------------

fn mediawiki_base_label(suffix: &str) -> String {
    let plus = suffix.ends_with('+');
    let base = suffix.strip_suffix('+').unwrap_or(suffix);
    let mut label = BASE_ILLUST_LABELS
        .iter()
        .find(|(num, _)| *num == base)
        .map(|(_, label)| label.to_string())
        .unwrap_or_else(|| {
            if base.is_empty() {
                "立绘".to_string()
            } else {
                format!("立绘 {base}")
            }
        });
    if plus {
        label.push_str("（变体）");
    }
    label
}

fn mediawiki_fashion_label(rest: &str, charinfo: &Value) -> String {
    let mut num = String::new();
    for ch in rest.chars().skip(4) {
        if ch.is_ascii_digit() {
            num.push(ch);
        } else {
            break;
        }
    }
    let mut label: Option<String> = None;
    if !num.is_empty() {
        if let Some(v) = charinfo
            .get(format!("时装{num}名称"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            label = Some(v.to_string());
        }
    }
    label.unwrap_or_else(|| {
        if num.is_empty() {
            "时装".to_string()
        } else {
            format!("时装 {num}")
        }
    })
}

pub fn label_from_filename(filename: &str, charinfo: &Value) -> Option<String> {
    if !filename.ends_with(".png") {
        return None;
    }
    let base = &filename[..filename.len() - 4];
    let first = base.find('_')?;
    let second = base[first + 1..].find('_').map(|i| i + first + 1)?;
    let name = &base[first + 1..second];
    let suffix = &base[second + 1..];
    let mut form: Option<String> = None;
    if name.contains('(') {
        let b = name.find('(')?;
        let e = name[b + 1..].find(')').map(|i| i + b + 1)?;
        if b < e {
            form = Some(name[b + 1..e].to_string());
        }
    }
    let mut label = if suffix.starts_with("skin") {
        mediawiki_fashion_label(suffix, charinfo)
    } else if suffix.ends_with('b') {
        return None; // 建筑小人
    } else {
        mediawiki_base_label(suffix)
    };
    if let Some(form) = form {
        label.push_str(&format!("（{form}）"));
    }
    Some(label)
}

/// The declaring operator segment for a listable MediaWiki artwork.
pub fn operator_from_filename(filename: &str) -> Option<String> {
    if !filename.ends_with(".png") || !filename.starts_with("立绘_") {
        return None;
    }
    label_from_filename(filename, &Value::Null)?;
    let base = &filename[..filename.len() - 4];
    let separator = base["立绘_".len()..].find('_').map(|i| i + "立绘_".len())?;
    let operator_name = &base["立绘_".len()..separator];
    if operator_name.is_empty() {
        None
    } else {
        Some(operator_name.to_string())
    }
}

/// A MediaWiki artwork belongs to its requested operator only under exact
/// normalized name equality (base names cannot fetch transformed forms).
pub fn artwork_belongs_to_operator(filename: &str, operator_name: &str) -> bool {
    match operator_from_filename(filename) {
        Some(artwork_operator) => {
            let requested = normalized_artwork_form_name(operator_name);
            let actual = normalized_artwork_form_name(&artwork_operator);
            requested == actual
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

use super::local::ArtworkOutcome;

pub async fn list_artworks_mediawiki(
    transport: &dyn WikiTransport,
    operator_name: &str,
) -> ArtworkOutcome {
    let normalized_name = normalized_artwork_form_name(operator_name);
    let prefix = format!("立绘_{normalized_name}_");
    let files = match list_allimages(transport, &prefix, 50).await {
        Ok(files) => files,
        Err(err) => return ArtworkOutcome::Message(format!("查询 PRTS 立绘失败：{err}")),
    };
    let templates = match get_template_data(transport, &normalized_name).await {
        Ok(t) => t,
        Err(WikiError::Plain(err)) => {
            return ArtworkOutcome::Message(format!("查询 PRTS 立绘失败：{err}"))
        }
        Err(WikiError::Template(_)) => {
            return ArtworkOutcome::Message(
                "查询 PRTS 立绘失败：模板字段渲染失败。请改用 action=\"read\" 获取正文。"
                    .to_string(),
            )
        }
    };
    let charinfo = templates.get("CharinfoV2").cloned().unwrap_or(Value::Null);
    let mut artworks: Vec<Value> = Vec::new();
    for f in &files {
        let Some(label) = label_from_filename(&f.name, &charinfo) else {
            continue;
        };
        artworks.push(json!({
            "artwork_id": f.name,
            "label": label,
            "kind": if f.name.contains("skin") { "skin" } else { "base" },
            "variants": { "large": {}, "preview": {} },
        }));
    }
    artworks.sort_by(|a, b| {
        crate::text::js_compat::compare_ids(
            a["artwork_id"].as_str().unwrap_or(""),
            b["artwork_id"].as_str().unwrap_or(""),
        )
    });
    if artworks.is_empty() {
        return ArtworkOutcome::Message(format!(
            "未找到「{operator_name}」的立绘。建议先用 search_prts 确认名称。"
        ));
    }
    let total = artworks.len();
    let data = json!({
        "operator_name": operator_name,
        "source": "mediawiki",
        "total": total,
        "artworks": artworks,
    });
    let markdown = render_list(
        operator_name,
        &data["artworks"].as_array().cloned().unwrap_or_default(),
    );
    ArtworkOutcome::Structured {
        data,
        markdown,
        summary: Some(format!(
            "「{operator_name}」共 {total} 张立绘（PRTS MediaWiki），详见 structuredContent"
        )),
    }
}

pub async fn get_artwork_mediawiki(
    transport: &dyn WikiTransport,
    operator_name: &str,
    artwork_id: &str,
    variant: Option<&str>,
    image_cache_enabled: bool,
) -> ArtworkOutcome {
    if !artwork_belongs_to_operator(artwork_id, operator_name) {
        return ArtworkOutcome::Message(format!(
            "该 artwork_id 不属于干员「{operator_name}」。artwork_id 为不透明 token，请用 action=list 重新获取。"
        ));
    }
    if variant == Some("original") {
        return ArtworkOutcome::Message(
            "LOCAL_IMAGE=false 模式不提供 original 变体（PRTS 原图常超 1 MiB 安全上限）。请使用 large 或 preview。"
                .to_string(),
        );
    }
    let chosen = variant.unwrap_or("large");
    let width = match chosen {
        "large" => Some(VARIANT_WIDTH_LARGE),
        "preview" => Some(VARIANT_WIDTH_PREVIEW),
        _ => None,
    };
    let Some(width) = width else {
        return ArtworkOutcome::Message(format!(
            "不支持的变体：{chosen}。false 模式可选 large / preview。"
        ));
    };
    let info = match get_imageinfo(transport, artwork_id, Some(width)).await {
        Ok(info) => info,
        Err(err) => return ArtworkOutcome::Message(format!("查询 PRTS 图片信息失败：{err}")),
    };
    let Some(info) = info else {
        return ArtworkOutcome::Message(format!(
            "找不到文件「{artwork_id}」。请用 action=list 重新获取。"
        ));
    };
    let img_url = info.thumburl.clone().or_else(|| info.url.clone());
    let Some(img_url) = img_url else {
        return ArtworkOutcome::Message(format!("「{artwork_id}」无 {chosen} 变体。"));
    };
    let mut image_bytes: Option<Vec<u8>> = None;
    if image_cache_enabled {
        image_bytes = image_cache_get(artwork_id, chosen);
    }
    let image_bytes = match image_bytes {
        Some(bytes) => bytes,
        None => {
            let bytes = match transport.download_image(&img_url).await {
                Ok(bytes) => bytes,
                Err(err) => return ArtworkOutcome::Message(format!("下载图片失败：{err}")),
            };
            if image_cache_enabled {
                image_cache_put(artwork_id, chosen, bytes.clone());
            }
            bytes
        }
    };
    let image_base64 = super::base64_encode(&image_bytes);
    let label =
        label_from_filename(artwork_id, &Value::Null).unwrap_or_else(|| artwork_id.to_string());
    let mime = info.mime.clone().unwrap_or_else(|| "image/png".to_string());
    let markdown = format!(
        "**{label}**（{operator_name}）\n变体：{chosen}｜来源：PRTS MediaWiki\nartwork_id：`{artwork_id}`"
    );
    let data = json!({
        "operator_name": operator_name,
        "artwork_id": artwork_id,
        "label": label,
        "variant": chosen,
        "source": "mediawiki",
        "width": info.width.map(|w| crate::text::numbers::json_number_value(w as f64)),
        "height": info.height.map(|h| crate::text::numbers::json_number_value(h as f64)),
        "bytes": crate::text::numbers::json_number_value(image_bytes.len() as f64),
    });
    ArtworkOutcome::Image {
        data,
        markdown,
        summary: format!("{operator_name} 的「{label}」（{chosen}，PRTS MediaWiki）"),
        image_b64: image_base64,
        mime,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_labels() {
        assert_eq!(
            label_from_filename("立绘_阿米娅_1.png", &Value::Null),
            Some("精英零立绘".to_string())
        );
        assert_eq!(
            label_from_filename("立绘_阿米娅_2.png", &Value::Null),
            Some("精英二立绘".to_string())
        );
        assert_eq!(
            label_from_filename("立绘_阿米娅_5b.png", &Value::Null),
            None,
            "建筑小人"
        );
        assert_eq!(
            label_from_filename("立绘_阿米娅_skin1.png", &Value::Null),
            Some("时装 1".to_string())
        );
        let charinfo = json!({ "时装2名称": "报童" });
        assert_eq!(
            label_from_filename("立绘_阿米娅_skin2.png", &charinfo),
            Some("报童".to_string())
        );
        // Forms (近卫) append in parentheses.
        assert_eq!(
            label_from_filename("立绘_阿米娅(近卫)_1.png", &Value::Null),
            Some("精英零立绘（近卫）".to_string())
        );
        assert_eq!(label_from_filename("icon.png", &Value::Null), None);
    }

    #[test]
    fn operator_and_ownership() {
        assert_eq!(
            operator_from_filename("立绘_阿米娅_1.png").as_deref(),
            Some("阿米娅")
        );
        assert!(artwork_belongs_to_operator("立绘_阿米娅_1.png", "阿米娅"));
        // Fullwidth request normalizes to the same owner.
        assert!(artwork_belongs_to_operator(
            "立绘_阿米娅(近卫)_1.png",
            "阿米娅（近卫）"
        ));
        // Cross-form tokens are rejected: base name cannot fetch the guard
        // form and vice versa.
        assert!(!artwork_belongs_to_operator(
            "立绘_阿米娅(近卫)_1.png",
            "阿米娅"
        ));
        assert!(!artwork_belongs_to_operator(
            "立绘_阿米娅_1.png",
            "阿米娅(近卫)"
        ));
        assert!(!artwork_belongs_to_operator("立绘_凯尔希_1.png", "阿米娅"));
        assert!(!artwork_belongs_to_operator("随便.png", "阿米娅"));
    }

    #[test]
    fn lru_eviction_order() {
        let mut cache = LruCache::with_limit(250);
        cache.put("a".into(), vec![0u8; 100]);
        cache.put("b".into(), vec![0u8; 100]);
        cache.get("a"); // a is now most recent
        cache.put("c".into(), vec![0u8; 100]); // evicts b (oldest)
        assert!(cache.get("b").is_none());
        assert!(cache.get("a").is_some());
        assert!(cache.get("c").is_some());
        assert_eq!(cache.total, 300 - 100);
        // An oversized insertion evicts everything older, then itself.
        cache.put("big".into(), vec![0u8; 400]);
        assert!(cache.get("a").is_none());
        assert!(cache.get("c").is_none());
        assert_eq!(cache.total, 0);
    }
}
