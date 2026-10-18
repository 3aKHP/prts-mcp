//! Lossless input capture; query entities are additional copies, never projections.
use super::{Options, Result};
use flate2::{write::ZlibEncoder, Compression};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

fn normalize(path: &str) -> Result<String> {
    if path.starts_with('/')
        || path.contains('\\')
        || path
            .split('/')
            .any(|s| s == ".." || s.is_empty() || s == ".")
    {
        return Err(format!("Unsafe source path: {path}").into());
    }
    Ok(path.to_string())
}

fn source(db: &Connection, namespace: &str, path: &str, raw: &[u8]) -> Result<()> {
    let path = normalize(path)?;
    let sha = format!("{:x}", Sha256::digest(raw));
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM source_blobs WHERE sha256=?)",
        [&sha],
        |r| r.get(0),
    )?;
    if !exists {
        let mut encoded = ZlibEncoder::new(Vec::new(), Compression::new(6));
        encoded.write_all(raw)?;
        db.execute(
            "INSERT INTO source_blobs VALUES(?,?,?)",
            params![sha, raw.len() as i64, encoded.finish()?],
        )?;
    }
    if let Some(previous) = db
        .query_row(
            "SELECT sha256 FROM sources WHERE namespace=? AND path=?",
            params![namespace, path],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        if previous != sha {
            return Err(format!("Conflicting source: {namespace}/{path}").into());
        }
        return Ok(());
    }
    db.execute(
        "INSERT INTO sources VALUES(?,?,?)",
        params![namespace, path, sha],
    )?;
    super::entities::capture(db, namespace, &path, raw)
}

use rusqlite::OptionalExtension;

fn candidate_file(db: &Connection, path: &str, raw: &[u8], story_excel: bool) -> Result<()> {
    source(db, "original", path, raw)?;
    if let Some(relative) = path.strip_prefix("zh_CN/gamedata/excel/") {
        source(db, "excel", relative, raw)?;
        if story_excel {
            source(db, "story", path, raw)?;
        }
    } else if let Some(relative) = path.strip_prefix("zh_CN/gamedata/levels/") {
        source(db, "levels", relative, raw)?;
    } else if path.starts_with("zh_CN/") {
        // Unknown future root/story data remains available without a new compiler.
        source(db, "story", path, raw)?;
    }
    Ok(())
}

fn directory(db: &Connection, root: &Path, current: &Path, story_excel: bool) -> Result<()> {
    let mut entries: Vec<_> = fs::read_dir(current)?.collect::<std::result::Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            directory(db, root, &path, story_excel)?;
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .ok_or("Non-UTF8 source path")?
                .replace('\\', "/");
            candidate_file(db, &relative, &fs::read(path)?, story_excel)?;
        } else {
            return Err(format!(
                "Symlinks and special source files are unsupported: {}",
                path.display()
            )
            .into());
        }
    }
    Ok(())
}

fn archive(db: &Connection, namespace: &str, path: &Path, prefix: &str) -> Result<()> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path)?)?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        if entry.is_symlink() {
            return Err("Source ZIP contains symlink".into());
        }
        let original = entry.name().to_string();
        let relative = original
            .strip_prefix(prefix)
            .ok_or_else(|| format!("Unexpected archive path: {original}"))?;
        let mut raw = Vec::new();
        entry.read_to_end(&mut raw)?;
        source(db, namespace, relative, &raw)?;
    }
    Ok(())
}

fn exists(db: &Connection, namespace: &str, path: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sources WHERE namespace=? AND path=?)",
        params![namespace, path],
        |r| r.get(0),
    )?)
}

fn flag(db: &Connection, namespace: &str, paths: &[&str]) -> Result<bool> {
    for path in paths {
        if !exists(db, namespace, path)? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn capture(db: &mut Connection, options: &Options) -> Result<()> {
    let tx = db.transaction()?;
    if let Some(root) = &options.input {
        let story = root.join("storyjson/zh_CN.zip");
        if root.join("zh_CN").is_dir() {
            directory(
                &tx,
                root,
                &root.join("zh_CN"),
                !story.is_file() && options.story_zip.is_none(),
            )?;
        }
        if story.is_file() {
            archive(&tx, "story", &story, "")?;
        }
    }
    for (namespace, path, prefix) in [
        ("excel", &options.excel_zip, "zh_CN/gamedata/excel/"),
        ("levels", &options.levels_zip, "zh_CN/gamedata/levels/"),
        ("story", &options.story_zip, ""),
    ] {
        if let Some(path) = path {
            archive(&tx, namespace, path, prefix)?;
        }
    }
    let excel = flag(
        &tx,
        "excel",
        &[
            "character_table.json",
            "handbook_info_table.json",
            "charword_table.json",
            "story_review_table.json",
        ],
    )?;
    let levels = exists(&tx, "levels", "enemydata/enemy_database.json")?;
    let story = flag(
        &tx,
        "story",
        &[
            "zh_CN/gamedata/excel/story_review_table.json",
            "zh_CN/storyinfo.json",
        ],
    )?;
    if !options.allow_incomplete {
        for path in [
            "character_table.json",
            "handbook_info_table.json",
            "charword_table.json",
            "story_review_table.json",
            "enemy_handbook_table.json",
            "stage_table.json",
            "zone_table.json",
            "item_table.json",
            "building_data.json",
            "skin_table.json",
            "skill_table.json",
        ] {
            if !exists(&tx, "excel", path)? {
                return Err(format!("Missing required Excel source: {path}").into());
            }
        }
        if !levels || !story {
            return Err("Missing required levels/story source".into());
        }
    }
    for (key, value) in [
        ("contract", "prts-mcp-sqlite/v1".to_string()),
        ("index_version", "1".into()),
        ("compiler_version", prts_mcp_rust::SERVER_VERSION.into()),
        ("source_version", options.version.clone()),
        ("publication_revision", options.revision.to_string()),
        ("language", "zh_CN".into()),
        ("sources_complete", "1".into()),
        ("derived_complete", "0".into()),
        ("excel_available", u8::from(excel).to_string()),
        ("levels_available", u8::from(levels).to_string()),
        ("story_available", u8::from(story).to_string()),
    ] {
        tx.execute("INSERT INTO meta VALUES(?,?)", params![key, value])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn verify_sources(db: &Connection) -> Result<(u64, u64)> {
    let mut count = 0;
    let mut total = 0;
    let mut query = db.prepare("SELECT sha256,raw_len,body FROM source_blobs ORDER BY sha256")?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let sha: String = row.get(0)?;
        let length = u64::try_from(row.get::<_, i64>(1)?)?;
        let encoded: Vec<u8> = row.get(2)?;
        let mut decoded = Vec::new();
        flate2::read::ZlibDecoder::new(encoded.as_slice()).read_to_end(&mut decoded)?;
        if decoded.len() as u64 != length || format!("{:x}", Sha256::digest(&decoded)) != sha {
            return Err("Source roundtrip mismatch".into());
        }
        count += 1;
        total += length;
    }
    Ok((count, total))
}
