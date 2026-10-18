//! Bounded-memory story queries over immutable, producer-compiled text.
use crate::storage::sqlite::GameDb;
use crate::text::regex_compat::JsRegex;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn event_exists(connection: &Connection, event: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM story_events WHERE id=?1)",
            [event],
            |r| r.get(0),
        )
        .map_err(error)
}

fn context(
    connection: &Connection,
    chapter: i64,
    line: i64,
    radius: i64,
) -> Result<Vec<Value>, String> {
    let mut statement=connection.prepare_cached("SELECT line,kind,role,text FROM story_lines WHERE chapter=?1 AND line BETWEEN ?2 AND ?3 ORDER BY line").map_err(error)?;
    let mut rows = statement
        .query(params![chapter, (line - radius).max(0), line + radius])
        .map_err(error)?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(error)? {
        crate::text::cancellation::check()?;
        let number: i64 = row.get(0).map_err(error)?;
        let kind: &str = row.get_ref(1).map_err(error)?.as_str().map_err(error)?;
        let role: Option<&str> = match row.get_ref(2).map_err(error)? {
            rusqlite::types::ValueRef::Null => None,
            value => Some(value.as_str().map_err(error)?),
        };
        let text = row.get_ref(3).map_err(error)?.as_str().map_err(error)?;
        result.push(json!({"text":super::reader::format_line_parts(kind,role,text),"is_match":number==line}));
    }
    Ok(result)
}

struct Line<'a> {
    kind: &'static str,
    text: &'a str,
}
fn decode(mut payload: &[u8]) -> Result<Vec<Line<'_>>, String> {
    let mut result = Vec::new();
    while !payload.is_empty() {
        if payload.len() < 9 {
            return Err("truncated story block header".into());
        }
        let kind = match payload[0] {
            0 => "dialog",
            1 => "narration",
            2 => "choice",
            _ => return Err("invalid story block kind".into()),
        };
        let role_len = i32::from_le_bytes(payload[1..5].try_into().map_err(error)?);
        let text_len = u32::from_le_bytes(payload[5..9].try_into().map_err(error)?) as usize;
        if role_len < -1 {
            return Err("invalid story block role".into());
        }
        payload = &payload[9..];
        let role_bytes = role_len.max(0) as usize;
        let end = role_bytes
            .checked_add(text_len)
            .ok_or("story block overflow")?;
        if end > payload.len() {
            return Err("truncated story block text".into());
        }
        std::str::from_utf8(&payload[..role_bytes]).map_err(error)?;
        let text = std::str::from_utf8(&payload[role_bytes..end]).map_err(error)?;
        result.push(Line { kind, text });
        payload = &payload[end..];
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
pub fn search(
    db: &GameDb,
    pattern: &str,
    regex: &JsRegex,
    character: Option<&str>,
    line_type: Option<&str>,
    radius: i64,
    maximum: i64,
    event: Option<&str>,
) -> Result<Value, String> {
    let connection = db.scan_connection()?;
    if let Some(event) = event {
        if !event_exists(&connection, event)? {
            return Err(format!(
                "未找到匹配的活动：{}。",
                super::reader::py_repr(Some(event))
            ));
        }
    }
    let mut results = Vec::new();
    let character_fold = character.map(str::to_lowercase);
    let rows_mode = character.is_some();
    if rows_mode {
        let event_clause = if event.is_some() {
            "c.event=?1"
        } else {
            "?1 IS NULL"
        };
        let role_clause = if character.is_some() {
            "l.kind='dialog' AND l.role_fold=?2"
        } else {
            "?2 IS NULL"
        };
        let kind_clause = if line_type.is_some() {
            "l.kind=?3"
        } else {
            "?3 IS NULL"
        };
        let sql=format!("SELECT c.ordinal,c.event,c.story_key,c.code,l.line,l.text FROM story_chapters c JOIN story_lines l ON l.chapter=c.ordinal WHERE {event_clause} AND ({role_clause}) AND {kind_clause} ORDER BY l.chapter,l.line");
        let mut statement = connection.prepare_cached(&sql).map_err(error)?;
        let mut rows = statement
            .query(params![event, character_fold, line_type])
            .map_err(error)?;
        while let Some(row) = rows.next().map_err(error)? {
            crate::text::cancellation::check()?;
            if !regex.is_match(row.get_ref(5).map_err(error)?.as_str().map_err(error)?)? {
                continue;
            }
            let chapter: i64 = row.get(0).map_err(error)?;
            let line: i64 = row.get(4).map_err(error)?;
            results.push(json!({"event_id":row.get::<_,String>(1).map_err(error)?,"story_key":row.get::<_,String>(2).map_err(error)?,"story_code":row.get::<_,String>(3).map_err(error)?,"line_number":line+1,"context":context(&connection,chapter,line,radius)?}));
            if results.len() as i64 >= maximum {
                break;
            }
        }
    } else {
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
                results.push(json!({"event_id":row.get::<_,String>(1).map_err(error)?,"story_key":row.get::<_,String>(2).map_err(error)?,"story_code":row.get::<_,String>(3).map_err(error)?,"line_number":number+1,"context":context(&connection,chapter,number,radius)?}));
                if results.len() as i64 >= maximum {
                    break 'blocks;
                }
            }
        }
    }
    Ok(
        json!({"pattern":pattern,"filters":{"character":character,"line_type":line_type,"context_lines":radius,"event_id":event},"total":results.len(),"results":results}),
    )
}

pub fn appearances(
    db: &GameDb,
    name: &str,
    scope: Option<&str>,
    maximum: i64,
) -> Result<Value, String> {
    let connection = db.scan_connection()?;
    if let Some(scope) = scope {
        if !event_exists(&connection, scope)? {
            return Err(format!(
                "未找到匹配的活动：{}。",
                serde_json::to_string(scope).unwrap_or_default()
            ));
        }
    }
    let name_fold = name.to_lowercase();
    let mut statement=connection.prepare_cached("SELECT c.event,c.code,c.name,c.story_key,EXISTS(SELECT 1 FROM story_lines l WHERE l.chapter=c.ordinal AND l.kind='dialog' AND l.role_fold=?1),EXISTS(SELECT 1 FROM story_lines l WHERE l.chapter=c.ordinal AND instr(l.text_fold,?1)>0) FROM story_chapters c WHERE (?2 IS NULL OR c.event=?2) ORDER BY c.ordinal").map_err(error)?;
    let mut rows = statement.query(params![name_fold, scope]).map_err(error)?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(error)? {
        crate::text::cancellation::check()?;
        let speaks: bool = row.get(4).map_err(error)?;
        let mentioned: bool = row.get(5).map_err(error)?;
        if !speaks && !mentioned {
            continue;
        }
        result.push(json!({"event_id":row.get::<_,String>(0).map_err(error)?,"story_code":row.get::<_,String>(1).map_err(error)?,"story_name":row.get::<_,String>(2).map_err(error)?,"story_key":row.get::<_,String>(3).map_err(error)?,"speaks":speaks,"mentioned":mentioned}));
        if result.len() as i64 >= maximum {
            break;
        }
    }
    Ok(json!({"name":name,"total":result.len(),"filters":{"scope":scope},"appearances":result}))
}

pub fn speakers(db: &GameDb, event: &str) -> Result<Value, String> {
    let connection = db.scan_connection()?;
    if !event_exists(&connection, event)? {
        return Err(format!(
            "未找到匹配的活动：{}。",
            serde_json::to_string(event).unwrap_or_default()
        ));
    }
    let mut statement = connection
        .prepare_cached("SELECT role,count FROM story_speakers WHERE event=?1")
        .map_err(error)?;
    let mut result = statement
        .query_map([event], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?;
    result.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| crate::text::js_compat::compare_ids(&a.0, &b.0))
    });
    let result: Vec<Value> = result
        .into_iter()
        .map(|(name, count)| json!({"name":name,"line_count":count}))
        .collect();
    Ok(json!({"event_id":event,"total":result.len(),"speakers":result}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_blocks_return_errors() {
        assert!(decode(&[0]).is_err());
        assert!(decode(&[3, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
        assert!(decode(&[0, 255, 255, 255, 255, 255, 255, 255, 255]).is_err());
    }
}
