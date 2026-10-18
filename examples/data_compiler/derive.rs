//! Build disposable query indexes using the exact Rust domain implementations.
use prts_mcp_rust::{
    app::DataView,
    domain,
    storage::{sqlite::GameDb, ZipStore},
};
use rusqlite::{params, Connection};
use std::sync::Arc;

pub fn derive(
    path: &std::path::Path,
    allow_incomplete: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = path.to_owned();
    let db = GameDb::open(&path)?;
    let view = DataView::from_database(Arc::clone(&db), path.join("excel"), path.join("levels"))?;
    let mut writer = Connection::open(&path)?;
    writer.execute_batch(
        "PRAGMA synchronous=FULL;
        UPDATE meta SET value='0' WHERE key='derived_complete';
        DELETE FROM meta WHERE key LIKE 'search_unavailable:%';
        DELETE FROM search_blocks; DELETE FROM story_events; DELETE FROM searches;
        DELETE FROM story_lines; DELETE FROM story_chapters; DELETE FROM story_speakers;
        DELETE FROM enemy_appearances; DELETE FROM story_blocks;",
    )?;
    let exporters = [
        (
            "operators",
            domain::search::sqlite_export
                as fn(&DataView) -> Result<Vec<(String, serde_json::Value)>, String>,
        ),
        ("enemies", domain::enemy::sqlite_export),
        ("stages", domain::stage::sqlite_export),
        ("items", domain::item::sqlite_export),
        ("skills", domain::skill::sqlite_export),
        ("building_skills", domain::building::sqlite_export),
    ];
    for (scope, export) in exporters {
        match export(&view) {
            Ok(records) => {
                let tx = writer.transaction()?;
                let mut block = Vec::new();
                let mut block_no = 0i64;
                let mut first = 0i64;
                for (ordinal, (text, payload)) in records.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO searches VALUES(?,?,?,?)",
                        params![scope, ordinal as i64, text, serde_json::to_string(payload)?],
                    )?;
                    block.extend_from_slice(text.as_bytes());
                    block.push(0);
                    if block.len() >= 128 * 1024 || ordinal + 1 == records.len() {
                        tx.execute(
                            "INSERT INTO search_blocks VALUES(?,?,?,?,?)",
                            params![scope, block_no, first, ordinal as i64, block],
                        )?;
                        block.clear();
                        block_no += 1;
                        first = ordinal as i64 + 1;
                    }
                }
                tx.commit()?;
                eprintln!("{scope}: {} records", records.len());
            }
            Err(error) => {
                if !allow_incomplete {
                    return Err(format!("Cannot derive {scope}: {error}").into());
                }
                writer.execute(
                    "INSERT OR REPLACE INTO meta VALUES(?, '1')",
                    [format!("search_unavailable:{scope}")],
                )?;
                eprintln!("{scope}: unavailable: {error}");
            }
        }
    }
    let appearances = match domain::stage_enemy::sqlite_export(&view) {
        Ok(rows) => rows,
        Err(error) if allow_incomplete => {
            writer.execute(
                "INSERT OR REPLACE INTO meta VALUES('appearances_unavailable','1')",
                [],
            )?;
            eprintln!("enemy appearances unavailable: {error}");
            Vec::new()
        }
        Err(error) => return Err(format!("Cannot derive enemy appearances: {error}").into()),
    };
    {
        let tx = writer.transaction()?;
        for (ordinal, (enemy, stage, count)) in appearances.iter().enumerate() {
            tx.execute(
                "INSERT INTO enemy_appearances VALUES(?,?,?,?)",
                params![enemy, ordinal as i64, stage, count],
            )?;
        }
        tx.commit()?;
    }
    if let Some(story) = &view.story_zip {
        let index = domain::story::search::story_search_index(story, &ZipStore::new(story))?;
        let tx = writer.transaction()?;
        let mut events: Vec<_> = index.event_ids.iter().collect();
        events.sort();
        for event in events {
            tx.execute("INSERT INTO story_events VALUES(?)", [event])?;
        }
        let mut id = 0i64;
        let mut speakers = std::collections::HashMap::<(String, String), i64>::new();
        for (ordinal, chapter) in index.chapters.iter().enumerate() {
            tx.execute(
                "INSERT INTO story_chapters VALUES(?,?,?,?,?,?)",
                params![
                    ordinal as i64,
                    chapter.event_id,
                    chapter.story_key,
                    chapter.story_code,
                    chapter.story_name,
                    chapter.lines.len() as i64
                ],
            )?;
            let mut block = Vec::new();
            let mut block_no = 0i64;
            let mut first = 0usize;
            for (line_no, line) in chapter.lines.iter().enumerate() {
                tx.execute(
                    "INSERT INTO story_lines VALUES(?,?,?,?,?,?,?,?)",
                    params![
                        id,
                        ordinal as i64,
                        line_no as i64,
                        line.line_type,
                        line.role,
                        line.role.unwrap_or("").to_lowercase(),
                        line.text,
                        line.text.to_lowercase()
                    ],
                )?;
                id += 1;
                if line.line_type == "dialog" {
                    if let Some(role) = line.role {
                        *speakers
                            .entry((chapter.event_id.clone(), role.into()))
                            .or_default() += 1;
                    }
                }
                let kind = match line.line_type {
                    "dialog" => 0,
                    "narration" => 1,
                    _ => 2,
                };
                block.push(kind);
                let role = line.role.map(str::as_bytes);
                block.extend_from_slice(&role.map(|r| r.len() as i32).unwrap_or(-1).to_le_bytes());
                block.extend_from_slice(&(line.text.len() as u32).to_le_bytes());
                if let Some(role) = role {
                    block.extend_from_slice(role);
                }
                block.extend_from_slice(line.text.as_bytes());
                if block.len() >= 128 * 1024 || line_no + 1 == chapter.lines.len() {
                    tx.execute(
                        "INSERT INTO story_blocks VALUES(?,?,?,?,?)",
                        params![
                            ordinal as i64,
                            block_no,
                            first as i64,
                            line_no as i64,
                            block
                        ],
                    )?;
                    block.clear();
                    block_no += 1;
                    first = line_no + 1;
                }
            }
        }
        let mut speakers: Vec<_> = speakers.into_iter().collect();
        speakers.sort_by(|a, b| a.0.cmp(&b.0));
        for ((event, role), count) in speakers {
            tx.execute(
                "INSERT INTO story_speakers VALUES(?,?,?)",
                params![event, role, count],
            )?;
        }
        tx.commit()?;
        eprintln!("story: {} chapters, {id} lines", index.chapters.len());
    }
    writer.execute("UPDATE meta SET value='1' WHERE key='derived_complete'", [])?;
    writer.execute_batch("ANALYZE; VACUUM;")?;
    db.verify()?;
    Ok(())
}
