//! Legacy JSON/ZIP resolution, isolated from SQLite initialization.
use super::DataView;
use crate::config::{BundleRoots, RuntimeConfig};
use crate::storage::generation::{
    activated_pair, activated_root, excel_path_of, gamedata_pair_path_for_read,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn story_archive(path: &Path) -> Option<PathBuf> {
    (path.is_file() && !crate::storage::sqlite::is_database(path)).then(|| path.to_owned())
}

/// TS `loadConfig`'s data-path half: pair pointer first, extract_meta
/// fallback, completeness gates. The bundled-data fallback joins in P7 with
/// the package layout.
pub(super) fn resolve_view(config: &RuntimeConfig) -> DataView {
    resolve_view_with_legacy_story(config, Path::new("/data/storyjson/zh_CN.zip"))
}

fn resolve_view_with_legacy_story(config: &RuntimeConfig, legacy_story: &Path) -> DataView {
    let pair = activated_pair(&config.gamedata_path, &config.levels_path);
    let excel_active = pair
        .clone()
        .map(|(excel, _)| excel)
        .unwrap_or_else(|| activated_root(&config.gamedata_path));
    let excel_root = excel_path_of(&excel_active);
    let excel_root = crate::config::files_complete(&excel_root).then_some(excel_root);

    let levels_active = pair
        .map(|(_, levels)| levels)
        .unwrap_or_else(|| activated_root(&config.levels_path));
    let levels_root = crate::config::levels_complete(&levels_active).then_some(levels_active);

    let story_zip = story_archive(&config.storyjson_zip).or_else(|| {
        if !config.data_source.is_default() {
            return None;
        }
        let archive = story_archive(legacy_story)?;
        // The legacy Docker cache may be outside the configured root. Its
        // own marker must be checked after resolving the file as well.
        crate::sync::source_guard::verify(
            legacy_story.parent().unwrap_or(Path::new(".")),
            &config.data_source,
        )
        .ok()?;
        Some(archive)
    });

    // Bundled read-only fallback (TS loadConfig's BUNDLED_*_PATH half):
    // only when the sync target is incomplete; resolution mirrors the sync
    // path (pair pointer first, extract_meta fallback, completeness gates).
    let bundles = config.bundle_root.as_deref().map(BundleRoots::of);
    let excel_root = excel_root.or_else(|| {
        let roots = bundles.as_ref()?;
        let pair = activated_pair(&roots.gamedata, &roots.levels);
        let bundled_root = pair
            .clone()
            .map(|(excel, _)| excel)
            .unwrap_or_else(|| activated_root(&roots.gamedata));
        let bundled_excel = excel_path_of(&bundled_root);
        crate::config::files_complete(&bundled_excel).then_some(bundled_excel)
    });
    let levels_root = levels_root.or_else(|| {
        let roots = bundles.as_ref()?;
        let pair = activated_pair(&roots.gamedata, &roots.levels);
        let bundled_root = pair
            .map(|(_, levels)| levels)
            .unwrap_or_else(|| activated_root(&roots.levels));
        crate::config::levels_complete(&bundled_root).then_some(bundled_root)
    });
    let story_zip = story_zip.or_else(|| {
        let roots = bundles.as_ref()?;
        story_archive(&roots.storyjson_zip)
    });

    DataView {
        excel_root,
        levels_root,
        story_zip,
        datasets: Arc::new(crate::domain::datasets::Datasets::new()),
        database: None,
    }
}

/// TS `activationPathToken`: [path, ino, size, mtime, ctime] of one pointer
/// file; a missing file is [path, null]. The signature covers the pair file
/// and both extract_meta files — exactly the files an activation rewrites.
fn path_token(path: &std::path::Path) -> String {
    let token = crate::storage::identity::path_token(path).unwrap_or_else(|| "null".into());
    format!("{path:?}|{token}")
}

pub(super) fn activation_signature(config: &RuntimeConfig) -> String {
    let pair = gamedata_pair_path_for_read(&config.gamedata_path, &config.levels_path);
    format!(
        "{};{};{}",
        path_token(&pair),
        path_token(&config.gamedata_path.join("archives/extract_meta.json")),
        path_token(&config.levels_path.join("archives/extract_meta.json")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::DataState;

    fn temp_root(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("prts-json-view-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &std::path::Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn config_for(root: &std::path::Path) -> RuntimeConfig {
        RuntimeConfig::from_lookup(|name| match name {
            "GAMEDATA_PATH" => Some(root.join("gamedata").to_string_lossy().into_owned()),
            "STORYJSON_PATH" => Some(root.join("nope.zip").to_string_lossy().into_owned()),
            _ => None,
        })
    }

    #[test]
    fn custom_source_skips_default_writable_story_cache_but_keeps_bundle_fallback() {
        let root = temp_root("custom-story-fallback");
        let legacy_story = root.join("default/storyjson/zh_CN.zip");
        let bundled_story = root.join("bundle/storyjson/zh_CN.zip");
        write(&legacy_story, "PK-default");
        write(&bundled_story, "PK-bundle");
        let mut config = config_for(&root);
        config.bundle_root = Some(root.join("bundle"));
        assert_eq!(
            resolve_view_with_legacy_story(&config, &legacy_story).story_zip,
            Some(legacy_story.clone())
        );
        config.data_source = crate::config::DataSource::parse(Some("team/assets")).unwrap();
        assert_eq!(
            resolve_view_with_legacy_story(&config, &legacy_story).story_zip,
            Some(bundled_story)
        );
        config.bundle_root = None;
        assert!(resolve_view_with_legacy_story(&config, &legacy_story)
            .story_zip
            .is_none());
        let foreign_legacy = root.join("foreign/storyjson/zh_CN.zip");
        crate::sync::source_guard::ensure(foreign_legacy.parent().unwrap(), &config.data_source)
            .unwrap();
        write(&foreign_legacy, "PK-foreign");
        config.data_source = Default::default();
        config.bundle_root = Some(root.join("bundle"));
        assert_eq!(
            resolve_view_with_legacy_story(&config, &foreign_legacy).story_zip,
            Some(root.join("bundle/storyjson/zh_CN.zip"))
        );
        config.bundle_root = None;
        assert!(resolve_view_with_legacy_story(&config, &foreign_legacy)
            .story_zip
            .is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_tracks_activation_changes() {
        let root = temp_root("swap");
        let config = Arc::new(config_for(&root));
        let state = DataState::new(Arc::clone(&config));

        // Empty volume → no data, but the service still resolves.
        let view = state.snapshot();
        assert!(view.excel_root.is_none());
        assert!(view.levels_root.is_none());

        // Publish a generation via the pair pointer (TS-written format).
        let excel_gen = root.join("gamedata/.releases/g1");
        let levels_gen = root.join("gamedata-levels/.releases/g1");
        for (root_dir, file) in [
            (&excel_gen, "zh_CN/gamedata/excel/stage_table.json"),
            (
                &levels_gen,
                "zh_CN/gamedata/levels/enemydata/enemy_database.json",
            ),
        ] {
            write(&root_dir.join(file), "{}");
        }
        for file in [
            "character_table.json",
            "handbook_info_table.json",
            "charword_table.json",
            "story_review_table.json",
        ] {
            write(&excel_gen.join("zh_CN/gamedata/excel").join(file), "{}");
        }
        write(
            &root.join(".gamedata_pair.json"),
            r#"{"commit_sha":"sha1","excel_data_root":".releases/g1","levels_data_root":".releases/g1"}"#,
        );

        // Same signature → cached view; the cached snapshot stays None until
        // the pointer files change on disk (they just did).
        let view = state.snapshot();
        let expected_excel = excel_gen.join("zh_CN/gamedata/excel");
        assert_eq!(
            view.excel_root.as_deref(),
            Some(expected_excel.canonicalize().unwrap().as_path())
        );
        assert_eq!(
            view.levels_root.as_deref(),
            Some(levels_gen.canonicalize().unwrap().as_path())
        );

        // A second snapshot with unchanged pointers reuses the same Arc.
        assert!(Arc::ptr_eq(&state.snapshot(), &state.snapshot()));

        // Removing the pair pointer degrades to the extract_meta fallback.
        std::fs::remove_file(root.join(".gamedata_pair.json")).unwrap();
        write(
            &root.join("gamedata/archives/extract_meta.json"),
            r#"{"commit_sha":"sha1","data_root":".releases/g1"}"#,
        );
        let view = state.snapshot();
        assert!(view.excel_root.is_some());
        assert!(view.levels_root.is_none()); // levels still resolves via its own root (no meta) → legacy root, incomplete
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn story_zip_resolution_prefers_configured_path() {
        let root = temp_root("story");
        let zip = root.join("storyjson/zh_CN.zip");
        write(&zip, "PK");
        let config = RuntimeConfig::from_lookup(|name| match name {
            "GAMEDATA_PATH" => Some(root.join("gamedata").to_string_lossy().into_owned()),
            "STORYJSON_PATH" => Some(zip.to_string_lossy().into_owned()),
            _ => None,
        });
        let state = DataState::new(Arc::new(config));
        assert_eq!(state.snapshot().story_zip.as_deref(), Some(zip.as_path()));
        let _ = std::fs::remove_dir_all(&root);
    }
}
