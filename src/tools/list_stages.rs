//! list_stages tool: parameter boundary (Zod-equivalent) + thin dispatch.

use serde_json::Value;

use super::output::ToolOutcome;
use super::{AppHandle, DispatchResult};
use crate::domain::stage::{self, ListingArgs};
use crate::text::js_compat::{json_number_as_integer, json_number_is_integer};

/// Zod's `received <type>` wording for the JSON type at hand.
fn js_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

struct FieldIssues {
    chapter: Option<String>,
    stage_type: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    errors: Vec<String>,
}

/// Validate arguments like `z.object({chapter: z.string().optional(), type:
/// z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
/// offset: z.number().int().min(0).default(0)})` — unknown keys stripped,
/// issues collected in schema order and joined with ", ".
fn validate_arguments(args: &Value) -> Result<ListingArgs, String> {
    let obj = match args.as_object() {
        Some(o) => o,
        None => return Err("__not_record__".to_string()),
    };
    let mut out = FieldIssues {
        chapter: None,
        stage_type: None,
        limit: None,
        offset: None,
        errors: Vec::new(),
    };

    if let Some(v) = obj.get("chapter") {
        match v.as_str() {
            Some(s) => out.chapter = Some(s.to_string()),
            None => out.errors.push(format!(
                "chapter: Invalid input: expected string, received {}",
                js_type_name(v)
            )),
        }
    }
    if let Some(v) = obj.get("type") {
        match v.as_str() {
            Some(s) => out.stage_type = Some(s.to_string()),
            None => out.errors.push(format!(
                "type: Invalid input: expected string, received {}",
                js_type_name(v)
            )),
        }
    }
    if let Some(v) = obj.get("limit") {
        match v.as_number() {
            Some(n) if json_number_is_integer(n) => {
                let value = json_number_as_integer(n).expect("integral number yields i64");
                if value < 1 {
                    out.errors
                        .push("limit: Too small: expected number to be >=1".to_string());
                } else if value > 200 {
                    out.errors
                        .push("limit: Too big: expected number to be <=200".to_string());
                } else {
                    out.limit = Some(value);
                }
            }
            Some(_) => out
                .errors
                .push("limit: Invalid input: expected int, received number".to_string()),
            None => out.errors.push(format!(
                "limit: Invalid input: expected number, received {}",
                js_type_name(v)
            )),
        }
    }
    if let Some(v) = obj.get("offset") {
        match v.as_number() {
            Some(n) if json_number_is_integer(n) => {
                let value = json_number_as_integer(n).expect("integral number yields i64");
                if value < 0 {
                    out.errors
                        .push("offset: Too small: expected number to be >=0".to_string());
                } else {
                    out.offset = Some(value);
                }
            }
            Some(_) => out
                .errors
                .push("offset: Invalid input: expected int, received number".to_string()),
            None => out.errors.push(format!(
                "offset: Invalid input: expected number, received {}",
                js_type_name(v)
            )),
        }
    }

    if !out.errors.is_empty() {
        return Err(out.errors.join(", "));
    }
    Ok(ListingArgs {
        chapter: out.chapter,
        stage_type: out.stage_type,
        limit: out.limit.unwrap_or(50),
        offset: out.offset.unwrap_or(0),
    })
}

pub fn dispatch(app: &AppHandle, arguments: &Value) -> DispatchResult {
    let args = match validate_arguments(arguments) {
        Ok(a) => a,
        Err(joined) => {
            return DispatchResult::Outcome(ToolOutcome::error_text(format!(
                "Input validation error: Invalid arguments for tool list_stages: {joined}"
            )))
        }
    };
    let Some(store) = app.excel.as_ref() else {
        return DispatchResult::Outcome(ToolOutcome::text(format!(
            "{}（关卡数据文件不存在：stage_table.json）",
            app.excel_missing_message
        )));
    };
    DispatchResult::Outcome(stage::list_stages(store, &app.excel_missing_message, &args))
}
