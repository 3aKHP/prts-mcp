//! GameData tool dispatchers — port of TS `tools/gamedataTools.ts`.
//!
//! Each dispatcher validates arguments (Zod-equivalent, exact issue
//! wordings), takes one DataView snapshot for the whole call, runs the
//! domain builder, and wraps the result through the unified channel
//! renderer with the oracle's summary overrides.

use serde_json::Value;

use super::output::ToolOutcome;
use super::zodish::{validation_error, Args};
use super::{AppHandle, DispatchResult};
use crate::domain::{enemy, item, operator, operator_stats, search, skill, stage, stage_enemy};

fn invalid_args(tool: &str, joined: String) -> DispatchResult {
    DispatchResult::Outcome(ToolOutcome::error_text(validation_error(tool, &joined)))
}

// --- operator tools ---------------------------------------------------------

pub fn get_operator_archives(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let name = args.required_string("name");
    if let Err(joined) = args.finish() {
        return invalid_args("get_operator_archives", joined);
    }
    let name = name.expect("required_string ok");
    let view = app.snapshot();
    DispatchResult::Outcome(ToolOutcome::text(operator::get_operator_archives(
        &view,
        &app.excel_path(),
        &name,
    )))
}

pub fn get_operator_voicelines(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let name = args.required_string("name");
    if let Err(joined) = args.finish() {
        return invalid_args("get_operator_voicelines", joined);
    }
    let name = name.expect("required_string ok");
    let view = app.snapshot();
    DispatchResult::Outcome(ToolOutcome::text(operator::get_operator_voicelines(
        &view,
        &app.excel_path(),
        &name,
    )))
}

pub fn get_operator_basic_info(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let name = args.required_string("name");
    let action = args.enum_default("action", &["basic", "skills", "stats"], "basic");
    let phase = args.nullish_int("phase", 0, Some(2));
    let level = args.nullish_int("level", 1, None);
    if let Err(joined) = args.finish() {
        return invalid_args("get_operator_basic_info", joined);
    }
    let Some(name) = name else {
        return invalid_args(
            "get_operator_basic_info",
            "name: Invalid input: expected string, received undefined".to_string(),
        );
    };
    let view = app.snapshot();
    let excel_path = app.excel_path();

    if action != "stats" && (phase.is_some() || level.is_some()) {
        return DispatchResult::Outcome(ToolOutcome::text(
            "phase 与 level 仅适用于 action=stats。",
        ));
    }
    if action == "stats" {
        return match operator_stats::build_operator_stats(&view, &excel_path, &name, phase, level) {
            Ok(data) => DispatchResult::Outcome(ToolOutcome {
                summary_override: Some(format!(
                    "干员『{}』的面板数值",
                    data["name"].as_str().unwrap_or("")
                )),
                ..ToolOutcome::structured(operator_stats::render_operator_stats(&data), data)
            }),
            Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
        };
    }
    if action == "skills" {
        return match skill::build_operator_skills(&view, &excel_path, &name) {
            Ok(data) => DispatchResult::Outcome(ToolOutcome {
                summary_override: Some(format!(
                    "干员『{}』的战斗技能",
                    data["name"].as_str().unwrap_or("")
                )),
                ..ToolOutcome::structured(skill::render_operator_skills(&data), data)
            }),
            Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
        };
    }
    match operator::build_operator_basic_info(&view, &excel_path, &name) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome {
            summary_override: Some(format!(
                "干员『{}』的基本信息",
                data["name"].as_str().unwrap_or("")
            )),
            ..ToolOutcome::structured(operator::render_operator_basic_info(&data), data)
        }),
        Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
    }
}

// --- enemy tools ------------------------------------------------------------

pub fn list_enemies(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let threat_level = args.string("threat_level");
    let limit = args.int_default("limit", 1, Some(200), 50);
    let offset = args.int_default("offset", 0, None, 0);
    let full = args.boolean_default("full", false);
    if let Err(joined) = args.finish() {
        return invalid_args("list_enemies", joined);
    }
    let view = app.snapshot();
    match enemy::build_enemies_listing(
        &view,
        &app.excel_path(),
        threat_level.as_deref(),
        limit,
        offset,
        full,
    ) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome::structured(
            enemy::render_enemies_listing(&data),
            data,
        )),
        Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
    }
}

pub fn get_enemy_info(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let name = args.required_string("name");
    let stage_id = args.string("stage_id");
    if let Err(joined) = args.finish() {
        return invalid_args("get_enemy_info", joined);
    }
    let Some(name) = name else {
        return invalid_args(
            "get_enemy_info",
            "name: Invalid input: expected string, received undefined".to_string(),
        );
    };
    let view = app.snapshot();
    // `if (stage_id)` — empty string is falsy and takes the handbook path.
    if let Some(stage_id) = stage_id.filter(|s| !s.is_empty()) {
        return DispatchResult::Outcome(ToolOutcome::text(stage_enemy::get_enemy_stage_info(
            &view,
            &app.levels_path(),
            &name,
            &stage_id,
        )));
    }
    match enemy::build_enemy_info(&view, &app.excel_path(), &name) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome {
            summary_override: Some(format!(
                "敌人『{}』的图鉴",
                data["name"].as_str().unwrap_or("")
            )),
            ..ToolOutcome::structured(enemy::render_enemy_info(&data), data)
        }),
        Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
    }
}

pub fn get_stage_enemies(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let stage_id = args.required_string("stage_id");
    if let Err(joined) = args.finish() {
        return invalid_args("get_stage_enemies", joined);
    }
    let Some(stage_id) = stage_id else {
        return invalid_args(
            "get_stage_enemies",
            "stage_id: Invalid input: expected string, received undefined".to_string(),
        );
    };
    let view = app.snapshot();
    match stage_enemy::build_stage_enemies(&view, &app.levels_path(), &stage_id) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome {
            summary_override: Some(format!(
                "{} 的敌人列表（共 {} 种）",
                data["stage_label"].as_str().unwrap_or(""),
                data["total"].as_i64().unwrap_or(0)
            )),
            ..ToolOutcome::structured(stage_enemy::render_stage_enemies(&data), data)
        }),
        Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
    }
}

pub fn get_enemy_appearances(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let name = args.required_string("name");
    let limit = args.int_default("limit", 1, Some(200), 50);
    let offset = args.int_default("offset", 0, None, 0);
    if let Err(joined) = args.finish() {
        return invalid_args("get_enemy_appearances", joined);
    }
    let Some(name) = name else {
        return invalid_args(
            "get_enemy_appearances",
            "name: Invalid input: expected string, received undefined".to_string(),
        );
    };
    let view = app.snapshot();
    match stage_enemy::build_enemy_appearances(&view, &app.levels_path(), &name, limit, offset) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome::structured(
            stage_enemy::render_enemy_appearances(&data),
            data,
        )),
        Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
    }
}

// --- stage tools ------------------------------------------------------------

pub fn list_stages(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let chapter = args.string("chapter");
    let stage_type = args.string("type");
    let limit = args.int_default("limit", 1, Some(200), 50);
    let offset = args.int_default("offset", 0, None, 0);
    if let Err(joined) = args.finish() {
        return invalid_args("list_stages", joined);
    }
    let view = app.snapshot();
    DispatchResult::Outcome(stage::list_stages(
        &view,
        &app.excel_path(),
        &stage::ListingArgs {
            chapter,
            stage_type,
            limit,
            offset,
        },
    ))
}

pub fn get_stage_info(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let stage_id = args.required_string("stage_id");
    if let Err(joined) = args.finish() {
        return invalid_args("get_stage_info", joined);
    }
    let Some(stage_id) = stage_id else {
        return invalid_args(
            "get_stage_info",
            "stage_id: Invalid input: expected string, received undefined".to_string(),
        );
    };
    let view = app.snapshot();
    match stage::build_stage_info(&view, &app.excel_path(), &stage_id) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome {
            summary_override: Some(format!(
                "关卡『{}』的详情",
                data["name"].as_str().unwrap_or("")
            )),
            ..ToolOutcome::structured(stage::render_stage_info(&view, &data), data)
        }),
        Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
    }
}

// --- item tools -------------------------------------------------------------

pub fn list_items(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let category = args.string("category");
    let limit = args.int_default("limit", 1, Some(200), 50);
    let offset = args.int_default("offset", 0, None, 0);
    if let Err(joined) = args.finish() {
        return invalid_args("list_items", joined);
    }
    let view = app.snapshot();
    match item::build_items_listing(&view, &app.excel_path(), category.as_deref(), limit, offset) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome::structured(
            item::render_items_listing(&data),
            data,
        )),
        Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
    }
}

pub fn get_item_info(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let mut args = Args::new(arguments);
    let name = args.required_string("name");
    if let Err(joined) = args.finish() {
        return invalid_args("get_item_info", joined);
    }
    let Some(name) = name else {
        return invalid_args(
            "get_item_info",
            "name: Invalid input: expected string, received undefined".to_string(),
        );
    };
    let view = app.snapshot();
    match item::build_item_info(&view, &app.excel_path(), &name) {
        Ok(data) => DispatchResult::Outcome(ToolOutcome {
            summary_override: Some(format!(
                "物品『{}』的详情",
                data["name"].as_str().unwrap_or("")
            )),
            ..ToolOutcome::structured(item::render_item_info(&data), data)
        }),
        Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
    }
}

// --- unified search ---------------------------------------------------------

pub fn search(app: &AppHandle, arguments: &Value) -> DispatchResult {
    const SCOPES: [&str; 6] = [
        "operators",
        "enemies",
        "stages",
        "items",
        "building_skills",
        "skills",
    ];
    let mut args = Args::new(arguments);
    let scope = args.required_enum("scope", &SCOPES);
    let pattern = args.required_string("pattern");
    let max_results = args.int_default("max_results", 1, Some(100), 30);
    if let Err(joined) = args.finish() {
        return invalid_args("search", joined);
    }
    let Some(scope) = scope else {
        return invalid_args(
            "search",
            "scope: Invalid option: expected one of \"operators\"|\"enemies\"|\"stages\"|\"items\"|\"building_skills\"|\"skills\""
                .to_string(),
        );
    };
    let Some(pattern) = pattern else {
        return invalid_args(
            "search",
            "pattern: Invalid input: expected string, received undefined".to_string(),
        );
    };
    let view = app.snapshot();
    match search::build_search(&view, &app.excel_path(), &scope, &pattern, max_results) {
        Ok(data) => {
            DispatchResult::Outcome(ToolOutcome::structured(search::render_search(&data), data))
        }
        Err(text) => DispatchResult::Outcome(ToolOutcome::text(text)),
    }
}
