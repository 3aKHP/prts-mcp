//! Zip validation hooks — ports of `datasets.ts:missingEntries` /
//! `validateStoryjsonZip` and `releaseActivation.ts:validateArchiveZip`.
//!
//! All validators return the list of missing/invalid entries (empty = valid)
//! or an Err message when the zip itself cannot be opened (the caller turns
//! that into "{basename} is not a valid zip: …").

use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::sync::types::{SyncError, ZipValidator};

fn open_archive(zip_path: &Path) -> Result<zip::ZipArchive<std::fs::File>, String> {
    let file = std::fs::File::open(zip_path).map_err(|e| not_a_zip(zip_path, &e.to_string()))?;
    zip::ZipArchive::new(file).map_err(|e| not_a_zip(zip_path, &e.to_string()))
}

fn not_a_zip(zip_path: &Path, message: &str) -> String {
    format!(
        "{} is not a valid zip: {message}",
        zip_path
            .file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default()
    )
}

fn entry_names(archive: &mut zip::ZipArchive<std::fs::File>) -> Vec<String> {
    (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
        .collect()
}

fn read_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<Vec<u8>, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("entry {name} missing"))?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// `validateArchiveZip`: required entries must exist as file entries.
pub fn validate_archive_zip(
    zip_path: &Path,
    required_files: &[String],
) -> Result<Vec<String>, String> {
    let mut archive = open_archive(zip_path)?;
    let names: BTreeSet<String> = entry_names(&mut archive)
        .into_iter()
        .filter(|name| !name.ends_with('/'))
        .collect();
    Ok(required_files
        .iter()
        .filter(|f| !names.contains(f.as_str()))
        .cloned()
        .collect())
}

const STORYJSON_REVIEW_TABLE: &str = "zh_CN/gamedata/excel/story_review_table.json";
const STORYJSON_SUPPLEMENT: &str = "zh_CN/story_supplement.json";

/// `validateStoryjsonZip`: the two base files plus every story chapter the
/// review table (and the optional supplement catalog) references must exist.
pub fn validate_storyjson_zip(zip_path: &Path) -> Result<Vec<String>, String> {
    let mut archive = open_archive(zip_path)?;
    let mut missing: Vec<String> = Vec::new();
    for required in [
        "zh_CN/gamedata/excel/story_review_table.json",
        "zh_CN/storyinfo.json",
    ] {
        if !archive.file_names().any(|name| name == required) {
            missing.push(required.to_string());
        }
    }
    if missing.contains(&STORYJSON_REVIEW_TABLE.to_string()) {
        return Ok(missing);
    }

    let table: Value = match read_entry(&mut archive, STORYJSON_REVIEW_TABLE)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(v) => v,
        None => {
            // TS appends the raw parse error text; the wording is a
            // dependency detail (D-003), the "unreadable" classification is
            // the contract.
            missing.push(format!("{STORYJSON_REVIEW_TABLE} is unreadable"));
            return Ok(missing);
        }
    };

    let names: BTreeSet<String> = archive.file_names().map(str::to_string).collect();
    let mut story_paths: BTreeSet<String> = BTreeSet::new();
    let story_path = |key: &str| format!("zh_CN/gamedata/story/{key}.json");
    if let Some(entries) = table.as_object() {
        for entry in entries.values() {
            let Some(unlocks) = entry.get("infoUnlockDatas").and_then(|v| v.as_array()) else {
                continue;
            };
            for data in unlocks {
                if let Some(key) = data.get("storyTxt").and_then(|v| v.as_str()) {
                    if !key.is_empty() {
                        story_paths.insert(story_path(key));
                    }
                }
            }
        }
    }

    if names.contains(STORYJSON_SUPPLEMENT) {
        let supplement: Value = match read_entry(&mut archive, STORYJSON_SUPPLEMENT)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(v) => v,
            None => {
                missing.push(format!("{STORYJSON_SUPPLEMENT} is unreadable"));
                return Ok(missing);
            }
        };
        let events = match supplement.get("events").and_then(|v| v.as_array()) {
            Some(events) => events,
            None => {
                missing.push(format!(
                    "{STORYJSON_SUPPLEMENT} is unreadable: events is not a list"
                ));
                return Ok(missing);
            }
        };
        for event in events {
            let Some(chapters) = event.get("chapters").and_then(|v| v.as_array()) else {
                continue;
            };
            for chapter in chapters {
                if let Some(key) = chapter.get("key").and_then(|v| v.as_str()) {
                    if !key.is_empty() {
                        story_paths.insert(story_path(key));
                    }
                }
            }
        }
    }

    missing.extend(
        story_paths
            .into_iter()
            .filter(|path| !names.contains(path))
            .collect::<Vec<_>>(),
    );
    Ok(missing)
}

/// Zip validation dispatched by the spec's validator kind.
pub fn zip_missing_entries(
    zip_path: &Path,
    validator: &ZipValidator,
) -> Result<Vec<String>, SyncError> {
    match validator {
        // TS `spec.validateZip?.(path) ?? []`: no validator means the zip is
        // never even opened — a garbage file counts as "ok".
        ZipValidator::None => Ok(Vec::new()),
        ZipValidator::StoryJson => validate_storyjson_zip(zip_path).map_err(SyncError::Message),
        ZipValidator::Archive(required) => {
            validate_archive_zip(zip_path, required).map_err(SyncError::Message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::write_zip_entries;

    fn temp_zip(name: &str, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("prts-syncval-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let zip_path = dir.join("pack.zip");
        write_zip_entries(&zip_path, entries).unwrap();
        zip_path
    }

    #[test]
    fn archive_validation_lists_missing_required_files() {
        let zip = temp_zip(
            "archive",
            &[("zh_CN/gamedata/levels/enemydata/enemy_database.json", b"{}")],
        );
        let required = vec![
            "zh_CN/gamedata/levels/enemydata/enemy_database.json".to_string(),
            "zh_CN/gamedata/excel/character_table.json".to_string(),
        ];
        let missing = validate_archive_zip(&zip, &required).unwrap();
        assert_eq!(missing, vec!["zh_CN/gamedata/excel/character_table.json"]);
        // Directory entries do not satisfy file requirements.
        assert!(validate_archive_zip(&zip, &[]).unwrap().is_empty());
        assert!(validate_archive_zip(&zip, &["zh_CN/".to_string()])
            .unwrap()
            .contains(&"zh_CN/".to_string()));
    }

    #[test]
    fn archive_validation_reports_invalid_zip() {
        let dir = std::env::temp_dir().join(format!("prts-syncval-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("bad.zip");
        std::fs::write(&bad, "not a zip").unwrap();
        let err = validate_archive_zip(&bad, &[]).unwrap_err();
        assert!(err.starts_with("bad.zip is not a valid zip: "), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn story_validation_walks_review_table_chapters() {
        let review = serde_json::json!({
            "act_1": {"infoUnlockDatas": [{"storyTxt": "act_1_1"}, {"storyTxt": ""}]},
            "act_2": {"infoUnlockDatas": [{"storyTxt": "act_2_1"}]},
        });
        let review_text = serde_json::to_string(&review).unwrap();
        let zip = temp_zip(
            "story-ok",
            &[
                (
                    "zh_CN/gamedata/excel/story_review_table.json",
                    review_text.as_bytes(),
                ),
                ("zh_CN/storyinfo.json", b"{}"),
                ("zh_CN/gamedata/story/act_1_1.json", b"{}"),
                ("zh_CN/gamedata/story/act_2_1.json", b"{}"),
            ],
        );
        assert!(validate_storyjson_zip(&zip).unwrap().is_empty());

        let zip = temp_zip(
            "story-missing-chapter",
            &[
                (
                    "zh_CN/gamedata/excel/story_review_table.json",
                    review_text.as_bytes(),
                ),
                ("zh_CN/storyinfo.json", b"{}"),
                ("zh_CN/gamedata/story/act_1_1.json", b"{}"),
            ],
        );
        let missing = validate_storyjson_zip(&zip).unwrap();
        assert_eq!(missing, vec!["zh_CN/gamedata/story/act_2_1.json"]);
    }

    #[test]
    fn story_validation_checks_supplement_catalog() {
        let review = serde_json::json!({"act": {"infoUnlockDatas": [{"storyTxt": "a"}]}});
        let supplement = serde_json::json!({
            "events": [{"chapters": [{"key": "rogue_1"}, {"key": "rogue_2"}]}],
        });
        let review_text = serde_json::to_string(&review).unwrap();
        let supplement_text = serde_json::to_string(&supplement).unwrap();
        let zip = temp_zip(
            "story-supp",
            &[
                (
                    "zh_CN/gamedata/excel/story_review_table.json",
                    review_text.as_bytes(),
                ),
                ("zh_CN/storyinfo.json", b"{}"),
                ("zh_CN/gamedata/story/a.json", b"{}"),
                ("zh_CN/gamedata/story/rogue_1.json", b"{}"),
                ("zh_CN/story_supplement.json", supplement_text.as_bytes()),
            ],
        );
        let missing = validate_storyjson_zip(&zip).unwrap();
        assert_eq!(missing, vec!["zh_CN/gamedata/story/rogue_2.json"]);

        // Old packs without the supplement are unaffected.
        let zip = temp_zip(
            "story-nosupp",
            &[
                (
                    "zh_CN/gamedata/excel/story_review_table.json",
                    review_text.as_bytes(),
                ),
                ("zh_CN/storyinfo.json", b"{}"),
                ("zh_CN/gamedata/story/a.json", b"{}"),
            ],
        );
        assert!(validate_storyjson_zip(&zip).unwrap().is_empty());
    }

    #[test]
    fn story_validation_flags_unreadable_tables() {
        let zip = temp_zip(
            "story-badtable",
            &[
                ("zh_CN/gamedata/excel/story_review_table.json", b"{broken"),
                ("zh_CN/storyinfo.json", b"{}"),
            ],
        );
        let missing = validate_storyjson_zip(&zip).unwrap();
        assert!(missing
            .iter()
            .any(|m| m.starts_with("zh_CN/gamedata/excel/story_review_table.json is unreadable")));

        let zip = temp_zip(
            "story-badsupp",
            &[
                ("zh_CN/gamedata/excel/story_review_table.json", br#"{}"#),
                ("zh_CN/storyinfo.json", b"{}"),
                ("zh_CN/story_supplement.json", br#"{"events": 5}"#),
            ],
        );
        let missing = validate_storyjson_zip(&zip).unwrap();
        assert!(missing.iter().any(|m| m.ends_with("events is not a list")));
    }
}
