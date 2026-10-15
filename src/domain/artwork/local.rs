//! Local AKDP-backed artwork backend — port of TS `data/artworkLocal.ts`.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::format::{
    artwork_list_item, build_artwork_label, normalized_artwork_form_name, render_list, CharSkins,
};
use crate::app::DataView;
use crate::domain::operator;
use crate::storage::JsonStore;
use crate::sync::images_meta::{parse_index, ImagesIndex, VARIANT_ORDER};

/// Forms that deliberately share the base character's display name.
pub const ARTWORK_FORM_CHAR_IDS: [(&str, &str); 2] = [
    ("阿米娅(近卫)", "char_1001_amiya2"),
    ("阿米娅(医疗)", "char_1037_amiya3"),
];

pub fn resolve_artwork_char_id(
    view: &DataView,
    operator_name: &str,
) -> Result<Option<String>, String> {
    let normalized = normalized_artwork_form_name(operator_name);
    if let Some((_, id)) = ARTWORK_FORM_CHAR_IDS
        .iter()
        .find(|(name, _)| *name == normalized)
    {
        return Ok(Some(id.to_string()));
    }
    operator::resolve_char_id(view, operator_name)
}

pub fn char_id_of(skin_id: &str) -> String {
    skin_id
        .split('#')
        .next()
        .unwrap_or(skin_id)
        .split('@')
        .next()
        .unwrap_or(skin_id)
        .to_string()
}

pub fn data_not_ready_message() -> String {
    "立绘数据未就绪。可能原因：IMAGES_ENABLED 未开启，或图片同步仍在进行中。请稍后重试；若持续不可用，请检查网络或 GITHUB_TOKEN。".to_string()
}

/// skin_table.json charSkins mapping through the per-generation dataset
/// cache; empty when excel is unavailable or the file is missing.
pub fn get_char_skins(view: &DataView) -> std::sync::Arc<CharSkins> {
    let view = view.clone();
    let skins = view.datasets.get_or_load_counted(
        "images:char_skins",
        move || {
            let Some(excel) = view.excel_root.clone() else {
                return Ok(CharSkins::new());
            };
            let store = crate::storage::DirectoryStore::new(excel);
            if !store.exists("skin_table.json").unwrap_or(false) {
                return Ok(CharSkins::new());
            }
            let table = store
                .read_json("skin_table.json")
                .map_err(|e| format!("skin_table: {e}"))?;
            let mut out = CharSkins::new();
            if let Some(raw) = table.get("charSkins").and_then(|c| c.as_object()) {
                for (sid, entry) in raw {
                    let display = entry.get("displaySkin");
                    out.insert(
                        sid.clone(),
                        super::format::DisplaySkin {
                            skin_name: display
                                .and_then(|d| d.get("skinName"))
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            skin_group_name: display
                                .and_then(|d| d.get("skinGroupName"))
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            obtain_approach: display
                                .and_then(|d| d.get("obtainApproach"))
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            description: display
                                .and_then(|d| d.get("description"))
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                        },
                    );
                }
            }
            Ok(out)
        },
        |skins| skins.len() as u64,
    );
    skins.unwrap_or_else(|_: String| std::sync::Arc::new(CharSkins::new()))
}

fn load_index(gen_dir: &Path) -> Option<ImagesIndex> {
    let raw = std::fs::read_to_string(gen_dir.join("index.json")).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    parse_index(&value)
}

fn available_variants(entry: &crate::sync::images_meta::ArtworkEntry) -> Vec<&str> {
    let mut out = Vec::new();
    for v in VARIANT_ORDER {
        if entry.variants.contains_key(v) {
            out.push(v);
        }
    }
    out
}

pub enum ArtworkOutcome {
    /// Rendered markdown + structured payload + summary (list or get).
    Structured {
        data: Value,
        markdown: String,
        summary: Option<String>,
    },
    /// Get outcome with image bytes.
    Image {
        data: Value,
        markdown: String,
        summary: String,
        image_b64: String,
        mime: String,
    },
    /// String message (text-only result).
    Message(String),
}

pub fn list_artworks_local(
    view: &DataView,
    operator_name: &str,
    gen_dir: Option<&Path>,
) -> ArtworkOutcome {
    let char_id = match resolve_artwork_char_id(view, operator_name) {
        Ok(id) => id,
        Err(_) => return ArtworkOutcome::Message(data_not_ready_message()),
    };
    let Some(char_id) = char_id else {
        return ArtworkOutcome::Message(format!(
            "找不到干员「{operator_name}」。建议先用 search_prts 确认准确的中文名称。"
        ));
    };
    let Some(gen_dir) = gen_dir else {
        return ArtworkOutcome::Message(data_not_ready_message());
    };
    let Some(index) = load_index(gen_dir) else {
        return ArtworkOutcome::Message(data_not_ready_message());
    };

    let mut matched: Vec<(&String, &crate::sync::images_meta::ArtworkEntry)> = index
        .artworks
        .iter()
        .filter(|(sid, _)| char_id_of(sid) == char_id)
        .collect();
    matched.sort_by(|a, b| crate::text::js_compat::compare_ids(a.0, b.0));
    if matched.is_empty() {
        return ArtworkOutcome::Message(format!("未找到「{operator_name}」的立绘数据。"));
    }

    let char_skins = get_char_skins(view);
    let artworks: Vec<Value> = matched
        .iter()
        .map(|(sid, entry)| {
            let mut variants = Map::new();
            for v in available_variants(entry) {
                let vm = &entry.variants[v];
                variants.insert(
                    v.to_string(),
                    json!({
                        "width": crate::text::numbers::json_number_value(vm.width),
                        "height": crate::text::numbers::json_number_value(vm.height),
                        "bytes": crate::text::numbers::json_number_value(vm.bytes),
                    }),
                );
            }
            let display = char_skins.get(*sid);
            artwork_list_item(
                sid,
                &build_artwork_label(sid, &char_skins),
                &entry.kind,
                variants,
                display.and_then(|d| d.skin_group_name.clone()),
                display.and_then(|d| d.obtain_approach.clone()),
                display.and_then(|d| d.description.clone()),
            )
        })
        .collect();

    let total = artworks.len();
    let data = json!({
        "operator_name": operator_name,
        "char_id": char_id,
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
            "「{operator_name}」共 {total} 张立绘，详见 structuredContent"
        )),
    }
}

/// Read the PNG under the generation dir with the realpath containment
/// guard: both paths canonicalized, the relative check on the resolved
/// paths, and the read operating on the verified path.
fn read_contained_png(gen_dir: &Path, rel_file: &str) -> Result<Vec<u8>, String> {
    let png_path = gen_dir.join(rel_file);
    let contained = (|| -> Option<PathBuf> {
        let gen_real = std::fs::canonicalize(gen_dir).ok()?;
        let png_real = std::fs::canonicalize(&png_path).ok()?;
        let rel = pathdiff(&gen_real, &png_real)?;
        let ok =
            rel != ".." && !rel.starts_with("../") && !rel.starts_with('/') && png_real.is_file();
        ok.then_some(png_real)
    })()
    .ok_or_else(|| format!("图片文件缺失：{rel_file}。同步可能不完整，请稍后重试。"))?;
    std::fs::read(&contained).map_err(|err| format!("读取图片文件失败：{err}"))
}

fn pathdiff(base: &Path, target: &Path) -> Option<String> {
    let b: Vec<_> = base.components().collect();
    let t: Vec<_> = target.components().collect();
    let mut common = 0;
    while common < b.len() && common < t.len() && b[common] == t[common] {
        common += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in common..b.len() {
        parts.push("..".into());
    }
    for c in &t[common..] {
        parts.push(c.as_os_str().to_string_lossy().into_owned());
    }
    Some(parts.join("/"))
}

pub fn get_artwork_local(
    view: &DataView,
    operator_name: &str,
    artwork_id: &str,
    variant: Option<&str>,
    gen_dir: Option<&Path>,
) -> ArtworkOutcome {
    let chosen = variant.unwrap_or("large");
    let Some(gen_dir) = gen_dir else {
        return ArtworkOutcome::Message(data_not_ready_message());
    };
    let Some(index) = load_index(gen_dir) else {
        return ArtworkOutcome::Message(data_not_ready_message());
    };

    let Some(entry) = index.artworks.get(artwork_id) else {
        return ArtworkOutcome::Message(format!(
            "找不到 artwork_id「{artwork_id}」。该 ID 不透明，请用 action=list 重新获取。"
        ));
    };
    let char_id = match resolve_artwork_char_id(view, operator_name) {
        Ok(id) => id,
        Err(_) => return ArtworkOutcome::Message(data_not_ready_message()),
    };
    let Some(char_id) = char_id else {
        return ArtworkOutcome::Message(format!(
            "找不到干员「{operator_name}」。建议先用 search_prts 确认准确的中文名称。"
        ));
    };
    if char_id_of(artwork_id) != char_id {
        return ArtworkOutcome::Message(format!(
            "该 artwork_id 不属于干员「{operator_name}」。artwork_id 为不透明 token，请用 action=list 重新获取。"
        ));
    }
    let Some(variant_meta) = entry.variants.get(chosen) else {
        let available = available_variants(entry).join("、");
        let available = if available.is_empty() {
            "无"
        } else {
            &available
        };
        return ArtworkOutcome::Message(format!(
            "artwork_id「{artwork_id}」不提供「{chosen}」变体（可用：{available}）。"
        ));
    };
    let image_bytes = match read_contained_png(gen_dir, &variant_meta.file) {
        Ok(bytes) => bytes,
        Err(message) => return ArtworkOutcome::Message(message),
    };

    let image_base64 = super::base64_encode(&image_bytes);
    let char_skins = get_char_skins(view);
    let label = build_artwork_label(artwork_id, &char_skins);
    let markdown = format!(
        "**{label}**（{operator_name}）\n变体：{chosen}｜尺寸：{}×{}｜{} bytes\nartwork_id：`{artwork_id}`",
        format_number(variant_meta.width),
        format_number(variant_meta.height),
        format_number(variant_meta.bytes),
    );
    let data = json!({
        "operator_name": operator_name,
        "artwork_id": artwork_id,
        "label": label,
        "variant": chosen,
        "width": crate::text::numbers::json_number_value(variant_meta.width),
        "height": crate::text::numbers::json_number_value(variant_meta.height),
        "bytes": crate::text::numbers::json_number_value(variant_meta.bytes),
        "sha256": variant_meta.sha256,
    });
    ArtworkOutcome::Image {
        data,
        markdown,
        summary: format!("{operator_name} 的「{label}」（{chosen}）"),
        image_b64: image_base64,
        mime: "image/png".to_string(),
    }
}

/// JS Number→string for width/height/bytes (integral values print bare).
fn format_number(value: f64) -> String {
    crate::text::numbers::js_number_to_string(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn char_id_shapes() {
        assert_eq!(char_id_of("char_002_amiya#2"), "char_002_amiya");
        assert_eq!(char_id_of("char_002_amiya@skin1#1"), "char_002_amiya");
        assert_eq!(char_id_of("char_002_amiya"), "char_002_amiya");
    }

    #[test]
    fn path_containment_rejects_escape() {
        let dir = std::env::temp_dir().join("prts-artwork-contain-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("chararts")).unwrap();
        std::fs::write(dir.join("chararts/ok.png"), b"png").unwrap();
        // A symlink escaping the generation dir must not be followed into a
        // read.
        let outside = std::env::temp_dir().join("prts-artwork-outside-secret.png");
        std::fs::write(&outside, b"secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("chararts/evil.png")).unwrap();

        assert_eq!(read_contained_png(&dir, "chararts/ok.png").unwrap(), b"png");
        assert!(read_contained_png(&dir, "chararts/missing.png").is_err());
        #[cfg(unix)]
        {
            let err = read_contained_png(&dir, "chararts/evil.png").unwrap_err();
            assert!(err.starts_with("图片文件缺失"), "{err}");
        }
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }
}
