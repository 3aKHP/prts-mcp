//! Bounded block hints and deferred BLOB reads for story searches.
use super::sqlite_search::{context, decode};
use crate::{storage::sqlite::GameDb, text::regex_compat::JsRegex};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[allow(clippy::too_many_arguments)]
pub(super) fn search(
    db: &GameDb,
    connection: &Connection,
    regex: &JsRegex,
    line_type: Option<&str>,
    radius: i64,
    maximum: i64,
    event: Option<&str>,
    results: &mut Vec<Value>,
) -> Result<(), String> {
    if !regex.has_block_filter() {
        return stream_blocks(
            connection, regex, line_type, radius, maximum, event, results,
        );
    }
    use crate::storage::block_filters::StoryBlock;
    let mut payloads = connection
        .prepare_cached("SELECT payload FROM story_blocks WHERE chapter=?1 AND block=?2")
        .map_err(error)?;
    let mut visit = |block: &StoryBlock| -> Result<bool, String> {
        crate::text::cancellation::check()?;
        let key = (block.chapter, block.block);
        let cached = if regex.has_block_filter() {
            db.story_filters.get(key)?
        } else {
            None
        };
        if cached
            .as_ref()
            .is_some_and(|filter| !regex.may_match_filter(filter))
        {
            return Ok(false);
        }
        // Selecting payload in the outer query would materialize the BLOB in
        // SQLite before a cached hint could reject it. Fetch only candidates.
        let payload: Vec<u8> = payloads
            .query_row(params![block.chapter, block.block], |r| r.get(0))
            .map_err(error)?;
        if cached.is_none() && regex.has_block_filter() {
            db.story_filters.remember(key, &payload)?;
        }
        if !regex.may_match_bytes(&payload) {
            return Ok(false);
        }
        for (offset, line) in decode(&payload)?.iter().enumerate() {
            if line_type.is_some_and(|kind| kind != line.kind) || !regex.is_match(line.text)? {
                continue;
            }
            let number = block.first_line + offset as i64;
            results.push(json!({"event_id":block.event,"story_key":block.story_key,"story_code":block.code,"line_number":number+1,"context":context(connection,block.chapter,number,radius)?}));
            if results.len() as i64 >= maximum {
                return Ok(true);
            }
        }
        Ok(false)
    };
    if let Some(catalog) = db.story_filters.catalog.get() {
        for block in catalog {
            if event.is_none_or(|event| event == block.event) && visit(block)? {
                break;
            }
        }
        return Ok(());
    }
    let mut statement=connection.prepare_cached("SELECT c.ordinal,c.event,c.story_key,c.code,b.first_line,b.block FROM story_chapters c JOIN story_blocks b ON b.chapter=c.ordinal WHERE (?1 IS NULL OR c.event=?1) ORDER BY c.ordinal,b.block").map_err(error)?;
    let mut rows = statement.query([event]).map_err(error)?;
    // Only a complete, unscoped traversal can populate the ordered catalog.
    // Bound both row count and text bytes; larger custom corpora fall back.
    let mut catalog = event.is_none().then(Vec::new);
    let mut text_bytes = 0usize;
    while let Some(row) = rows.next().map_err(error)? {
        let block = StoryBlock {
            chapter: row.get(0).map_err(error)?,
            event: row.get(1).map_err(error)?,
            story_key: row.get(2).map_err(error)?,
            code: row.get(3).map_err(error)?,
            first_line: row.get(4).map_err(error)?,
            block: row.get(5).map_err(error)?,
        };
        if visit(&block)? {
            return Ok(());
        }
        if let Some(entries) = catalog.as_mut() {
            text_bytes = text_bytes
                .saturating_add(block.event.len())
                .saturating_add(block.story_key.len())
                .saturating_add(block.code.len());
            if entries.len() < 4096 && text_bytes <= 512 * 1024 {
                entries.push(block);
            } else {
                catalog = None;
            }
        }
    }
    if let Some(catalog) = catalog {
        let _ = db.story_filters.catalog.set(catalog);
    }
    Ok(())
}

// Patterns without a mandatory literal cannot use block hints. Keep the
// original single-statement streaming path and its borrowed BLOB payloads.
#[allow(clippy::too_many_arguments)]
fn stream_blocks(
    connection: &Connection,
    regex: &JsRegex,
    line_type: Option<&str>,
    radius: i64,
    maximum: i64,
    event: Option<&str>,
    results: &mut Vec<Value>,
) -> Result<(), String> {
    let mut statement=connection.prepare_cached("SELECT c.ordinal,c.event,c.story_key,c.code,b.first_line,b.payload FROM story_chapters c JOIN story_blocks b ON b.chapter=c.ordinal WHERE (?1 IS NULL OR c.event=?1) ORDER BY c.ordinal,b.block").map_err(error)?;
    let mut rows = statement.query([event]).map_err(error)?;
    'blocks: while let Some(row) = rows.next().map_err(error)? {
        crate::text::cancellation::check()?;
        let chapter: i64 = row.get(0).map_err(error)?;
        let first: i64 = row.get(4).map_err(error)?;
        let payload = row.get_ref(5).map_err(error)?.as_blob().map_err(error)?;
        if !regex.may_match_bytes(payload) {
            continue;
        }
        for (offset, line) in decode(payload)?.iter().enumerate() {
            if line_type.is_some_and(|kind| kind != line.kind) || !regex.is_match(line.text)? {
                continue;
            }
            let number = first + offset as i64;
            results.push(json!({"event_id":row.get::<_,String>(1).map_err(error)?,"story_key":row.get::<_,String>(2).map_err(error)?,"story_code":row.get::<_,String>(3).map_err(error)?,"line_number":number+1,"context":context(connection,chapter,number,radius)?}));
            if results.len() as i64 >= maximum {
                break 'blocks;
            }
        }
    }
    Ok(())
}
