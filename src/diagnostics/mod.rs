//! Aggregated diagnostics projections (D-002 schema).
//!
//! Two read-only surfaces back `/debug/cache` and `/debug/metrics`:
//!
//! * cache counters — process-global counters attached to the REAL cache
//!   paths (per-generation dataset slots, the shared story-search index,
//!   the MediaWiki image LRU). Hit/miss totals are lifetime counters;
//!   `loaded`/`count` describe the CURRENT generation's slot state and are
//!   reset by an activation swap (`clears` increments instead).
//! * `RuntimeMetrics` — HTTP request / tool-call / session aggregates.
//!   No payloads, parameters, session ids, tokens or image bytes are ever
//!   retained (docs/04 诊断适配 D-002).

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde_json::{json, Map, Value};

// ---------------------------------------------------------------------------
// Cache stats
// ---------------------------------------------------------------------------

/// The debug projection's fixed domain order (cacheStats.ts DOMAIN_ORDER
/// plus the three direct-read domains appended in the oracle's order).
pub const CACHE_DOMAINS: [&str; 11] = [
    "operator",
    "enemy",
    "stage",
    "stage_enemy",
    "item",
    "search",
    "building",
    "skill",
    "story_search",
    "images",
    "artwork_mediawiki",
];

/// One tracked cache slot ("domain:key"), mirroring a TS loader subkey.
#[derive(Default)]
pub struct CacheSlot {
    pub hits: AtomicU64,
    pub misses: AtomicU64,
    pub clears: AtomicU64,
    /// Entries in the most recent successful load (current generation).
    pub count: AtomicU64,
    pub loaded: AtomicBool,
    /// Byte footprint; only the MediaWiki image LRU reports it (bytes==0
    /// omits the field, like TS's optional `bytes`).
    pub bytes: AtomicU64,
}

impl CacheSlot {
    fn stat_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("loaded".into(), json!(self.loaded.load(Ordering::Relaxed)));
        obj.insert("count".into(), json!(self.count.load(Ordering::Relaxed)));
        obj.insert("hits".into(), json!(self.hits.load(Ordering::Relaxed)));
        obj.insert("misses".into(), json!(self.misses.load(Ordering::Relaxed)));
        obj.insert("clears".into(), json!(self.clears.load(Ordering::Relaxed)));
        let bytes = self.bytes.load(Ordering::Relaxed);
        if bytes != 0 {
            obj.insert("bytes".into(), json!(bytes));
        }
        Value::Object(obj)
    }
}

/// Slots the debug projection always reports, pre-registered so an unused
/// path still shows an honest zero instead of vanishing.
const DATASET_SLOTS: [&str; 22] = [
    "operator:character_table",
    "operator:handbook_table",
    "operator:charword_table",
    "operator:name_to_id",
    "enemy:enemy_handbook",
    "enemy:enemy_database",
    "enemy:enemy_name_to_id",
    "enemy:enemy_search_records",
    "stage:stage_table",
    "stage:zone_table",
    // Rust-specific: list_stages builds an id-ordered map view over
    // stage_table once per generation (TS sorts inline per call).
    "stage:stages_map",
    "stage:stage_search_records",
    "stage_enemy:enemy_appearance_index",
    "item:items",
    "item:item_lookup",
    "item:item_search_records",
    "search:search_records",
    "building:building_table",
    "building:building_skill_records",
    "skill:skill_table",
    "skill:skill_search_records",
    "images:char_skins",
];

const OTHER_SLOTS: [&str; 2] = [
    "story_search:story_search_index",
    "artwork_mediawiki:image_cache",
];

#[derive(Default)]
struct CacheRegistry {
    slots: Mutex<BTreeMap<String, Arc<CacheSlot>>>,
}

fn registry() -> &'static CacheRegistry {
    static REGISTRY: OnceLock<CacheRegistry> = OnceLock::new();
    REGISTRY.get_or_init(CacheRegistry::default)
}

fn slot(name: &str) -> Arc<CacheSlot> {
    let mut slots = registry().slots.lock().expect("cache registry lock");
    slots
        .entry(name.to_string())
        .or_insert_with(|| Arc::new(CacheSlot::default()))
        .clone()
}

/// A slot was served from cache.
pub fn record_hit(name: &str) {
    slot(name).hits.fetch_add(1, Ordering::Relaxed);
}

/// A slot had no cached value; the caller is about to load.
pub fn record_miss(name: &str) {
    slot(name).misses.fetch_add(1, Ordering::Relaxed);
}

/// A load succeeded — `count` is the value's entry count (TS `count`
/// semantics: array length / object key count / loader override).
pub fn record_loaded(name: &str, count: u64) {
    let s = slot(name);
    s.loaded.store(true, Ordering::Relaxed);
    s.count.store(count, Ordering::Relaxed);
}

/// A load failed — the slot stays empty so the next call retries (the
/// loader contract); the miss was already counted by `record_miss`.
pub fn record_load_failed(name: &str) {
    let s = slot(name);
    s.loaded.store(false, Ordering::Relaxed);
    s.count.store(0, Ordering::Relaxed);
}

/// A load succeeded but cached an ABSENT value (TS loaded-null contract:
/// `{loaded: false, count: 0}` — absence is not a load, yet it is cached).
pub fn record_loaded_absent(name: &str) {
    let s = slot(name);
    s.loaded.store(false, Ordering::Relaxed);
    s.count.store(0, Ordering::Relaxed);
}

/// A byte-bearing slot's current footprint (MediaWiki image LRU). Marks the
/// slot loaded per TS `snapshot(_imageCache.size > 0, …)` semantics.
pub fn record_bytes(name: &str, bytes: u64, count: u64) {
    let s = slot(name);
    s.bytes.store(bytes, Ordering::Relaxed);
    s.count.store(count, Ordering::Relaxed);
    s.loaded.store(count > 0, Ordering::Relaxed);
}

/// An activation swap replaced the per-generation caches: lifetime hit/miss
/// counters survive, current-state fields reset and `clears` increments —
/// the observable counterpart of TS `registerActivationListener(clear…)`.
pub fn on_activation_change() {
    let slots = registry().slots.lock().expect("cache registry lock");
    for name in DATASET_SLOTS.iter().chain(OTHER_SLOTS.iter()) {
        if let Some(s) = slots.get(*name) {
            s.clears.fetch_add(1, Ordering::Relaxed);
            s.loaded.store(false, Ordering::Relaxed);
            s.count.store(0, Ordering::Relaxed);
        }
    }
}

/// The `/debug/cache` projection: 11 domains in the oracle's fixed order,
/// inner keys in the oracle's per-domain order (plus the documented
/// Rust-only `stage:stages_map` addition).
pub fn cache_snapshot() -> Value {
    {
        let mut slots = registry().slots.lock().expect("cache registry lock");
        for name in DATASET_SLOTS.iter().chain(OTHER_SLOTS.iter()) {
            slots
                .entry(name.to_string())
                .or_insert_with(|| Arc::new(CacheSlot::default()));
        }
    }
    let slots = registry().slots.lock().expect("cache registry lock");
    let empty_stat = || {
        let mut obj = Map::new();
        obj.insert("loaded".into(), json!(false));
        obj.insert("count".into(), json!(0));
        obj.insert("hits".into(), json!(0));
        obj.insert("misses".into(), json!(0));
        obj.insert("clears".into(), json!(0));
        Value::Object(obj)
    };
    let pick = |full: &str| {
        slots
            .get(full)
            .map(|s| s.stat_json())
            .unwrap_or_else(empty_stat)
    };
    let domain = |entries: &[(&str, &str)]| {
        let mut obj = Map::new();
        for (key, full) in entries {
            obj.insert((*key).to_string(), pick(full));
        }
        Value::Object(obj)
    };
    let mut out = Map::new();
    out.insert(
        "operator".into(),
        domain(&[
            ("character_table", "operator:character_table"),
            ("handbook_table", "operator:handbook_table"),
            ("charword_table", "operator:charword_table"),
            ("name_to_id", "operator:name_to_id"),
        ]),
    );
    out.insert(
        "enemy".into(),
        domain(&[
            ("enemy_handbook", "enemy:enemy_handbook"),
            ("enemy_database", "enemy:enemy_database"),
            ("enemy_name_to_id", "enemy:enemy_name_to_id"),
            ("enemy_search_records", "enemy:enemy_search_records"),
        ]),
    );
    out.insert(
        "stage".into(),
        domain(&[
            ("stage_table", "stage:stage_table"),
            ("zone_table", "stage:zone_table"),
            ("stages_map", "stage:stages_map"),
            ("stage_search_records", "stage:stage_search_records"),
        ]),
    );
    out.insert(
        "stage_enemy".into(),
        domain(&[(
            "enemy_appearance_index",
            "stage_enemy:enemy_appearance_index",
        )]),
    );
    out.insert(
        "item".into(),
        domain(&[
            ("items", "item:items"),
            ("item_lookup", "item:item_lookup"),
            ("item_search_records", "item:item_search_records"),
        ]),
    );
    out.insert(
        "search".into(),
        domain(&[("search_records", "search:search_records")]),
    );
    out.insert(
        "building".into(),
        domain(&[
            ("building_table", "building:building_table"),
            ("building_skill_records", "building:building_skill_records"),
        ]),
    );
    out.insert(
        "skill".into(),
        domain(&[
            ("skill_table", "skill:skill_table"),
            ("skill_search_records", "skill:skill_search_records"),
        ]),
    );
    out.insert(
        "story_search".into(),
        domain(&[("story_search_index", "story_search:story_search_index")]),
    );
    out.insert(
        "images".into(),
        domain(&[("char_skins", "images:char_skins")]),
    );
    out.insert(
        "artwork_mediawiki".into(),
        domain(&[("image_cache", "artwork_mediawiki:image_cache")]),
    );
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// Process memory (/proc readers — Linux is this replication's deployment
// target; a missing /proc falls back to 0, never a fabricated value.)
// ---------------------------------------------------------------------------

const PAGE_SIZE: u64 = 4096;

/// Current RSS in bytes (`/proc/self/statm` resident pages).
pub fn rss_bytes() -> u64 {
    let Ok(text) = std::fs::read_to_string("/proc/self/statm") else {
        return 0;
    };
    let mut parts = text.split_whitespace();
    parts.next();
    parts
        .next()
        .and_then(|p| p.parse::<u64>().ok())
        .map(|pages| pages * PAGE_SIZE)
        .unwrap_or(0)
}

/// Peak RSS (`VmHWM` from `/proc/self/status`) — the faithful analogue of
/// TS tracking the max of `process.memoryUsage().rss`.
pub fn rss_high_water_bytes() -> u64 {
    let Ok(text) = std::fs::read_to_string("/proc/self/status") else {
        return 0;
    };
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            return rest
                .trim()
                .trim_end_matches("kB")
                .trim()
                .parse::<u64>()
                .map(|kb| kb * 1024)
                .unwrap_or(0);
        }
    }
    0
}

// ---------------------------------------------------------------------------
// Runtime metrics
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ToolCounters {
    total: AtomicU64,
    in_flight: AtomicU64,
    duration_ms_total: AtomicU64,
    duration_ms_max: AtomicU64,
    rss_after_max: AtomicU64,
}

// f64 accumulators over AtomicU64 bit patterns (TS keeps fractional
// millisecond durations; integer ms would collapse sub-millisecond calls
// to zero).
fn f64_add(slot: &AtomicU64, value: f64) {
    let mut bits = slot.load(Ordering::Relaxed);
    loop {
        let new = f64::from_bits(bits) + value;
        match slot.compare_exchange(bits, new.to_bits(), Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return,
            Err(actual) => bits = actual,
        }
    }
}

fn f64_load(slot: &AtomicU64) -> f64 {
    f64::from_bits(slot.load(Ordering::Relaxed))
}

/// Aggregate HTTP/tool/session instrumentation for the process lifetime.
/// Constructed only when PRTS_METRICS_ENABLED is exactly "true".
pub struct RuntimeMetrics {
    started_at: Instant,
    requests_in_flight: AtomicU64,
    requests_total: AtomicU64,
    http_errors_total: AtomicU64,
    request_duration_ms_total: AtomicU64,
    request_duration_ms_max: AtomicU64,
    rss_high_water: AtomicU64,
    sessions_initialized: AtomicU64,
    sessions_closed: AtomicU64,
    sessions_evicted: AtomicU64,
    tools: Mutex<BTreeMap<String, Arc<ToolCounters>>>,
    /// Fixed allow-list of registered tool names (metrics label guard).
    tool_names: std::collections::HashSet<String>,
}

pub struct RequestToken {
    started_at: Instant,
    tool_name: Option<String>,
}

impl RuntimeMetrics {
    pub fn new(tool_names: impl IntoIterator<Item = String>) -> Self {
        Self {
            started_at: Instant::now(),
            requests_in_flight: AtomicU64::new(0),
            requests_total: AtomicU64::new(0),
            http_errors_total: AtomicU64::new(0),
            request_duration_ms_total: AtomicU64::new(0),
            request_duration_ms_max: AtomicU64::new(0),
            rss_high_water: AtomicU64::new(0),
            sessions_initialized: AtomicU64::new(0),
            sessions_closed: AtomicU64::new(0),
            sessions_evicted: AtomicU64::new(0),
            tools: Mutex::new(BTreeMap::new()),
            tool_names: tool_names.into_iter().collect(),
        }
    }

    fn observe_rss(&self) -> u64 {
        let rss = rss_bytes();
        let mut high = self.rss_high_water.load(Ordering::Relaxed);
        while rss > high {
            match self.rss_high_water.compare_exchange(
                high,
                rss,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => high = actual,
            }
        }
        rss
    }

    /// `toolNameFromBody`: only registered tools/call names become labels.
    pub fn tool_name_of(&self, body: &Value) -> Option<String> {
        if body.get("method").and_then(Value::as_str) != Some("tools/call") {
            return None;
        }
        let name = body.get("params")?.get("name")?.as_str()?;
        self.tool_names.contains(name).then(|| name.to_string())
    }

    pub fn begin_request(&self, body: &Value) -> RequestToken {
        self.requests_in_flight.fetch_add(1, Ordering::Relaxed);
        let tool_name = self.tool_name_of(body);
        if let Some(name) = &tool_name {
            self.tool_counters(name)
                .in_flight
                .fetch_add(1, Ordering::Relaxed);
        }
        RequestToken {
            started_at: Instant::now(),
            tool_name,
        }
    }

    pub fn finish_request(&self, token: RequestToken, status_code: u16) {
        let elapsed_ms = token.started_at.elapsed().as_secs_f64() * 1000.0;
        self.requests_in_flight.fetch_sub(1, Ordering::Relaxed);
        self.requests_total.fetch_add(1, Ordering::Relaxed);
        f64_add(&self.request_duration_ms_total, elapsed_ms);
        f64_max(&self.request_duration_ms_max, elapsed_ms);
        if status_code >= 400 {
            self.http_errors_total.fetch_add(1, Ordering::Relaxed);
        }
        let rss = self.observe_rss();
        if let Some(name) = &token.tool_name {
            let counters = self.tool_counters(name);
            counters.in_flight.fetch_sub(1, Ordering::Relaxed);
            counters.total.fetch_add(1, Ordering::Relaxed);
            f64_add(&counters.duration_ms_total, elapsed_ms);
            f64_max(&counters.duration_ms_max, elapsed_ms);
            fetch_max(&counters.rss_after_max, rss);
        }
    }

    fn tool_counters(&self, name: &str) -> Arc<ToolCounters> {
        self.tools
            .lock()
            .expect("metrics tools lock")
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(ToolCounters::default()))
            .clone()
    }

    pub fn session_initialized(&self) {
        self.sessions_initialized.fetch_add(1, Ordering::Relaxed);
    }

    pub fn session_closed(&self) {
        self.sessions_closed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn session_evicted(&self) {
        self.sessions_evicted.fetch_add(1, Ordering::Relaxed);
    }

    /// The `/debug/metrics` snapshot (D-002: `prts-mcp.rust.metrics/v1` —
    /// V8 heap fields dropped, real Linux RSS measurements retained,
    /// `runtime: "rust"` added).
    pub fn snapshot(
        &self,
        server_version: &str,
        idle_timeout_ms: Option<f64>,
        sessions: &[(u64, u64)],
    ) -> Value {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let rss = self.observe_rss();
        let mut ages = sessions
            .iter()
            .map(|(created, _)| now_ms.saturating_sub(*created));
        let mut idles = sessions
            .iter()
            .map(|(_, last)| now_ms.saturating_sub(*last));
        let oldest_age_ms = ages
            .next()
            .map(|first| ages.fold(first, u64::max))
            .unwrap_or(0);
        let max_idle_age_ms = idles
            .next()
            .map(|first| idles.fold(first, u64::max))
            .unwrap_or(0);

        let mut by_name = Map::new();
        let mut in_flight_total = 0u64;
        let mut calls_total = 0u64;
        {
            let tools = self.tools.lock().expect("metrics tools lock");
            for (name, counters) in tools.iter() {
                in_flight_total += counters.in_flight.load(Ordering::Relaxed);
                calls_total += counters.total.load(Ordering::Relaxed);
                by_name.insert(
                    name.clone(),
                    json!({
                        "total": counters.total.load(Ordering::Relaxed),
                        "in_flight": counters.in_flight.load(Ordering::Relaxed),
                        "duration_ms_total": f64_load(&counters.duration_ms_total),
                        "duration_ms_max": f64_load(&counters.duration_ms_max),
                        "rss_after_max_bytes": counters.rss_after_max.load(Ordering::Relaxed),
                    }),
                );
            }
        }

        json!({
            "schema_version": "prts-mcp.rust.metrics/v1",
            "server": {
                "version": server_version,
                "uptime_ms": self.started_at.elapsed().as_millis() as u64,
            },
            "process": {
                "rss_bytes": rss,
                "rss_high_water_bytes": self.rss_high_water.load(Ordering::Relaxed),
                "runtime": "rust",
            },
            "requests": {
                "in_flight": self.requests_in_flight.load(Ordering::Relaxed),
                "total": self.requests_total.load(Ordering::Relaxed),
                "http_errors_total": self.http_errors_total.load(Ordering::Relaxed),
                "duration_ms_total": f64_load(&self.request_duration_ms_total),
                "duration_ms_max": f64_load(&self.request_duration_ms_max),
            },
            "tool_calls": {
                "in_flight": in_flight_total,
                "total": calls_total,
                "by_name": Value::Object(by_name),
            },
            "sessions": {
                "idle_timeout_ms": idle_timeout_ms,
                "active": sessions.len(),
                "oldest_age_ms": oldest_age_ms,
                "max_idle_age_ms": max_idle_age_ms,
                "initialized_total": self.sessions_initialized.load(Ordering::Relaxed),
                "closed_total": self.sessions_closed.load(Ordering::Relaxed),
                "evicted_total": self.sessions_evicted.load(Ordering::Relaxed),
            },
            "cache": cache_snapshot(),
        })
    }
}

fn f64_max(slot: &AtomicU64, value: f64) {
    let mut bits = slot.load(Ordering::Relaxed);
    loop {
        if f64::from_bits(bits) >= value {
            return;
        }
        match slot.compare_exchange(bits, value.to_bits(), Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return,
            Err(actual) => bits = actual,
        }
    }
}

fn fetch_max(slot: &AtomicU64, value: u64) {
    let mut current = slot.load(Ordering::Relaxed);
    while value > current {
        match slot.compare_exchange(current, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_snapshot_has_eleven_domains_in_order() {
        let snapshot = cache_snapshot();
        let keys: Vec<&String> = snapshot.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 11);
        assert_eq!(
            keys.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            CACHE_DOMAINS.to_vec()
        );
        for (_, domain) in snapshot.as_object().unwrap() {
            for (_, stat) in domain.as_object().unwrap() {
                let fields = stat.as_object().unwrap();
                for f in ["loaded", "count", "hits", "misses", "clears"] {
                    assert!(fields.contains_key(f), "{f} missing in {stat}");
                }
            }
        }
    }

    #[test]
    fn counters_track_real_activity() {
        record_miss("search:search_records");
        record_loaded("search:search_records", 7);
        record_hit("search:search_records");
        record_hit("search:search_records");
        let snapshot = cache_snapshot();
        let stat = &snapshot["search"]["search_records"];
        assert_eq!(stat["loaded"], json!(true));
        assert_eq!(stat["count"], json!(7));
        assert_eq!(stat["hits"], json!(2));
        assert_eq!(stat["misses"], json!(1));
        assert_eq!(stat["clears"], json!(0));

        on_activation_change();
        let snapshot = cache_snapshot();
        let stat = &snapshot["search"]["search_records"];
        assert_eq!(stat["loaded"], json!(false));
        assert_eq!(stat["count"], json!(0));
        assert_eq!(stat["clears"], json!(1));
        // Lifetime counters survive the swap.
        assert_eq!(stat["hits"], json!(2));
        assert_eq!(stat["misses"], json!(1));
    }

    #[test]
    fn metrics_snapshot_rust_schema() {
        let metrics = RuntimeMetrics::new(["list_stages".to_string(), "search".to_string()]);
        let body: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_stages","arguments":{}}}"#,
        )
        .unwrap();
        let token = metrics.begin_request(&body);
        metrics.finish_request(token, 200);
        metrics.session_initialized();
        let snapshot = metrics.snapshot("test", Some(86_400_000.0), &[]);
        assert_eq!(
            snapshot["schema_version"],
            json!("prts-mcp.rust.metrics/v1")
        );
        assert_eq!(snapshot["process"]["runtime"], json!("rust"));
        // D-002: V8 heap fields must not appear.
        for absent in [
            "heap_total_bytes",
            "heap_used_bytes",
            "external_bytes",
            "array_buffers_bytes",
        ] {
            assert!(snapshot["process"].get(absent).is_none());
        }
        assert_eq!(snapshot["requests"]["total"], json!(1));
        assert_eq!(snapshot["tool_calls"]["total"], json!(1));
        assert_eq!(
            snapshot["tool_calls"]["by_name"]["list_stages"]["total"],
            json!(1)
        );
        assert_eq!(snapshot["sessions"]["initialized_total"], json!(1));
        assert!(snapshot["process"]["rss_bytes"].as_u64().unwrap_or(0) > 0);
        assert!(
            snapshot["process"]["rss_high_water_bytes"]
                .as_u64()
                .unwrap_or(0)
                > 0
        );
    }

    #[test]
    fn unregistered_tool_names_are_not_labels() {
        let metrics = RuntimeMetrics::new(["search".to_string()]);
        let body: Value = serde_json::from_str(
            r#"{"method":"tools/call","params":{"name":"not-a-tool","arguments":{}}}"#,
        )
        .unwrap();
        assert!(metrics.tool_name_of(&body).is_none());
        let snapshot = metrics.snapshot("test", None, &[]);
        assert!(snapshot["tool_calls"]["by_name"]
            .as_object()
            .unwrap()
            .is_empty());
    }
}
