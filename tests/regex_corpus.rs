//! Original regex corpus differential: native adapter vs the Bun oracle golden
//! (contracts/cases/golden/regex-oracle.json).
//!
//! Accept/reject and match booleans must agree on every case. Engine error
//! wording is D-003 (presence recorded, not compared). Any disagreement is a
//! P1-blocking unexplained diff per docs/02-architecture.md.

use prts_mcp_rust::text::regex_compat::JsRegex;
use serde_json::Value;

#[test]
fn native_component_matches_original_bun_oracle_corpus() {
    let root = env!("CARGO_MANIFEST_DIR");
    let corpus: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/contracts/cases/regex-corpus.json"
    )))
    .expect("corpus parses");
    let golden: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/contracts/cases/golden/regex-oracle.json"
    )))
    .expect("golden parses");
    let _ = root;

    let cases = corpus["cases"].as_array().expect("cases array");
    let expected: std::collections::HashMap<String, &Value> = golden["results"]
        .as_array()
        .expect("results array")
        .iter()
        .map(|r| (r["id"].as_str().expect("id").to_string(), r))
        .collect();

    assert_eq!(
        cases.len(),
        expected.len(),
        "corpus and golden cover the same ids"
    );

    let mut mismatches = Vec::new();
    for case in cases {
        let id = case["id"].as_str().expect("id");
        let pattern = case["pattern"].as_str().expect("pattern");
        let text = case["text"].as_str().expect("text");
        let oracle = expected[id];

        let oracle_rejected = oracle["rejected"].as_bool().expect("rejected bool");
        match JsRegex::compile(pattern) {
            Ok(re) => {
                if oracle_rejected {
                    mismatches.push(format!(
                        "{id}: oracle rejected the pattern, native engine accepted it"
                    ));
                    continue;
                }
                let matched = re.is_match(text).unwrap_or_else(|e| {
                    mismatches.push(format!("{id}: runtime error {e}"));
                    false
                });
                let oracle_match = oracle["match"].as_bool().expect("match bool");
                if matched != oracle_match {
                    mismatches.push(format!(
                        "{id}: match {matched} != oracle {oracle_match} (pattern={pattern:?})"
                    ));
                }
            }
            Err(message) => {
                if !oracle_rejected {
                    mismatches.push(format!(
                        "{id}: oracle accepted the pattern, native engine rejected it: {message}"
                    ));
                }
                // D-003: rejection wording is engine-specific; both rejected.
            }
        }
    }

    assert!(
        mismatches.is_empty(),
        "unexplained regex differences ({}):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
