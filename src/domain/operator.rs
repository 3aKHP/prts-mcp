//! Operator data reader — port of TS `data/operator.ts`.
//!
//! Character/handbook/charword tables load lazily through the per-generation
//! dataset cache; payloads preserve the oracle's field order for
//! structuredContent parity.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::app::DataView;
use crate::domain::messages;
use crate::storage::projection::Projection;
use crate::storage::{DirectoryStore, JsonStore};
use crate::text::sanitizer::strip_wikitext;

const PROFESSION_ZH: &[(&str, &str)] = &[
    ("CASTER", "术师"),
    ("MEDIC", "医疗"),
    ("PIONEER", "先锋"),
    ("SNIPER", "狙击"),
    ("SPECIAL", "特种"),
    ("SUPPORT", "辅助"),
    ("TANK", "重装"),
    ("WARRIOR", "近卫"),
];

const POSITION_ZH: &[(&str, &str)] = &[
    ("RANGED", "远程"),
    ("MELEE", "近战"),
    ("ALL", "通用"),
    ("NONE", "-"),
];

// Only panel fields are consumed from attribute frames. Projection preserves
// malformed container types and validates discarded values as ordinary JSON.
const PANEL_DATA: Projection = Projection::Fields(&[
    ("maxHp", Projection::All),
    ("atk", Projection::All),
    ("def", Projection::All),
    ("magicResistance", Projection::All),
    ("cost", Projection::All),
    ("blockCnt", Projection::All),
    ("attackSpeed", Projection::All),
    ("baseAttackTime", Projection::All),
    ("respawnTime", Projection::All),
]);
const ATTRIBUTE_FRAME: Projection =
    Projection::Fields(&[("level", Projection::All), ("data", PANEL_DATA)]);
const PHASE_ENTRY: Projection = Projection::Fields(&[
    ("maxLevel", Projection::All),
    (
        "attributesKeyFrames",
        Projection::Elements(&ATTRIBUTE_FRAME),
    ),
]);
const TALENT_CANDIDATE: Projection = Projection::Fields(&[
    ("name", Projection::All),
    ("description", Projection::All),
    ("requiredPotentialRank", Projection::All),
    (
        "unlockCondition",
        Projection::Fields(&[("phase", Projection::All), ("level", Projection::All)]),
    ),
]);
const TALENT_SLOT: Projection =
    Projection::Fields(&[("candidates", Projection::Elements(&TALENT_CANDIDATE))]);
const SKILL_REF: Projection = Projection::Fields(&[("skillId", Projection::All)]);
const POTENTIAL_RANK: Projection = Projection::Fields(&[("description", Projection::All)]);

// Basic information, stats, skill joins, and name/search/artwork lookups.
const CHARACTER_ENTRY: Projection = Projection::Fields(&[
    ("name", Projection::All),
    ("displayNumber", Projection::All),
    ("appellation", Projection::All),
    ("rarity", Projection::All),
    ("profession", Projection::All),
    ("subProfessionId", Projection::All),
    ("position", Projection::All),
    ("nationId", Projection::All),
    ("groupId", Projection::All),
    ("teamId", Projection::All),
    ("tagList", Projection::All),
    ("description", Projection::All),
    ("itemUsage", Projection::All),
    ("itemDesc", Projection::All),
    ("itemObtainApproach", Projection::All),
    ("talents", Projection::Elements(&TALENT_SLOT)),
    ("skills", Projection::Elements(&SKILL_REF)),
    ("phases", Projection::Elements(&PHASE_ENTRY)),
    ("favorKeyFrames", Projection::Elements(&ATTRIBUTE_FRAME)),
    ("potentialRanks", Projection::Elements(&POTENTIAL_RANK)),
]);

fn talent_phase_zh(phase: &str) -> String {
    match phase {
        "PHASE_0" => "精英0".to_string(),
        "PHASE_1" => "精英1".to_string(),
        "PHASE_2" => "精英2".to_string(),
        other => other.to_string(),
    }
}

fn zh_lookup(table: &[(&str, &str)], raw: &str) -> String {
    table
        .iter()
        .find(|(k, _)| *k == raw)
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| raw.to_string())
}

// ---------------------------------------------------------------------------
// Shared table access (dataset cache)
// ---------------------------------------------------------------------------

/// TS loadJson's operator-file error wording (label + resolved diagnostics
/// path + the mounting hint).
fn operator_file_error(label: &str, store: &DirectoryStore, file: &str) -> String {
    let shown = store
        .resolve(file)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| file.to_string());
    format!(
        "{label}数据文件不存在：{shown}。数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向游戏数据根目录）。"
    )
}

fn excel_store(view: &DataView) -> Option<DirectoryStore> {
    view.excel_root.as_ref().map(DirectoryStore::new)
}

fn load_excel_table(
    view: &DataView,
    slot: &str,
    file: &str,
    label: &str,
    count_key: Option<&str>,
    projection: Projection,
) -> Result<Arc<Value>, String> {
    let Some(root) = view.excel_root.clone() else {
        return Err(format!("__missing__{label}"));
    };
    let store = DirectoryStore::new(&root);
    view.datasets.get_or_load_counted(
        slot,
        move || {
            let exists = store.exists(file).unwrap_or(false);
            if !exists {
                return Err(operator_file_error(label, &store, file));
            }
            store
                .read_json_projected(file, projection)
                .map_err(|e| e.to_string())
        },
        move |table| {
            match count_key {
                // TS loader count overrides (operator.ts): handbookDict /
                // charWords keys rather than the file root.
                Some(key) => table
                    .pointer(key)
                    .and_then(Value::as_object)
                    .map(|m| m.len() as u64)
                    .unwrap_or(0),
                None => table.as_object().map(|m| m.len() as u64).unwrap_or(0),
            }
        },
    )
}

pub fn character_table(view: &DataView) -> Result<Arc<Value>, String> {
    load_excel_table(
        view,
        "operator:character_table",
        "character_table.json",
        "干员",
        None,
        Projection::Values(&CHARACTER_ENTRY),
    )
}

pub fn handbook_table(view: &DataView) -> Result<Arc<Value>, String> {
    load_excel_table(
        view,
        "operator:handbook_table",
        "handbook_info_table.json",
        "干员",
        Some("/handbookDict"),
        Projection::All,
    )
}

pub fn charword_table(view: &DataView) -> Result<Arc<Value>, String> {
    load_excel_table(
        view,
        "operator:charword_table",
        "charword_table.json",
        "干员",
        Some("/charWords"),
        Projection::All,
    )
}

/// name → charId folding (`buildNameToIdImpl`): only `char_`-prefixed ids
/// with a name enter the map; duplicate names collapse to the LAST cid while
/// JS Map.set keeps first-insertion position (later set overwrites value,
/// not position).
pub fn name_to_char_id(view: &DataView) -> Result<Arc<Vec<(String, String)>>, String> {
    view.datasets.get_or_load_counted(
        "operator:name_to_id",
        || {
            let ct = character_table(view)?;
            let map = ct
                .as_object()
                .map(|m| {
                    m.iter()
                        .filter(|(cid, info)| {
                            cid.starts_with("char_")
                                && info.get("name").and_then(Value::as_str).is_some()
                        })
                        .map(|(cid, info)| {
                            (
                                info.get("name")
                                    .and_then(Value::as_str)
                                    .unwrap()
                                    .to_string(),
                                cid.clone(),
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            // JS Map: later duplicate names replace the value at the original
            // insertion position — fold to last value keeping first position.
            let mut folded: Vec<(String, String)> = Vec::new();
            let mut index: std::collections::HashMap<String, usize> =
                std::collections::HashMap::new();
            for (name, cid) in map {
                match index.get(&name) {
                    Some(&pos) => folded[pos].1 = cid,
                    None => {
                        index.insert(name.clone(), folded.len());
                        folded.push((name, cid));
                    }
                }
            }
            Ok(folded)
        },
        |folded| folded.len() as u64,
    )
}

pub fn resolve_char_id(view: &DataView, name: &str) -> Result<Option<String>, String> {
    Ok(name_to_char_id(view)?
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, cid)| cid.clone()))
}

/// TS `未找到干员` message shared by every operator entry point.
fn operator_not_found(name: &str) -> String {
    format!("未找到干员 '{name}'。请使用游戏内中文名称（如'阿米娅'）。")
}

// ---------------------------------------------------------------------------
// getOperatorArchives / getOperatorVoicelines
// ---------------------------------------------------------------------------

pub fn get_operator_archives(view: &DataView, excel_path: &Path, name: &str) -> String {
    if view.excel_root.is_none() {
        return messages::excel_missing_message("干员", excel_path);
    }
    let char_id = match resolve_char_id(view, name) {
        Ok(Some(id)) => id,
        Ok(None) => return operator_not_found(name),
        Err(err) => return err,
    };
    let handbook = match handbook_table(view) {
        Ok(t) => t,
        Err(err) => return err,
    };
    let Some(entry) = handbook
        .pointer("/handbookDict")
        .and_then(Value::as_object)
        .and_then(|d| d.get(&char_id))
    else {
        return format!("干员 '{name}' 暂无档案数据。");
    };

    let mut sections: Vec<String> = Vec::new();
    for story in entry
        .get("storyTextAudio")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let title = story
            .get("storyTitle")
            .and_then(Value::as_str)
            .unwrap_or("");
        let texts: Vec<&str> = story
            .get("stories")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .filter_map(|s| s.get("storyText").and_then(Value::as_str))
            .filter(|t| !t.is_empty())
            .collect();
        if !texts.is_empty() {
            sections.push(format!("### {title}\n{}", texts.join("\n")));
        }
    }
    if sections.is_empty() {
        return format!("干员 '{name}' 档案内容为空。");
    }
    format!("# {name} - 干员档案\n\n{}", sections.join("\n\n"))
}

pub fn get_operator_voicelines(view: &DataView, excel_path: &Path, name: &str) -> String {
    if view.excel_root.is_none() {
        return messages::excel_missing_message("干员", excel_path);
    }
    let char_id = match resolve_char_id(view, name) {
        Ok(Some(id)) => id,
        Ok(None) => return operator_not_found(name),
        Err(err) => return err,
    };
    let charwords = match charword_table(view) {
        Ok(t) => t,
        Err(err) => return err,
    };
    let mut lines: Vec<String> = Vec::new();
    if let Some(words) = charwords.pointer("/charWords").and_then(Value::as_object) {
        for entry in words.values() {
            let matches = entry.get("charId").and_then(Value::as_str) == Some(char_id.as_str());
            let Some(text) = entry.get("voiceText").and_then(Value::as_str) else {
                continue;
            };
            if matches {
                let title = entry
                    .get("voiceTitle")
                    .and_then(Value::as_str)
                    .unwrap_or("未知");
                lines.push(format!("**{title}**: {text}"));
            }
        }
    }
    if lines.is_empty() {
        return format!("干员 '{name}' 暂无语音数据。");
    }
    format!("# {name} - 语音记录\n\n{}", lines.join("\n"))
}

// ---------------------------------------------------------------------------
// buildOperatorBasicInfo / render
// ---------------------------------------------------------------------------

fn talent_candidates(slot: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for c in slot
        .get("candidates")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let Some(name) = c.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name.is_empty() || name == "？？？" {
            continue;
        }
        let unlock_condition = c.get("unlockCondition").filter(|v| v.is_object());
        let phase = unlock_condition
            .and_then(|u| u.get("phase"))
            .and_then(Value::as_str)
            .unwrap_or("");
        // `level || 1`: missing, null and 0 all fall back to 1.
        let unlock_level = unlock_condition
            .and_then(|u| u.get("level"))
            .and_then(Value::as_f64)
            .filter(|l| *l != 0.0)
            .unwrap_or(1.0);
        out.push(json!({
            "name": name,
            "description": strip_wikitext(c.get("description").and_then(Value::as_str).unwrap_or("")),
            "unlock": talent_phase_zh(phase),
            "unlock_level": unlock_level,
            "potential_rank": c.get("requiredPotentialRank").and_then(Value::as_i64).unwrap_or(0),
        }));
    }
    out
}

pub fn build_operator_basic_info(
    view: &DataView,
    excel_path: &Path,
    name: &str,
) -> Result<Value, String> {
    if view.excel_root.is_none() {
        return Err(messages::excel_missing_message("干员", excel_path));
    }
    let char_id = match resolve_char_id(view, name)? {
        Some(id) => id,
        None => return Err(operator_not_found(name)),
    };
    let ct = character_table(view)?;
    let Some(info) = ct.as_object().and_then(|m| m.get(&char_id)) else {
        return Err(format!("干员 '{name}' 暂无基本信息。"));
    };

    let get_s = |key: &str| info.get(key).and_then(Value::as_str).unwrap_or("");
    let rarity_raw = get_s("rarity");
    let rarity = rarity_raw
        .strip_prefix("TIER_")
        .map(|rest| format!("{rest}★"))
        .unwrap_or_else(|| rarity_raw.to_string());
    let profession_raw = get_s("profession");
    let position_raw = get_s("position");

    let affiliation_parts: Vec<&str> = [
        info.get("nationId").and_then(Value::as_str),
        info.get("groupId").and_then(Value::as_str),
        info.get("teamId").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect();
    let affiliation = if affiliation_parts.is_empty() {
        "-".to_string()
    } else {
        affiliation_parts.join(" / ")
    };

    let mut talents: Vec<Value> = Vec::new();
    for slot in info
        .get("talents")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let tier_candidates = talent_candidates(slot);
        if let Some(chosen) = tier_candidates.last() {
            talents.push(json!({
                "name": chosen["name"].clone(),
                "description": chosen["description"].clone(),
                "candidates": tier_candidates,
            }));
        }
    }

    let mut payload = Map::new();
    payload.insert("name".into(), json!(name));
    payload.insert("display_number".into(), json!(get_s("displayNumber")));
    payload.insert("appellation".into(), json!(get_s("appellation")));
    payload.insert("rarity".into(), json!(rarity));
    payload.insert("rarity_raw".into(), json!(rarity_raw));
    payload.insert(
        "profession".into(),
        json!(zh_lookup(PROFESSION_ZH, profession_raw)),
    );
    payload.insert("profession_raw".into(), json!(profession_raw));
    payload.insert("sub_profession_id".into(), json!(get_s("subProfessionId")));
    payload.insert(
        "position".into(),
        json!(zh_lookup(POSITION_ZH, position_raw)),
    );
    payload.insert("position_raw".into(), json!(position_raw));
    payload.insert("affiliation".into(), json!(affiliation));
    payload.insert(
        "tag_list".into(),
        json!(info
            .get("tagList")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()),
    );
    payload.insert(
        "attack_attribute".into(),
        match info.get("description").and_then(Value::as_str) {
            Some(desc) if !desc.is_empty() => json!(strip_wikitext(desc)),
            _ => Value::Null,
        },
    );
    payload.insert(
        "item_usage".into(),
        non_empty(info.get("itemUsage")).unwrap_or(Value::Null),
    );
    payload.insert(
        "item_desc".into(),
        non_empty(info.get("itemDesc")).unwrap_or(Value::Null),
    );
    payload.insert(
        "item_obtain".into(),
        non_empty(info.get("itemObtainApproach")).unwrap_or(Value::Null),
    );
    payload.insert("talents".into(), json!(talents));

    // building_skills: omitted (not []) when building_data.json is absent —
    // older user roots keep the pre-2.7.0 payload shape.
    if let Some(store) = excel_store(view) {
        if store.exists("building_data.json").unwrap_or(false) {
            if let Ok(skills) = crate::domain::building::building_skills_for(view, &char_id) {
                payload.insert("building_skills".into(), json!(skills));
            }
        }
    }

    Ok(Value::Object(payload))
}

/// JS truthiness for the `field || null` payload fields: empty string,
/// null, 0 and false all become null; everything else is kept verbatim.
fn non_empty(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let truthy = match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    };
    truthy.then(|| value.clone())
}

/// `talentTierNote`: dedup unlock conditions → "first解锁" + "rest强化" +
/// optional potential line.
fn talent_tier_note(candidates: &[Value]) -> String {
    let mut conditions: Vec<String> = Vec::new();
    for c in candidates {
        let unlock = c.get("unlock").and_then(Value::as_str).unwrap_or("");
        if unlock.is_empty() {
            continue;
        }
        let level = c.get("unlock_level").and_then(Value::as_f64).unwrap_or(0.0);
        let condition = if level > 1.0 {
            format!("{unlock} Lv{level}")
        } else {
            unlock.to_string()
        };
        if !conditions.contains(&condition) {
            conditions.push(condition);
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(first) = conditions.first() {
        parts.push(format!("{first}解锁"));
    }
    for condition in conditions.iter().skip(1) {
        parts.push(format!("{condition}强化"));
    }
    let max_rank = candidates
        .iter()
        .map(|c| c.get("potential_rank").and_then(Value::as_i64).unwrap_or(0))
        .max()
        .unwrap_or(0);
    if max_rank > 0 {
        parts.push(format!("潜能{}档强化", max_rank + 1));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("（{}）", parts.join("；"))
    }
}

pub fn render_operator_basic_info(data: &Value) -> String {
    let get_s = |key: &str| data.get(key).and_then(Value::as_str).unwrap_or("");
    let mut lines = vec![format!("# {} - 干员基本信息\n", get_s("name"))];
    lines.push(format!("- **编号**：{}", get_s("display_number")));
    lines.push(format!("- **英文名**：{}", get_s("appellation")));
    lines.push(format!("- **稀有度**：{}", get_s("rarity")));
    lines.push(format!(
        "- **职业**：{}（{}）",
        get_s("profession"),
        get_s("sub_profession_id")
    ));
    lines.push(format!("- **站位**：{}", get_s("position")));
    lines.push(format!("- **所属**：{}", get_s("affiliation")));
    if let Some(tags) = data.get("tag_list").and_then(Value::as_array) {
        if !tags.is_empty() {
            let names: Vec<&str> = tags.iter().filter_map(Value::as_str).collect();
            lines.push(format!("- **招募标签**：{}", names.join("、")));
        }
    }
    if let Some(attr) = data.get("attack_attribute").and_then(Value::as_str) {
        if !attr.is_empty() {
            lines.push(format!("- **攻击属性**：{attr}"));
        }
    }
    if let Some(usage) = data.get("item_usage").and_then(Value::as_str) {
        if !usage.is_empty() {
            lines.push(format!("\n**图鉴**：{usage}"));
        }
    }
    if let Some(desc) = data.get("item_desc").and_then(Value::as_str) {
        if !desc.is_empty() {
            lines.push(format!("\n> {desc}"));
        }
    }
    if let Some(obtain) = data.get("item_obtain").and_then(Value::as_str) {
        if !obtain.is_empty() {
            lines.push(format!("\n**获取方式**：{obtain}"));
        }
    }
    if let Some(talents) = data.get("talents").and_then(Value::as_array) {
        if !talents.is_empty() {
            lines.push("\n## 天赋".to_string());
            for talent in talents {
                lines.push(format!(
                    "- **{}**：{}",
                    talent["name"].as_str().unwrap_or(""),
                    talent["description"].as_str().unwrap_or("")
                ));
                let note = talent_tier_note(
                    talent
                        .get("candidates")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                );
                if !note.is_empty() {
                    lines.push(format!("  {note}"));
                }
            }
        }
    }
    if let Some(skills) = data.get("building_skills").and_then(Value::as_array) {
        if !skills.is_empty() {
            lines.push("\n## 基建技能".to_string());
            for skill in skills {
                lines.push(format!(
                    "- **{}**（{}，{}解锁）：{}",
                    skill["name"].as_str().unwrap_or(""),
                    skill["room"].as_str().unwrap_or(""),
                    skill["unlock"].as_str().unwrap_or(""),
                    skill["description"].as_str().unwrap_or("")
                ));
            }
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod projection_tests {
    use super::*;
    use crate::domain::datasets::Datasets;
    use crate::domain::operator_stats::{build_operator_stats, PANEL_FIELDS};

    fn view(table: Value) -> DataView {
        let datasets = Arc::new(Datasets::new());
        datasets
            .get_or_load("operator:character_table", || Ok(table))
            .unwrap();
        DataView {
            excel_root: Some(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/native-smoke/zh_CN/gamedata/excel"),
            ),
            levels_root: None,
            story_zip: None,
            datasets,
        }
    }

    #[test]
    fn panel_projection_covers_every_consumed_field() {
        let Projection::Fields(fields) = PANEL_DATA else {
            unreachable!()
        };
        assert_eq!(
            fields.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
            PANEL_FIELDS.iter().map(|(key, _)| *key).collect::<Vec<_>>()
        );
    }

    #[test]
    fn nested_projection_preserves_basic_and_stats_for_malformed_shapes() {
        let original = json!({"char_test": {
            "name":"测试", "rarity":"TIER_5", "profession":"CASTER",
            "talents":[{"candidates":[{"name":"天赋", "description":"描述",
                "unlockCondition":{"phase":"PHASE_1","level":0,"unused":true},
                "requiredPotentialRank":4,"blackboard":[{"ignored":true}]}]}],
            "phases":[{"maxLevel":50,"evolveCost":[{"unused":42}],"attributesKeyFrames":[
                {"level":1,"data":{"maxHp":100,"atk":10,"unused":42}},
                {"level":50,"data":{"maxHp":500,"atk":20,"unused":42}}]}],
            "favorKeyFrames":[{"level":200,"data":{"atk":25,"unused":42}}],
            "potentialRanks":[{"description":"部署费用-1","buff":{"unused":true}}]
        }});
        let mut cases = vec![original.clone()];
        for path in [
            "talents",
            "talents/0/candidates",
            "talents/0/candidates/0/unlockCondition",
            "phases",
            "phases/0",
            "phases/0/attributesKeyFrames",
            "phases/0/attributesKeyFrames/0/data",
            "favorKeyFrames",
            "favorKeyFrames/0/data",
            "potentialRanks",
        ] {
            for shape in [
                json!(null),
                json!(false),
                json!(7),
                json!("x"),
                json!({}),
                json!([]),
                json!([null, {}, false]),
            ] {
                let mut case = original.clone();
                *case.pointer_mut(&format!("/char_test/{path}")).unwrap() = shape;
                cases.push(case);
            }
        }
        for table in cases {
            let projected = crate::storage::projection::from_str(
                &table.to_string(),
                Projection::Values(&CHARACTER_ENTRY),
            )
            .unwrap();
            let full = view(table.clone());
            let compact = view(projected);
            assert_eq!(
                build_operator_basic_info(&full, Path::new(""), "测试"),
                build_operator_basic_info(&compact, Path::new(""), "测试"),
                "{table}"
            );
            for (phase, level) in [(None, None), (Some(0), Some(10)), (Some(1), Some(90))] {
                assert_eq!(
                    build_operator_stats(&full, Path::new(""), "测试", phase, level),
                    build_operator_stats(&compact, Path::new(""), "测试", phase, level),
                    "{table}"
                );
            }
        }
    }
}
