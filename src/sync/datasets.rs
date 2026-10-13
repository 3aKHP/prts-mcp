//! Dataset declarations sourced from the P0 extraction
//! (`contracts/data-declarations.json`) — never a hand-copied required-file
//! list. The declarations file is the frozen TS source extraction recorded in
//! the data manifest; required files, asset names and manifest verification
//! flags are read from it at compile time.

use std::sync::OnceLock;

use super::types::{ReleaseArchiveSpec, ReleaseSpec, ZipValidator};

const DECLARATIONS: &str = include_str!("../../contracts/data-declarations.json");

#[derive(Debug, Clone)]
pub struct DatasetSpec {
    pub dataset_id: String,
    pub owner: String,
    pub repo: String,
    pub asset_name: String,
    pub required_files: Vec<String>,
    pub verify_manifest: bool,
}

struct Declarations {
    gamedata_excel: DatasetSpec,
    gamedata_levels: DatasetSpec,
    story_zh_cn: DatasetSpec,
}

fn declarations() -> &'static Declarations {
    static CACHE: OnceLock<Declarations> = OnceLock::new();
    CACHE.get_or_init(|| {
        let value: serde_json::Value =
            serde_json::from_str(DECLARATIONS).expect("data-declarations.json parses");
        let spec = |name: &str| -> DatasetSpec {
            let entry = value
                .get("datasets")
                .and_then(|d| d.as_array())
                .expect("datasets array")
                .iter()
                .find(|d| d.get("name").and_then(|n| n.as_str()) == Some(name))
                .unwrap_or_else(|| panic!("dataset {name} present in declarations"));
            DatasetSpec {
                dataset_id: entry
                    .get("datasetId")
                    .and_then(|v| v.as_str())
                    .expect("datasetId")
                    .to_string(),
                owner: entry
                    .get("owner")
                    .and_then(|v| v.as_str())
                    .expect("owner")
                    .to_string(),
                repo: entry
                    .get("repo")
                    .and_then(|v| v.as_str())
                    .expect("repo")
                    .to_string(),
                asset_name: entry
                    .get("assetName")
                    .and_then(|v| v.as_str())
                    .expect("assetName")
                    .to_string(),
                required_files: entry
                    .get("requiredFiles")
                    .and_then(|v| v.as_array())
                    .expect("requiredFiles")
                    .iter()
                    .filter_map(|f| f.as_str())
                    .map(str::to_string)
                    .collect(),
                verify_manifest: entry
                    .get("verifyManifest")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            }
        };
        Declarations {
            gamedata_excel: spec("GAMEDATA_EXCEL"),
            gamedata_levels: spec("GAMEDATA_LEVELS"),
            story_zh_cn: spec("STORY_ZH_CN"),
        }
    })
}

pub fn gamedata_excel() -> DatasetSpec {
    declarations().gamedata_excel.clone()
}

pub fn gamedata_levels() -> DatasetSpec {
    declarations().gamedata_levels.clone()
}

pub fn story_zh_cn() -> DatasetSpec {
    declarations().story_zh_cn.clone()
}

/// `archiveSpecForDataset(GAMEDATA_EXCEL, gamedata/archives/zh_CN-excel.zip, gamedata)`.
pub fn excel_archive_spec(gamedata_root: &std::path::Path) -> ReleaseArchiveSpec {
    let dataset = gamedata_excel();
    ReleaseArchiveSpec {
        owner: dataset.owner,
        repo: dataset.repo,
        asset_name: dataset.asset_name.clone(),
        local_zip: gamedata_root.join("archives").join(&dataset.asset_name),
        local_root: gamedata_root.to_path_buf(),
        required_files: dataset.required_files,
        verify_manifest: dataset.verify_manifest,
    }
}

/// `archiveSpecForDataset(GAMEDATA_LEVELS, levels/archives/zh_CN-levels.zip, levels)`.
pub fn levels_archive_spec(levels_root: &std::path::Path) -> ReleaseArchiveSpec {
    let dataset = gamedata_levels();
    ReleaseArchiveSpec {
        owner: dataset.owner,
        repo: dataset.repo,
        asset_name: dataset.asset_name.clone(),
        local_zip: levels_root.join("archives").join(&dataset.asset_name),
        local_root: levels_root.to_path_buf(),
        required_files: dataset.required_files,
        verify_manifest: dataset.verify_manifest,
    }
}

/// `releaseSpecForDataset(STORY_ZH_CN, storyjson_zip)` — the story pack swap
/// is a plain release download (atomic zip replacement, no extraction).
pub fn story_release_spec(storyjson_zip: &std::path::Path) -> ReleaseSpec {
    let dataset = story_zh_cn();
    ReleaseSpec {
        owner: dataset.owner,
        repo: dataset.repo,
        asset_name: dataset.asset_name,
        local_zip: storyjson_zip.to_path_buf(),
        verify_manifest: dataset.verify_manifest,
        validator: ZipValidator::StoryJson,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declarations_match_the_p0_extraction() {
        let excel = gamedata_excel();
        assert_eq!(excel.dataset_id, "gamedata.excel");
        assert_eq!(excel.asset_name, "zh_CN-excel.zip");
        assert_eq!(excel.required_files.len(), 11);
        assert!(excel
            .required_files
            .contains(&"zh_CN/gamedata/excel/stage_table.json".to_string()));
        assert!(excel.verify_manifest);

        let levels = gamedata_levels();
        assert_eq!(
            levels.required_files,
            vec!["zh_CN/gamedata/levels/enemydata/enemy_database.json".to_string()]
        );

        let story = story_zh_cn();
        assert_eq!(story.asset_name, "zh_CN.zip");
        assert_eq!(story.required_files.len(), 2);
        assert!(story
            .required_files
            .contains(&"zh_CN/storyinfo.json".to_string()));
    }
}
