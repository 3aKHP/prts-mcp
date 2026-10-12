//! Native regex/Unicode and Rust Wiki helpers vs a separately captured frozen Bun oracle.
use prts_mcp_rust::{text::regex_compat::JsRegex, wiki::text_ops};
use serde_json::Value;

#[test]
fn native_regex_matches_extended_bun_corpus() {
    let golden: Value = serde_json::from_str(include_str!(
        "../contracts/cases/golden/native-text-oracle.json"
    ))
    .unwrap();
    let differences: Value = serde_json::from_str(include_str!(
        "../contracts/cases/native-regex-differences.json"
    ))
    .unwrap();
    let mut approved_count = 0;
    let mut mismatches = Vec::new();
    for case in golden["regex"].as_array().unwrap() {
        let pattern = case["pattern"].as_str().unwrap();
        let text = case["text"].as_str().unwrap();
        match JsRegex::compile(pattern) {
            Err(_) => {
                if case["rejected"] != true {
                    mismatches.push(format!("unexpected rejection: {case}"));
                }
            }
            Ok(re) => {
                if case["rejected"] != false {
                    mismatches.push(format!("unexpected acceptance: {case}"));
                } else {
                    let matched = re.is_match(text).unwrap();
                    let approved = differences["cases"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|d| d["pattern"] == case["pattern"] && d["text"] == case["text"]);
                    if let Some(d) = approved {
                        assert_eq!(
                            case["match"], d["bun_match"],
                            "Bun baseline changed: {case}"
                        );
                        assert_eq!(
                            matched, d["rust_match"],
                            "approved Rust behavior changed: {case}"
                        );
                        approved_count += 1;
                    } else if matched != case["match"] {
                        mismatches.push(format!("match differs: {case}"));
                    }
                }
            }
        }
    }
    assert_eq!(
        approved_count,
        differences["cases"].as_array().unwrap().len(),
        "all approved differences exercised exactly once"
    );
    assert!(
        mismatches.is_empty(),
        "{} differences:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

#[test]
fn rust_wiki_helpers_match_frozen_ts_corpus() {
    let golden: Value = serde_json::from_str(include_str!(
        "../contracts/cases/golden/native-text-oracle.json"
    ))
    .unwrap();
    for case in golden["wiki"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let result = match case["helper"].as_str().unwrap() {
            "unescapeHTMLEntities" => text_ops::unescape_html_entities(input).map(Value::String),
            "cleanSnippet" => text_ops::clean_snippet(input).map(Value::String),
            "stripHtml" => text_ops::strip_html(input).map(Value::String),
            "isTechnicalPage" => text_ops::is_technical_page(input).map(Value::Bool),
            "isRedirectLike" => text_ops::is_redirect_like(input).map(Value::Bool),
            other => panic!("unknown helper {other}"),
        };
        match result {
            Err(_) => assert_eq!(case["rejected"], true, "unexpected rejection: {case}"),
            Ok(value) => {
                assert_eq!(case["rejected"], false, "unexpected acceptance: {case}");
                assert_eq!(value, case["output"], "output differs: {case}");
            }
        }
    }
}
