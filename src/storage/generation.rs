//! Generation-pointer readers shared by the config-side data view — ports of
//! the read half of TS `config.ts` (`activatedRoot`, `activatedPair`,
//! `gamedataPairPath`). The write half (staging/activation/pair publication)
//! lives in `sync/`; both sides must agree on the on-disk format documented in
//! docs/05-sync-and-assets.md.

use std::path::{Path, PathBuf};

/// `excelPath()`: `<root>/zh_CN/gamedata/excel`.
pub fn excel_path_of(root: &Path) -> PathBuf {
    root.join("zh_CN").join("gamedata").join("excel")
}

/// TS `gamedataPairPath` (config-side variant): when the two roots do not
/// share a parent, the pair path becomes `.gamedata_pair.invalid` — reads then
/// fail and the caller treats the pair as absent. The sync-side variant
/// errors instead (sync::pair).
pub fn gamedata_pair_path_for_read(gamedata_root: &Path, levels_root: &Path) -> PathBuf {
    let gamedata_parent = parent_of(gamedata_root);
    let levels_parent = parent_of(levels_root);
    if gamedata_parent != levels_parent {
        return gamedata_parent.join(".gamedata_pair.invalid");
    }
    gamedata_parent.join(".gamedata_pair.json")
}

fn parent_of(root: &Path) -> PathBuf {
    let resolved = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
    resolved.parent().map(Path::to_path_buf).unwrap_or(resolved)
}

/// TS `activatedRoot`: resolve `archives/extract_meta.json → data_root` under
/// `root`, with realpath containment. Any failure falls back to `root`.
pub fn activated_root(root: &Path) -> PathBuf {
    let meta_path = root.join("archives").join("extract_meta.json");
    let Ok(text) = std::fs::read_to_string(&meta_path) else {
        return root.to_path_buf();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return root.to_path_buf();
    };
    let Some(data_root) = value.get("data_root").and_then(|v| v.as_str()) else {
        return root.to_path_buf();
    };
    if data_root.is_empty() {
        return root.to_path_buf();
    }
    resolve_inside(root, data_root).unwrap_or_else(|| root.to_path_buf())
}

/// TS `activatedPair`: the authoritative same-generation pair pointer.
/// `None` when the file is absent, malformed, escapes either root, or the
/// resolved roots are not directories.
pub fn activated_pair(gamedata_root: &Path, levels_root: &Path) -> Option<(PathBuf, PathBuf)> {
    let path = gamedata_pair_path_for_read(gamedata_root, levels_root);
    let text = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let commit_sha = value.get("commit_sha")?.as_str()?;
    if commit_sha.is_empty() {
        return None;
    }
    let excel_data_root = value.get("excel_data_root")?.as_str()?;
    if excel_data_root.is_empty() {
        return None;
    }
    let levels_data_root = value.get("levels_data_root")?.as_str()?;
    if levels_data_root.is_empty() {
        return None;
    }
    let excel = resolve_inside(gamedata_root, excel_data_root)?;
    let levels = resolve_inside(levels_root, levels_data_root)?;
    if !excel.is_dir() || !levels.is_dir() {
        return None;
    }
    Some((excel, levels))
}

/// realpath(resolve(base, rel)) + containment: `rel` must stay inside the
/// realpath of `base` and resolve to an existing path. Mirrors the
/// `realpathSync` + `relative` checks in TS config/activation readers.
fn resolve_inside(base: &Path, rel: &str) -> Option<PathBuf> {
    let base_real = std::fs::canonicalize(base).ok()?;
    let target_real = std::fs::canonicalize(base_real.join(rel)).ok()?;
    if !target_real.starts_with(&base_real) {
        return None;
    }
    Some(target_real)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn activated_root_follows_extract_meta_with_containment() {
        let dir = std::env::temp_dir().join(format!("prts-gen-ar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("archives")).unwrap();
        std::fs::create_dir_all(dir.join(".releases/gen-1/zh_CN/gamedata/excel")).unwrap();

        // No meta → root itself.
        assert_eq!(activated_root(&dir), dir);

        write(
            &dir.join("archives/extract_meta.json"),
            r#"{"commit_sha":"abc","data_root":".releases/gen-1"}"#,
        );
        assert_eq!(
            activated_root(&dir),
            std::fs::canonicalize(dir.join(".releases/gen-1")).unwrap()
        );

        // Escape → root itself.
        write(
            &dir.join("archives/extract_meta.json"),
            r#"{"commit_sha":"abc","data_root":"../outside"}"#,
        );
        assert_eq!(activated_root(&dir), dir);

        // Missing target → root itself.
        write(
            &dir.join("archives/extract_meta.json"),
            r#"{"commit_sha":"abc","data_root":".releases/nope"}"#,
        );
        assert_eq!(activated_root(&dir), dir);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activated_pair_resolves_and_validates() {
        let dir = std::env::temp_dir().join(format!("prts-gen-pair-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let gamedata = dir.join("gamedata");
        let levels = dir.join("gamedata-levels");
        std::fs::create_dir_all(gamedata.join(".releases/g1/zh_CN/gamedata/excel")).unwrap();
        std::fs::create_dir_all(levels.join(".releases/g1/zh_CN/gamedata/levels")).unwrap();

        assert_eq!(activated_pair(&gamedata, &levels), None);

        write(
            &dir.join(".gamedata_pair.json"),
            r#"{"commit_sha":"sha1","excel_data_root":".releases/g1","levels_data_root":".releases/g1"}"#,
        );
        let pair = activated_pair(&gamedata, &levels).expect("pair resolves");
        assert_eq!(
            pair.0,
            gamedata.join(".releases/g1").canonicalize().unwrap()
        );
        assert_eq!(pair.1, levels.join(".releases/g1").canonicalize().unwrap());

        // Mixed/invalid fields are rejected.
        write(&dir.join(".gamedata_pair.json"), r#"{"commit_sha":""}"#);
        assert_eq!(activated_pair(&gamedata, &levels), None);
        write(&dir.join(".gamedata_pair.json"), "not json");
        assert_eq!(activated_pair(&gamedata, &levels), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pair_path_invalid_when_parents_differ() {
        let a = gamedata_pair_path_for_read(Path::new("/x/gamedata"), Path::new("/y/levels"));
        assert!(a.to_string_lossy().ends_with(".gamedata_pair.invalid"));
        let b =
            gamedata_pair_path_for_read(Path::new("/x/gamedata"), Path::new("/x/gamedata-levels"));
        assert!(b.to_string_lossy().ends_with(".gamedata_pair.json"));
    }
}
