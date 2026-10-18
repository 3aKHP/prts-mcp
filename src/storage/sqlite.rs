//! Immutable SQLite dataset; all source fields remain recoverable.
use flate2::read::ZlibDecoder;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

pub const APPLICATION_ID: i32 = 0x50525453;
pub const SCHEMA_VERSION: i32 = 1;
pub const INDEX_VERSION: i32 = 1;
pub const CONTRACT: &str = "prts-mcp-sqlite/v1";
type SharedDatabases = HashMap<(PathBuf, String), Weak<GameDb>>;
static DATABASES: OnceLock<Mutex<SharedDatabases>> = OnceLock::new();

pub struct GameDb {
    pub path: PathBuf,
    pub(crate) connection: Mutex<Connection>,
    scans: [Mutex<Connection>; 2],
    next_scan: AtomicUsize,
    _lease: Option<std::fs::File>,
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn reader(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(err)?;
    connection.execute_batch("PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;").map_err(err)?;
    Ok(connection)
}

fn verify_schema(connection: &Connection) -> Result<(), String> {
    for sql in [
        "SELECT namespace,path,sha256 FROM sources LIMIT 0",
        "SELECT sha256,raw_len,body FROM source_blobs LIMIT 0",
        "SELECT dataset,bucket,key,ordinal,payload,aux FROM entities LIMIT 0",
        "SELECT dataset,name,key,ordinal FROM names LIMIT 0",
        "SELECT scope,ordinal,text,payload FROM searches LIMIT 0",
        "SELECT scope,block,first_ordinal,last_ordinal,payload FROM search_blocks LIMIT 0",
        "SELECT id FROM story_events LIMIT 0",
        "SELECT ordinal,event,story_key,code,name,line_count FROM story_chapters LIMIT 0",
        "SELECT id,chapter,line,kind,role,role_fold,text,text_fold FROM story_lines LIMIT 0",
        "SELECT chapter,block,first_line,last_line,payload FROM story_blocks LIMIT 0",
        "SELECT event,role,count FROM story_speakers LIMIT 0",
        "SELECT enemy,ordinal,stage,count FROM enemy_appearances LIMIT 0",
    ] {
        connection.prepare(sql).map_err(err)?;
    }
    Ok(())
}

impl GameDb {
    /// A fixed scan pool isolates ordinary entity reads from long regex scans.
    /// Two bounded page caches are shared across all clients in a generation.
    pub(crate) fn scan_connection(&self) -> Result<MutexGuard<'_, Connection>, String> {
        for connection in &self.scans {
            if let Ok(guard) = connection.try_lock() {
                return Ok(guard);
            }
        }
        self.scans[self.next_scan.fetch_add(1, Ordering::Relaxed) % self.scans.len()]
            .lock()
            .map_err(err)
    }

    pub fn open(path: &Path) -> Result<Arc<Self>, String> {
        let mut databases = DATABASES.get_or_init(Mutex::default).lock().map_err(err)?;
        let identity = super::identity::path_token(path).ok_or("SQLite file is unavailable")?;
        let key = (path.to_owned(), identity);
        if let Some(db) = databases.get(&key).and_then(Weak::upgrade) {
            return Ok(db);
        }
        let db = Self::open_detached(path)?;
        databases.retain(|_, value| value.strong_count() > 0);
        databases.insert(key, Arc::downgrade(&db));
        Ok(db)
    }

    pub fn open_detached(path: &Path) -> Result<Arc<Self>, String> {
        Self::open_checked(path, true)
    }

    /// Only the sync verifier may defer page checks to its full integrity pass.
    pub(crate) fn for_verification(path: &Path) -> Result<Arc<Self>, String> {
        Self::open_checked(path, false)
    }

    fn open_checked(path: &Path, quick: bool) -> Result<Arc<Self>, String> {
        let observed = super::validation::Observation::begin(path)?;
        let quick = quick && !super::validation::contains(path, None);
        let lease_path = super::database::lease_path(path);
        let lease = match std::fs::File::open(lease_path) {
            Ok(file) => {
                file.try_lock_shared().map_err(err)?;
                Some(file)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let connection = reader(path)?;
        let application: i32 = connection
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .map_err(err)?;
        let schema: i32 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(err)?;
        if application != APPLICATION_ID || schema != SCHEMA_VERSION {
            return Err(format!(
                "unsupported SQLite dataset: application={application}, schema={schema}"
            ));
        }
        let complete: Option<String> = connection
            .query_row(
                "SELECT value FROM meta WHERE key='sources_complete'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if complete.as_deref() != Some("1") {
            return Err("incomplete SQLite dataset".into());
        }
        for (key, wanted) in [
            ("contract", CONTRACT),
            ("index_version", "1"),
            ("language", "zh_CN"),
        ] {
            let value: Option<String> = connection
                .query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))
                .optional()
                .map_err(err)?;
            if value.as_deref() != Some(wanted) {
                return Err(format!("unsupported SQLite {key}: {value:?}"));
            }
        }
        verify_schema(&connection)?;
        // Validate pages once per opened identity, before publishing the shared
        // handle. Steady-state snapshots reuse the admitted connection pool.
        if quick {
            let check: String = connection
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .map_err(err)?;
            if check != "ok" {
                return Err(format!("SQLite quick_check failed: {check}"));
            }
        }
        let db = Arc::new(Self {
            path: path.to_owned(),
            connection: Mutex::new(connection),
            scans: [Mutex::new(reader(path)?), Mutex::new(reader(path)?)],
            next_scan: AtomicUsize::new(0),
            _lease: lease,
        });
        observed.check()?;
        Ok(db)
    }

    pub fn metadata(&self, key: &str) -> Result<Option<String>, String> {
        self.connection
            .lock()
            .map_err(err)?
            .query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))
            .optional()
            .map_err(err)
    }

    pub fn exists(&self, namespace: &str, path: &str) -> Result<bool, String> {
        self.connection
            .lock()
            .map_err(err)?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sources WHERE namespace=?1 AND path=?2)",
                params![namespace, path],
                |r| r.get(0),
            )
            .map_err(err)
    }

    pub fn raw(&self, namespace: &str, path: &str) -> Result<Vec<u8>, String> {
        let body: Vec<u8> = self
            .connection
            .lock()
            .map_err(err)?
            .query_row(
                "SELECT b.body FROM sources s JOIN source_blobs b ON b.sha256=s.sha256 WHERE s.namespace=?1 AND s.path=?2",
                params![namespace, path],
                |r| r.get(0),
            )
            .map_err(err)?;
        let mut decoded = Vec::new();
        ZlibDecoder::new(body.as_slice())
            .read_to_end(&mut decoded)
            .map_err(err)?;
        Ok(decoded)
    }

    pub fn read_json(&self, namespace: &str, path: &str) -> Result<Value, String> {
        serde_json::from_slice(&self.raw(namespace, path)?).map_err(err)
    }

    pub fn entity(&self, dataset: &str, bucket: &str, key: &str) -> Result<Option<Value>, String> {
        let text: Option<String> = self
            .connection
            .lock()
            .map_err(err)?
            .query_row(
                "SELECT payload FROM entities WHERE dataset=?1 AND bucket=?2 AND key=?3",
                params![dataset, bucket, key],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        text.map(|text| serde_json::from_str(&text).map_err(err))
            .transpose()
    }

    pub fn entity_map(
        &self,
        dataset: &str,
        bucket: &str,
        key: Option<&str>,
        aux: Option<&str>,
    ) -> Result<Map<String, Value>, String> {
        let connection = self.connection.lock().map_err(err)?;
        let key_clause = if key.is_some() {
            "key=?3"
        } else {
            "?3 IS NULL"
        };
        let aux_clause = if aux.is_some() {
            "aux=?4"
        } else {
            "?4 IS NULL"
        };
        let sql=format!("SELECT key,payload FROM entities WHERE dataset=?1 AND bucket=?2 AND {key_clause} AND {aux_clause} ORDER BY ordinal");
        let mut statement = connection.prepare_cached(&sql).map_err(err)?;
        let mut rows = statement
            .query(params![dataset, bucket, key, aux])
            .map_err(err)?;
        let mut map = Map::new();
        while let Some(row) = rows.next().map_err(err)? {
            let text: String = row.get(1).map_err(err)?;
            map.insert(
                row.get(0).map_err(err)?,
                serde_json::from_str(&text).map_err(err)?,
            );
        }
        Ok(map)
    }

    pub fn enemy_appearances(&self, enemy: &str) -> Result<Vec<(String, i64)>, String> {
        let connection = self.connection.lock().map_err(err)?;
        let mut statement = connection
            .prepare_cached(
                "SELECT stage,count FROM enemy_appearances WHERE enemy=?1 ORDER BY ordinal",
            )
            .map_err(err)?;
        let rows = statement
            .query_map([enemy], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    pub fn names(&self, dataset: &str) -> Result<Vec<(String, String)>, String> {
        let connection = self.connection.lock().map_err(err)?;
        let mut statement = connection
            .prepare_cached("SELECT name,key FROM names WHERE dataset=?1 ORDER BY ordinal")
            .map_err(err)?;
        let rows = statement
            .query_map([dataset], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    pub fn name_id(&self, dataset: &str, name: &str) -> Result<Option<String>, String> {
        self.connection
            .lock()
            .map_err(err)?
            .query_row(
                "SELECT key FROM names WHERE dataset=?1 AND name=?2",
                params![dataset, name],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)
    }

    pub fn derived_ready(&self) -> bool {
        self.metadata("derived_complete").ok().flatten().as_deref() == Some("1")
    }

    pub fn verify(&self) -> Result<(), String> {
        let connection = self.connection.lock().map_err(err)?;
        let check: String = connection
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(err)?;
        if check != "ok" {
            return Err(check);
        }
        let mut foreign = connection
            .prepare("PRAGMA foreign_key_check")
            .map_err(err)?;
        if foreign
            .query([])
            .map_err(err)?
            .next()
            .map_err(err)?
            .is_some()
        {
            return Err("SQLite source archive has missing blobs".into());
        }
        if !self.derived_ready_unlocked(&connection)? {
            return Err("missing derived data".into());
        }
        verify_schema(&connection)
    }

    fn derived_ready_unlocked(&self, connection: &Connection) -> Result<bool, String> {
        Ok(connection
            .query_row(
                "SELECT value FROM meta WHERE key='derived_complete'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .as_deref()
            == Some("1"))
    }
}

pub fn is_database(path: &Path) -> bool {
    let mut header = [0u8; 16];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && &header == b"SQLite format 3\0"
}
