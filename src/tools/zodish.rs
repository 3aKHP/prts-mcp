//! Zod-equivalent argument boundaries for the tool layer.
//!
//! Mirrors the frozen oracle's Zod 4.3.6 object schemas: unknown keys are
//! stripped, issues are collected in schema order and joined with ", ",
//! wrapped by the SDK as
//! `Input validation error: Invalid arguments for tool <name>: <issues>`.
//! Exact issue wordings were probed on the oracle's node against its own
//! node_modules/zod (see reports/P3.md).

use serde_json::Value;

/// Zod's `received <type>` wording for the JSON type at hand.
pub fn js_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub struct Args<'a> {
    obj: Option<&'a serde_json::Map<String, Value>>,
    issues: Vec<String>,
}

impl<'a> Args<'a> {
    /// Parse the arguments envelope; `None` result means "not a record" (the
    /// caller short-circuits with the object-type issue).
    pub fn new(value: &'a Value) -> Self {
        Self {
            obj: value.as_object(),
            issues: Vec::new(),
        }
    }

    pub fn not_record(&self) -> bool {
        self.obj.is_none()
    }

    fn issue(&mut self, field: &str, message: String) {
        self.issues.push(format!("{field}: {message}"));
    }

    /// `z.string().optional()`: null is NOT accepted (probed).
    pub fn string(&mut self, field: &str) -> Option<String> {
        match self.obj.and_then(|o| o.get(field)) {
            None | Some(Value::Null) => {
                if let Some(v) = self.obj.and_then(|o| o.get(field)) {
                    self.issue(
                        field,
                        format!(
                            "Invalid input: expected string, received {}",
                            js_type_name(v)
                        ),
                    );
                }
                None
            }
            Some(Value::String(s)) => Some(s.clone()),
            Some(v) => {
                self.issue(
                    field,
                    format!(
                        "Invalid input: expected string, received {}",
                        js_type_name(v)
                    ),
                );
                None
            }
        }
    }

    /// `z.string()` (required): missing yields `received undefined`.
    pub fn required_string(&mut self, field: &str) -> Option<String> {
        match self.obj.and_then(|o| o.get(field)) {
            None => {
                self.issue(
                    field,
                    "Invalid input: expected string, received undefined".to_string(),
                );
                None
            }
            Some(_) => self.string(field),
        }
    }

    /// `z.enum([...]).default(d)`: undefined takes the default; anything not
    /// in the option set (including null) yields the Invalid option wording
    /// without a received clause (probed).
    pub fn enum_default(&mut self, field: &str, options: &[&str], default: &str) -> String {
        match self.obj.and_then(|o| o.get(field)) {
            None => default.to_string(),
            Some(Value::String(s)) => {
                if options.contains(&s.as_str()) {
                    s.clone()
                } else {
                    self.issue(
                        field,
                        format!(
                            "Invalid option: expected one of {}",
                            options
                                .iter()
                                .map(|o| format!("\"{o}\""))
                                .collect::<Vec<_>>()
                                .join("|")
                        ),
                    );
                    default.to_string()
                }
            }
            Some(_) => {
                self.issue(
                    field,
                    format!(
                        "Invalid option: expected one of {}",
                        options
                            .iter()
                            .map(|o| format!("\"{o}\""))
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                );
                default.to_string()
            }
        }
    }

    /// `z.enum([...]).optional()`: missing is fine; present-but-invalid or
    /// null yields the Invalid-option wording.
    pub fn optional_enum(&mut self, field: &str, options: &[&str]) -> Option<String> {
        match self.obj.and_then(|o| o.get(field)) {
            None => None,
            Some(Value::String(s)) if options.contains(&s.as_str()) => Some(s.clone()),
            Some(_) => {
                self.issue(
                    field,
                    format!(
                        "Invalid option: expected one of {}",
                        options
                            .iter()
                            .map(|o| format!("\"{o}\""))
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                );
                None
            }
        }
    }

    /// `z.enum([...])` (required): a MISSING value already yields the
    /// Invalid-option wording (probed on prts_page.action).
    pub fn required_enum(&mut self, field: &str, options: &[&str]) -> Option<String> {
        match self.obj.and_then(|o| o.get(field)) {
            None => {
                self.issue(
                    field,
                    format!(
                        "Invalid option: expected one of {}",
                        options
                            .iter()
                            .map(|o| format!("\"{o}\""))
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                );
                None
            }
            Some(Value::String(s)) if options.contains(&s.as_str()) => Some(s.clone()),
            Some(_) => {
                self.issue(
                    field,
                    format!(
                        "Invalid option: expected one of {}",
                        options
                            .iter()
                            .map(|o| format!("\"{o}\""))
                            .collect::<Vec<_>>()
                            .join("|")
                    ),
                );
                None
            }
        }
    }

    fn int_value(&mut self, field: &str, v: &Value) -> Option<i64> {
        use crate::text::js_compat::{json_number_as_integer, json_number_is_integer};
        match v.as_number() {
            Some(n) if json_number_is_integer(n) => json_number_as_integer(n),
            Some(_) => {
                self.issue(
                    field,
                    "Invalid input: expected int, received number".to_string(),
                );
                None
            }
            None => {
                self.issue(
                    field,
                    format!(
                        "Invalid input: expected number, received {}",
                        js_type_name(v)
                    ),
                );
                None
            }
        }
    }

    /// `z.number().int().min().max().default(d)`: undefined takes the
    /// default; null is rejected (probed).
    pub fn int_default(&mut self, field: &str, min: i64, max: Option<i64>, default: i64) -> i64 {
        let Some(v) = self.obj.and_then(|o| o.get(field)) else {
            return default;
        };
        let Some(value) = self.int_value(field, v) else {
            return default;
        };
        if value < min {
            self.issue(field, format!("Too small: expected number to be >={min}"));
            return default;
        }
        if let Some(max) = max {
            if value > max {
                self.issue(field, format!("Too big: expected number to be <={max}"));
                return default;
            }
        }
        value
    }

    /// `z.number().int().optional()`: missing is fine, null is REJECTED
    /// (unlike nullish); no bounds on this field.
    pub fn optional_int(&mut self, field: &str) -> Option<i64> {
        let v = self.obj.and_then(|o| o.get(field))?;
        if v.is_null() {
            self.issue(
                field,
                "Invalid input: expected number, received null".to_string(),
            );
            return None;
        }
        self.int_value(field, v)
    }

    /// `z.number().int().min().max().nullish()`: missing and null both
    /// resolve to None; out-of-range yields the bounds issue (probed).
    pub fn nullish_int(&mut self, field: &str, min: i64, max: Option<i64>) -> Option<i64> {
        let v = self.obj.and_then(|o| o.get(field))?;
        if v.is_null() {
            return None;
        }
        let value = self.int_value(field, v)?;
        if value < min {
            self.issue(field, format!("Too small: expected number to be >={min}"));
            return None;
        }
        if let Some(max) = max {
            if value > max {
                self.issue(field, format!("Too big: expected number to be <={max}"));
                return None;
            }
        }
        Some(value)
    }

    /// `z.boolean().default(d)`: null rejected (probed).
    pub fn boolean_default(&mut self, field: &str, default: bool) -> bool {
        match self.obj.and_then(|o| o.get(field)) {
            None => default,
            Some(Value::Bool(b)) => *b,
            Some(v) => {
                self.issue(
                    field,
                    format!(
                        "Invalid input: expected boolean, received {}",
                        js_type_name(v)
                    ),
                );
                default
            }
        }
    }

    /// Collected issues joined the way the SDK prints them.
    pub fn finish(self) -> Result<(), String> {
        if self.issues.is_empty() {
            Ok(())
        } else {
            Err(self.issues.join(", "))
        }
    }
}

/// The SDK's wrapper around a failed parse.
pub fn validation_error(tool: &str, joined: &str) -> String {
    format!("Input validation error: Invalid arguments for tool {tool}: {joined}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn issue_wordings_match_zod_probes() {
        let args_v = json!({"chapter": 5, "limit": "x", "offset": -1});
        let mut a = Args::new(&args_v);
        a.string("chapter");
        a.int_default("limit", 1, Some(200), 50);
        a.int_default("offset", 0, None, 0);
        let joined = a.finish().unwrap_err();
        assert_eq!(
            joined,
            "chapter: Invalid input: expected string, received number, limit: Invalid input: expected number, received string, offset: Too small: expected number to be >=0"
        );

        let args_v = json!({"action": "nope"});
        let mut a = Args::new(&args_v);
        a.enum_default("action", &["basic", "skills", "stats"], "basic");
        assert_eq!(
            a.finish().unwrap_err(),
            "action: Invalid option: expected one of \"basic\"|\"skills\"|\"stats\""
        );

        let args_v = json!({"full": 1});
        let mut a = Args::new(&args_v);
        a.boolean_default("full", false);
        assert_eq!(
            a.finish().unwrap_err(),
            "full: Invalid input: expected boolean, received number"
        );

        let args_v = json!({"phase": null, "level": 1.5});
        let mut a = Args::new(&args_v);
        assert_eq!(a.nullish_int("phase", 0, Some(2)), None);
        assert_eq!(a.nullish_int("level", 1, None), None);
        assert_eq!(
            a.finish().unwrap_err(),
            "level: Invalid input: expected int, received number"
        );

        let args_v = json!({"scope": "operators2", "pattern": "x"});
        let mut a = Args::new(&args_v);
        assert!(a
            .required_enum(
                "scope",
                &[
                    "operators",
                    "enemies",
                    "stages",
                    "items",
                    "building_skills",
                    "skills"
                ]
            )
            .is_none());
        assert_eq!(a.required_string("pattern"), Some("x".to_string()));
        assert_eq!(
            a.finish().unwrap_err(),
            "scope: Invalid option: expected one of \"operators\"|\"enemies\"|\"stages\"|\"items\"|\"building_skills\"|\"skills\""
        );
    }

    #[test]
    fn integral_floats_and_defaults() {
        let args_v = json!({"limit": 3.0, "phase": 2.0});
        let mut a = Args::new(&args_v);
        assert_eq!(a.int_default("limit", 1, Some(200), 50), 3);
        assert_eq!(a.nullish_int("phase", 0, Some(2)), Some(2));
        assert!(a.finish().is_ok());

        let args_v = json!({});
        let mut a = Args::new(&args_v);
        assert_eq!(a.int_default("limit", 1, Some(200), 50), 50);
        assert!(!a.boolean_default("full", false));
        assert_eq!(
            a.enum_default("action", &["basic", "skills", "stats"], "basic"),
            "basic"
        );
        assert!(a.finish().is_ok());
    }
}
