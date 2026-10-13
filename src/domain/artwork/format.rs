//! Artwork result shapes and shared list rendering — port of TS
//! `data/artworkFormat.ts` + the label half of `data/images.ts`.

use serde_json::{json, Map, Value};

/// `normalizedArtworkFormName`: trim + fullwidth parens → halfwidth.
pub fn normalized_artwork_form_name(operator_name: &str) -> String {
    operator_name.trim().replace('（', "(").replace('）', ")")
}

pub const BASE_ILLUST_LABELS: [(&str, &str); 2] = [("1", "精英零立绘"), ("2", "精英二立绘")];

/// CharSkins subset consumers read (displaySkin fields only).
#[derive(Clone)]
pub struct DisplaySkin {
    pub skin_name: Option<String>,
    pub skin_group_name: Option<String>,
    pub obtain_approach: Option<String>,
    pub description: Option<String>,
}

pub type CharSkins = std::collections::HashMap<String, DisplaySkin>;

/// `buildArtworkLabel` — local backend labels (skin_table join).
pub fn build_artwork_label(skin_id: &str, char_skins: &CharSkins) -> String {
    let entry = char_skins.get(skin_id);

    if let Some(at_idx) = skin_id.find('@') {
        if let Some(display) = entry {
            if let Some(name) = display.skin_name.as_deref() {
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
        let rest = &skin_id[at_idx + 1..];
        let theme = rest.split('#').next().unwrap_or("");
        return if theme.is_empty() {
            "时装".to_string()
        } else {
            format!("时装（{theme}）")
        };
    }

    let suffix = match skin_id.find('#') {
        Some(idx) => &skin_id[idx + 1..],
        None => "",
    };
    let plus = suffix.ends_with('+');
    let base_num = suffix.strip_suffix('+').unwrap_or(suffix);
    let mut label = BASE_ILLUST_LABELS
        .iter()
        .find(|(num, _)| *num == base_num)
        .map(|(_, label)| label.to_string())
        .unwrap_or_else(|| {
            if base_num.is_empty() {
                "立绘".to_string()
            } else {
                format!("立绘 {base_num}")
            }
        });
    if plus {
        label.push_str("（变体）");
    }
    label
}

/// `renderList`: the shared markdown for both backends.
pub fn render_list(operator_name: &str, artworks: &[Value]) -> String {
    let header = format!("# 「{operator_name}」的立绘（共 {} 张）\n", artworks.len());
    let lines: Vec<String> = artworks
        .iter()
        .map(|art| {
            let artwork_id = art["artwork_id"].as_str().unwrap_or("");
            let label = art["label"].as_str().unwrap_or("");
            let variants = art["variants"]
                .as_object()
                .map(|v| v.keys().cloned().collect::<Vec<_>>().join("/"))
                .unwrap_or_default();
            let suffix = art["skin_group"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| format!("｜{s}"))
                .unwrap_or_default();
            format!("- **{label}**｜`{artwork_id}`｜变体：{variants}{suffix}")
        })
        .collect();
    header + &lines.join("\n")
}

/// One artwork list item as the structured payload value.
pub fn artwork_list_item(
    artwork_id: &str,
    label: &str,
    kind: &str,
    variants: Map<String, Value>,
    skin_group: Option<String>,
    acquisition: Option<String>,
    description: Option<String>,
) -> Value {
    let mut item = json!({
        "artwork_id": artwork_id,
        "label": label,
        "kind": kind,
        "variants": Value::Object(variants),
    });
    let obj = item.as_object_mut().expect("just built");
    obj.insert(
        "skin_group".into(),
        skin_group.map(Value::String).unwrap_or(Value::Null),
    );
    obj.insert(
        "acquisition".into(),
        acquisition.map(Value::String).unwrap_or(Value::Null),
    );
    obj.insert(
        "description".into(),
        description.map(Value::String).unwrap_or(Value::Null),
    );
    item
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_name_normalization() {
        assert_eq!(
            normalized_artwork_form_name(" 阿米娅（近卫） "),
            "阿米娅(近卫)"
        );
        assert_eq!(normalized_artwork_form_name("阿米娅"), "阿米娅");
    }

    #[test]
    fn local_labels_by_shape() {
        let skins = CharSkins::new();
        assert_eq!(
            build_artwork_label("char_002_amiya#2", &skins),
            "精英二立绘"
        );
        assert_eq!(
            build_artwork_label("char_002_amiya#1+", &skins),
            "精英零立绘（变体）"
        );
        assert_eq!(build_artwork_label("char_002_amiya#7", &skins), "立绘 7");
        assert_eq!(build_artwork_label("char_002_amiya", &skins), "立绘");
        // Fashion: display name wins, else theme placeholder.
        let mut skins = CharSkins::new();
        skins.insert(
            "char_002_amiya@theme1#1".into(),
            DisplaySkin {
                skin_name: Some("报童".into()),
                skin_group_name: None,
                obtain_approach: None,
                description: None,
            },
        );
        assert_eq!(
            build_artwork_label("char_002_amiya@theme1#1", &skins),
            "报童"
        );
        assert_eq!(
            build_artwork_label("char_002_amiya@theme2#1", &skins),
            "时装（theme2）"
        );
        assert_eq!(build_artwork_label("char_002_amiya@", &skins), "时装");
    }
}
