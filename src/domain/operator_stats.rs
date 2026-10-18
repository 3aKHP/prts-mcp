//! Operator stat-panel reader — port of TS `data/operatorStats.ts`.
//!
//! character_table carries two attribute keyframes per elite phase (Lv1 and
//! LvMax); mid-level panels interpolate linearly and round half away from
//! zero. Panels always project the full curated field set (missing frames →
//! all-null fields) so payloads carry the full key set on malformed roots.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::app::DataView;
use crate::domain::messages;
use crate::domain::operator::{operator_not_found, resolve_char_id};
use crate::text::numbers::{is_js_integer, js_number_to_string, round_half_away};

/// Curated panel field set (raw key, Chinese label), in payload order.
pub const PANEL_FIELDS: &[(&str, &str)] = &[
    ("maxHp", "生命上限"),
    ("atk", "攻击"),
    ("def", "防御"),
    ("magicResistance", "法术抗性"),
    ("cost", "部署费用"),
    ("blockCnt", "阻挡数"),
    ("attackSpeed", "攻击速度"),
    ("baseAttackTime", "攻击间隔（秒）"),
    ("respawnTime", "再部署时间（秒）"),
];

fn is_number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

fn project_panel(frame: &Value) -> Map<String, Value> {
    let mut panel = Map::new();
    for (key, _) in PANEL_FIELDS {
        let value = frame.get(*key).and_then(Value::as_f64);
        panel.insert(
            (*key).to_string(),
            value.map(number_value).unwrap_or(Value::Null),
        );
    }
    panel
}

/// Serialize a panel number preserving JSON number semantics: integers as
/// integers (JS cannot distinguish 1 from 1.0), else the exact float.
fn number_value(f: f64) -> Value {
    if is_js_integer(f) && f.abs() < 9.007199254740992e15 {
        Value::from(f as i64)
    } else {
        serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// Linear interpolation with the oracle's exact fallbacks: non-numeric or
/// degenerate-span fields take the upper frame's value when numeric, else
/// the lower's; integral frame pairs truncate, fractional pairs keep 2
/// decimals (both half-away).
pub fn interpolate_attributes(
    lo: &Value,
    hi: &Value,
    level: f64,
    lo_level: f64,
    hi_level: f64,
) -> Map<String, Value> {
    let mut panel = Map::new();
    let span = hi_level - lo_level;
    for (key, _) in PANEL_FIELDS {
        let lo_value = is_number(lo.get(*key));
        let hi_value = is_number(hi.get(*key));
        let value = match (lo_value, hi_value, span > 0.0) {
            (Some(lo_v), Some(hi_v), true) => {
                let ratio = (level - lo_level) / span;
                let raw = lo_v + (hi_v - lo_v) * ratio;
                let integral = is_js_integer(lo_v) && is_js_integer(hi_v);
                if integral {
                    round_half_away(raw, 0).trunc()
                } else {
                    round_half_away(raw, 2)
                }
            }
            (_, Some(hi_v), _) => hi_v,
            (Some(lo_v), _, _) => lo_v,
            (None, None, _) => f64::NAN, // sentinel: null below
        };
        panel.insert(
            (*key).to_string(),
            if value.is_nan() {
                Value::Null
            } else {
                number_value(value)
            },
        );
    }
    panel
}

fn favor_bonus(info: &Value) -> Map<String, Value> {
    // Non-zero curated fields of the max-trust keyframe.
    let frames: Vec<&Value> = info
        .get("favorKeyFrames")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|f| f.is_object()).collect())
        .unwrap_or_default();
    let mut bonus = Map::new();
    let Some(data) = frames.last().and_then(|f| f.get("data")) else {
        return bonus;
    };
    for (key, _) in PANEL_FIELDS {
        if let Some(value) = is_number(data.get(*key)) {
            if value != 0.0 {
                bonus.insert((*key).to_string(), number_value(value));
            }
        }
    }
    bonus
}

fn potential(info: &Value) -> Vec<String> {
    info.get("potentialRanks")
        .and_then(Value::as_array)
        .map(|ranks| {
            ranks
                .iter()
                .filter(|r| r.is_object())
                .filter_map(|r| r.get("description").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn phase_summary(index: usize, phase: &Value) -> Value {
    let frames: Vec<&Value> = phase
        .get("attributesKeyFrames")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|f| f.is_object()).collect())
        .unwrap_or_default();
    let empty = json!({});
    let lv1 = frames.first().and_then(|f| f.get("data")).unwrap_or(&empty);
    let lv_max = frames.last().and_then(|f| f.get("data")).unwrap_or(&empty);
    json!({
        "phase": index,
        "max_level": number_value(phase.get("maxLevel").and_then(Value::as_f64).unwrap_or(0.0)),
        "keyframes": {
            "lv1": Value::Object(project_panel(lv1)),
            "lv_max": Value::Object(project_panel(lv_max)),
        },
    })
}

fn valid_phases(info: &Value) -> Vec<&Value> {
    // Array.isArray convention: AKDP emits {} placeholders where arrays are
    // expected; non-object entries drop out too.
    info.get("phases")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|p| p.is_object()).collect())
        .unwrap_or_default()
}

/// `buildOperatorStats`: Err carries the exact message text.
pub fn build_operator_stats(
    view: &DataView,
    excel_path: &Path,
    name: &str,
    phase: Option<i64>,
    level: Option<i64>,
) -> Result<Value, String> {
    if view.excel_root.is_none() {
        return Err(messages::excel_missing_message("干员", excel_path));
    }
    let char_id = resolve_char_id(view, name)?;
    let table = crate::domain::operator::character_for(view, char_id.as_deref())?;
    let info = char_id
        .as_deref()
        .and_then(|id| table.as_object().and_then(|m| m.get(id)))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let Some(char_id) = char_id else {
        return Err(operator_not_found(name));
    };
    let phases = valid_phases(&info);
    if phases.is_empty() {
        return Err(format!("干员 '{name}' 暂无面板数据。"));
    }

    let has_phase = phase.is_some();
    let has_level = level.is_some();
    if has_phase != has_level {
        return Err("phase 与 level 必须同时提供（如 精英2 Lv40 → phase=2, level=40），或同时省略以查看各阶段关键帧。".to_string());
    }

    let favor = favor_bonus(&info);
    let pots = potential(&info);

    if !has_phase {
        return Ok(json!({
            "name": name,
            "char_id": char_id,
            "phases": phases.iter().enumerate().map(|(i, p)| phase_summary(i, p)).collect::<Vec<_>>(),
            "favor_bonus": Value::Object(favor),
            "potential": pots,
        }));
    }

    let requested_phase = phase.expect("has_phase checked") as usize;
    if requested_phase >= phases.len() {
        return Err(format!(
            "phase 必须在 0..{} 之间（该干员共 {} 个精英阶段）。",
            phases.len() - 1,
            phases.len()
        ));
    }
    let target = phases[requested_phase];
    let frames: Vec<&Value> = target
        .get("attributesKeyFrames")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|f| f.is_object()).collect())
        .unwrap_or_default();
    let max_level = target
        .get("maxLevel")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let Some(level) = level else {
        unreachable!("has_level checked");
    };
    if !(1.0..=max_level).contains(&(level as f64)) {
        return Err(format!(
            "level 必须在 1..{} 之间（精英{requested_phase} 的等级上限为 {}）。",
            js_number_to_string(max_level),
            js_number_to_string(max_level)
        ));
    }
    if frames.is_empty() {
        return Err(format!(
            "干员 '{name}' 的精英{requested_phase}面板关键帧缺失，数据可能损坏。"
        ));
    }
    let lo = frames[0];
    let hi = frames[frames.len() - 1];
    let lo_level = lo.get("level").and_then(Value::as_f64).unwrap_or(1.0);
    let hi_level = hi.get("level").and_then(Value::as_f64).unwrap_or(max_level);
    Ok(json!({
        "name": name,
        "char_id": char_id,
        "phase": requested_phase,
        "level": level,
        "max_level": number_value(max_level),
        "attributes": Value::Object(interpolate_attributes(
            lo.get("data").unwrap_or(&Value::Null),
            hi.get("data").unwrap_or(&Value::Null),
            level as f64,
            lo_level,
            hi_level,
        )),
        "favor_bonus": Value::Object(favor),
        "potential": pots,
    }))
}

fn format_value(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        v => v
            .as_f64()
            .map(js_number_to_string)
            .unwrap_or_else(|| v.to_string()),
    }
}

fn render_bonus(favor: &Value, potential: &[String]) -> Vec<String> {
    let mut lines = Vec::new();
    let labels = |key: &str| {
        PANEL_FIELDS
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, label)| label.to_string())
            .unwrap_or_else(|| key.to_string())
    };
    if let Some(entries) = favor.as_object() {
        if !entries.is_empty() {
            let parts: Vec<String> = entries
                .iter()
                .map(|(k, v)| format!("{}+{}", labels(k), format_value(v)))
                .collect();
            lines.push(format!("\n## 满信赖加成\n\n- {}", parts.join("，")));
        }
    }
    if !potential.is_empty() {
        lines.push(format!(
            "\n## 潜能加成\n\n{}",
            potential
                .iter()
                .map(|p| format!("- {p}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    lines
}

pub fn render_operator_stats(data: &Value) -> String {
    let mut lines = vec![format!(
        "# {} - 面板数值",
        data["name"].as_str().unwrap_or("")
    )];
    if data.get("attributes").is_some() {
        lines.push(format!(
            "\n**精英{} Lv{}**（上限 Lv{}）\n",
            data["phase"].as_i64().unwrap_or(0),
            data["level"].as_i64().unwrap_or(0),
            data["max_level"].as_i64().unwrap_or(0)
        ));
        for (key, label) in PANEL_FIELDS {
            lines.push(format!(
                "- {label}：{}",
                format_value(&data["attributes"][key])
            ));
        }
    } else if let Some(phases) = data.get("phases").and_then(Value::as_array) {
        for phase in phases {
            lines.push(format!(
                "\n## 精英{}（Lv1-{}）\n",
                phase["phase"].as_i64().unwrap_or(0),
                format_value(&phase["max_level"])
            ));
            for (key, label) in PANEL_FIELDS {
                lines.push(format!(
                    "- {label}：Lv1 {} / Lv满 {}",
                    format_value(&phase["keyframes"]["lv1"][key]),
                    format_value(&phase["keyframes"]["lv_max"][key])
                ));
            }
        }
    }
    lines.extend(render_bonus(
        &data["favor_bonus"],
        &data["potential"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    ));
    lines.join("\n")
}
