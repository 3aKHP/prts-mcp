//! Read-only, explicit integrity checks for administrative commands.
use super::{
    database::DatabaseCandidate, identity::path_token, DirectoryStore, JsonStore, ZipStore,
};
use std::{fs, path::Path};

pub(crate) fn database(
    candidate: &DatabaseCandidate,
) -> Result<std::sync::Arc<super::sqlite::GameDb>, String> {
    let before = path_token(&candidate.path).ok_or("数据库不可读")?;
    let sidecars: Vec<_> = ["-wal", "-journal"]
        .iter()
        .map(|suffix| {
            let mut p = candidate.path.as_os_str().to_owned();
            p.push(suffix);
            std::path::PathBuf::from(p)
        })
        .collect();
    let sidecar_tokens: Vec<_> = sidecars.iter().map(|p| path_token(p)).collect();
    // Open first to hold an existing reader lease while hashing and verifying.
    let db = super::sqlite::GameDb::for_inspection(&candidate.path)?;
    if let Some(pointer) = &candidate.pointer {
        if super::digest::hash_file(&candidate.path)? != pointer.sha256 {
            return Err("数据库 SHA-256 不匹配".into());
        }
        if db.metadata("source_version")?.as_deref() != Some(pointer.source_version.as_str())
            || db.metadata("publication_revision")?.as_deref()
                != Some(pointer.revision.to_string().as_str())
        {
            return Err("数据库元数据与激活指针不一致".into());
        }
    }
    db.verify()?;
    if path_token(&candidate.path).as_ref() != Some(&before)
        || sidecars.iter().map(|p| path_token(p)).collect::<Vec<_>>() != sidecar_tokens
    {
        return Err("校验期间数据库发生变化，请重试".into());
    }
    Ok(db)
}

pub(crate) fn json_tree(root: &Path, required: &[String]) -> Result<usize, String> {
    let store = DirectoryStore::new(root);
    for name in required {
        store
            .read_json(&name)
            .map_err(|_| format!("必需 JSON 缺失或无效: {name}"))?;
    }
    let mut pending = vec![root.to_owned()];
    let mut observations = Vec::new();
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                return Err("校验目录含符号链接，无法保证一致遍历".into());
            }
            if kind.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if entry.path().extension().is_none_or(|e| e != "json") {
                continue;
            }
            let path = entry.path();
            let before = path_token(&path).ok_or("JSON 文件不可读")?;
            let relative = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("JSON 路径不是 UTF-8")?;
            store
                .read_json(relative)
                .map_err(|_| format!("JSON 无效: {relative}"))?;
            observations.push((path, before));
        }
    }
    if observations
        .iter()
        .any(|(path, token)| path_token(path).as_ref() != Some(token))
    {
        return Err("校验期间 JSON 数据发生变化，请重试".into());
    }
    Ok(observations.len())
}

pub(crate) fn story(path: &Path) -> Result<usize, String> {
    let before = path_token(path).ok_or("剧情 ZIP 不可读")?;
    let missing = crate::sync::validation::validate_storyjson_zip(path)?;
    if !missing.is_empty() {
        return Err(format!("剧情缺失或无效条目: {}", missing.len()));
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let store = ZipStore::new(path);
    let mut count = 0;
    for name in archive.file_names() {
        let name = name.map_err(|e| e.to_string())?;
        if !name.ends_with(".json") {
            continue;
        }
        store
            .read_json(&name)
            .map_err(|_| format!("剧情 JSON 无效: {name}"))?;
        count += 1;
    }
    if path_token(path).as_ref() != Some(&before) {
        return Err("校验期间剧情 ZIP 发生变化，请重试".into());
    }
    Ok(count)
}

pub(crate) fn artwork(root: &Path, original: bool) -> Result<usize, String> {
    let generation =
        crate::sync::images_meta::active_generation(root).ok_or("本地立绘无有效激活代")?;
    let base = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let generation = fs::canonicalize(generation).map_err(|e| e.to_string())?;
    if !generation.starts_with(base) {
        return Err("立绘代次超出数据目录".into());
    }
    let store = DirectoryStore::new(&generation);
    let index_path = generation.join("index.json");
    let before = path_token(&index_path).ok_or("立绘索引不可读")?;
    let value = store.read_json("index.json").map_err(|e| e.to_string())?;
    let index = crate::sync::images_meta::parse_index(&value).ok_or("立绘索引无效")?;
    let mut count = 0;
    for artwork in index.artworks.values() {
        for (name, variant) in &artwork.variants {
            if name == "original" && !original {
                continue;
            }
            let path = store.resolve(&variant.file).map_err(|e| e.to_string())?;
            let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
            if !path.starts_with(&generation) {
                return Err("立绘文件超出激活代目录".into());
            }
            let token = path_token(&path).ok_or("立绘文件缺失")?;
            let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if size as f64 != variant.bytes || super::digest::hash_file(&path)? != variant.sha256 {
                return Err("立绘大小或 SHA-256 不匹配".into());
            }
            if path_token(&path).as_ref() != Some(&token) {
                return Err("校验期间立绘发生变化，请重试".into());
            }
            count += 1;
        }
    }
    if path_token(&index_path).as_ref() != Some(&before) {
        return Err("校验期间立绘索引发生变化，请重试".into());
    }
    Ok(count)
}
