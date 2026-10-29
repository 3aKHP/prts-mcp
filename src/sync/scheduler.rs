//! Startup data sync orchestration — port of TS `startupSync.ts`.
//!
//! Owns the retry/backoff scheduling (30s/120s/600s), single-flight locking
//! per dataset, and the periodic auto-sync cycle. All timers live as spawned
//! tokio tasks: when the process exits (stdio EOF, signal), the runtime drop
//! cancels them — retries and timers never keep the process alive, matching
//! the `unref()` effect in the oracle.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::datasets;
use super::pair::sync_release_archive_pair;
use super::release::sync_release_with_source;
use super::transport::Transport;
use super::types::{SyncResult, SyncStatus};
use crate::config::RuntimeConfig;
use crate::{log_err, log_info, log_warn};

const SYNC_RETRY_DELAYS_MS: [u64; 3] = [30_000, 120_000, 600_000];
pub const AUTO_SYNC_DEFAULT_INTERVAL_SECONDS: u64 = 3600;
const AUTO_SYNC_MIN_INTERVAL_SECONDS: f64 = 60.0;
const AUTO_SYNC_MAX_INTERVAL_SECONDS: f64 = 7.0 * 24.0 * 60.0 * 60.0;

fn sha_prefix(result: &SyncResult) -> String {
    result
        .commit_sha
        .as_deref()
        .map(|sha| sha.chars().take(8).collect())
        .unwrap_or_else(|| "unknown".to_string())
}

fn log_sync_result(
    label: &str,
    result: &SyncResult,
    noun: &str,
    source: &crate::config::DataSource,
) {
    let repo = source.log_label();
    let sha = sha_prefix(result);
    match result.status {
        SyncStatus::Updated => log_info(&format!(
            "{noun} updated from GitHub Release ({repo} @ {sha})."
        )),
        SyncStatus::UpToDate => log_info(&format!("{noun} is up to date ({repo} @ {sha}).")),
        SyncStatus::OfflineFallback => log_warn(&format!(
            "Network unavailable; using cached {label} ({repo} @ {sha}). Error: {}",
            result.error.clone().unwrap_or_default()
        )),
        SyncStatus::NoData => log_err(&format!(
            "{noun} sync failed for {repo} — no data. Error: {}",
            result.error.clone().unwrap_or_default()
        )),
    }
}

fn should_retry(status: SyncStatus) -> bool {
    status == SyncStatus::OfflineFallback || status == SyncStatus::NoData
}

/// `gamedataPairNeedsRetry` (#102): a commitSha mismatch alone must NOT
/// trigger dense retries — only offline_fallback / no_data do.
pub fn gamedata_pair_needs_retry(excel: SyncStatus, levels: SyncStatus) -> bool {
    should_retry(excel) || should_retry(levels)
}

/// `resolveAutoSyncIntervalMs`: `/^[+-]?\d+$/`, 0 = startup only,
/// 60..604800 else warn + default 3600s.
pub fn resolve_auto_sync_interval_ms(raw: Option<&str>) -> u64 {
    let default_ms = AUTO_SYNC_DEFAULT_INTERVAL_SECONDS * 1000;
    let Some(raw) = raw else {
        return default_ms;
    };
    let normalized = raw.trim();
    let digits = normalized
        .strip_prefix('+')
        .or_else(|| normalized.strip_prefix('-'))
        .unwrap_or(normalized);
    let integer_spelling = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    let interval: f64 = if integer_spelling {
        normalized.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    };
    if interval == 0.0 {
        return 0;
    }
    if !interval.is_finite()
        || interval.fract() != 0.0
        || !(AUTO_SYNC_MIN_INTERVAL_SECONDS..=AUTO_SYNC_MAX_INTERVAL_SECONDS).contains(&interval)
    {
        log_warn(&format!(
            "Invalid PRTS_AUTO_SYNC_INTERVAL_SECONDS={}; using {AUTO_SYNC_DEFAULT_INTERVAL_SECONDS}s.",
            serde_json::to_string(raw).unwrap_or_default()
        ));
        return default_ms;
    }
    (interval as u64) * 1000
}

/// Per-process single-flight registry: one labeled sync at a time.
#[derive(Default)]
pub struct SingleFlight {
    in_flight: Mutex<HashSet<&'static str>>,
}

enum FlightOutcome {
    Retry,
    Done,
    Skipped,
}

impl SingleFlight {
    async fn run(
        &self,
        label: &'static str,
        run: impl std::future::Future<Output = bool>,
    ) -> FlightOutcome {
        {
            let mut guard = self.in_flight.lock().expect("single-flight lock");
            if guard.contains(label) {
                log_info(&format!(
                    "{label} sync is already running; skipping overlapping attempt."
                ));
                return FlightOutcome::Skipped;
            }
            guard.insert(label);
        }
        let needs_retry = run.await;
        self.in_flight
            .lock()
            .expect("single-flight lock")
            .remove(label);
        if needs_retry {
            FlightOutcome::Retry
        } else {
            FlightOutcome::Done
        }
    }
}

async fn run_gamedata_sync(cfg: &RuntimeConfig, transport: &dyn Transport, force: bool) -> bool {
    if let Err(error) = super::source_guard::prepare(cfg) {
        log_err(&error);
        return true;
    }
    let excel = datasets::excel_archive_spec_with_source(&cfg.gamedata_path, &cfg.data_source);
    let levels = datasets::levels_archive_spec_with_source(&cfg.levels_path, &cfg.data_source);
    let (excel_result, levels_result) =
        match sync_release_archive_pair(transport, &excel, &levels, force).await {
            Ok(pair) => pair,
            Err(err) => {
                log_err(&format!("Startup sync threw unexpectedly: {err}"));
                return true;
            }
        };
    log_sync_result("data", &excel_result, "Data", &cfg.data_source);
    log_sync_result("level data", &levels_result, "Level data", &cfg.data_source);
    // Cache clearing (TS) corresponds here to the DataView signature swap:
    // an activation rewrites the pointer files, and the next tool call takes
    // a fresh snapshot — no in-place caches to flush in P2.
    gamedata_pair_needs_retry(excel_result.status, levels_result.status)
}

async fn run_story_sync(cfg: &RuntimeConfig, transport: &dyn Transport, force: bool) -> bool {
    if let Err(error) = super::source_guard::prepare(cfg) {
        log_err(&error);
        return true;
    }
    let spec = datasets::story_release_spec_with_source(&cfg.storyjson_zip, &cfg.data_source);
    let result = sync_release_with_source(transport, &spec, force, &cfg.data_source).await;
    log_sync_result("storyjson", &result, "Storyjson", &cfg.data_source);
    should_retry(result.status)
}

/// One startup/auto cycle: run the enabled datasets concurrently. Retries
/// are scheduled by the caller for the startup cycle only (force=false).
async fn run_cycle(
    cfg: &RuntimeConfig,
    transport: Arc<dyn Transport>,
    single_flight: Arc<SingleFlight>,
    force: bool,
) -> Vec<(&'static str, bool)> {
    // TS pushes all dataset tasks and awaits Promise.all — datasets run
    // concurrently, each serialized per-label by single-flight.
    let (gamedata_res, story_res) = tokio::join!(
        async {
            if cfg.is_custom_gamedata {
                log_info(&format!(
                    "GAMEDATA_PATH is custom ({}); auto-sync disabled.",
                    cfg.gamedata_path.display()
                ));
                None
            } else {
                let outcome = single_flight
                    .run(
                        "Gamedata",
                        run_gamedata_sync(cfg, transport.as_ref(), force),
                    )
                    .await;
                Some(matches!(outcome, FlightOutcome::Retry))
            }
        },
        async {
            if cfg.story_sync_enabled {
                let outcome = single_flight
                    .run("Storyjson", run_story_sync(cfg, transport.as_ref(), force))
                    .await;
                Some(matches!(outcome, FlightOutcome::Retry))
            } else {
                log_info(&format!(
                    "STORYJSON_PATH is set ({}); story auto-sync disabled.",
                    cfg.storyjson_zip.display()
                ));
                None
            }
        },
    );

    // Images artwork sync (2.5.0) — LOCAL_IMAGE mode consumes AKDP assets.
    let images_outcome = async {
        if cfg.images_enabled && cfg.local_image {
            let outcome = single_flight
                .run("Images", run_images_sync(cfg, transport.as_ref(), force))
                .await;
            Some(matches!(outcome, FlightOutcome::Retry))
        } else {
            None
        }
    };

    let mut outcomes = Vec::new();
    if let Some(needs_retry) = gamedata_res {
        outcomes.push(("Gamedata", needs_retry));
    }
    if let Some(needs_retry) = story_res {
        outcomes.push(("Storyjson", needs_retry));
    }
    if let Some(needs_retry) = images_outcome.await {
        outcomes.push(("Images", needs_retry));
    }
    outcomes
}

/// One images cycle: full baseline/delta chain, ORIGINAL_IMAGE picks the
/// shard set; offline/no_data arm the dense retry chain like the others.
async fn run_images_sync(cfg: &RuntimeConfig, transport: &dyn Transport, force: bool) -> bool {
    let result = super::images_sync::sync_images_with_source(
        &cfg.images_path,
        transport,
        super::images_sync::ImagesSyncOpts {
            include_original: cfg.original_image,
            force_check: force,
        },
        &cfg.data_source,
    )
    .await;
    let repo = cfg.data_source.log_label();
    let sha = result
        .commit_sha
        .as_deref()
        .map(|s| &s[..s.len().min(8)])
        .unwrap_or("unknown")
        .to_string();
    match result.status {
        SyncStatus::Updated => {
            log_info(&format!(
                "Images updated from GitHub Release ({repo} @ {sha})."
            ));
        }
        SyncStatus::UpToDate => {
            log_info(&format!("Images are up to date ({repo} @ {sha})."));
        }
        SyncStatus::OfflineFallback => {
            log_warn(&format!(
                "Network unavailable; using cached images ({repo} @ {sha}). Error: {}",
                result.error.unwrap_or_default()
            ));
        }
        SyncStatus::NoData => {
            log_warn(&format!(
                "Images sync failed — no data. Error: {}",
                result.error.unwrap_or_default()
            ));
        }
    }
    matches!(
        result.status,
        SyncStatus::OfflineFallback | SyncStatus::NoData
    )
}

/// `scheduleSyncRetry`: dense retry chain 30s → 120s → 600s, then wait for
/// the next periodic cycle or process start.
fn schedule_sync_retry(
    label: &'static str,
    attempt: usize,
    cfg: Arc<RuntimeConfig>,
    transport: Arc<dyn Transport>,
    single_flight: Arc<SingleFlight>,
) {
    let Some(delay_ms) = SYNC_RETRY_DELAYS_MS.get(attempt).copied() else {
        log_warn(&format!(
            "{label} sync still needs retry after {} attempts; waiting for the next periodic cycle or process start.",
            SYNC_RETRY_DELAYS_MS.len()
        ));
        return;
    };
    log_info(&format!("{label} sync will retry in {}s.", delay_ms / 1000));
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        let outcome = single_flight
            .run(label, {
                let cfg = Arc::clone(&cfg);
                let transport = Arc::clone(&transport);
                async move {
                    match label {
                        "Gamedata" => run_gamedata_sync(&cfg, transport.as_ref(), true).await,
                        "Images" => run_images_sync(&cfg, transport.as_ref(), true).await,
                        _ => run_story_sync(&cfg, transport.as_ref(), true).await,
                    }
                }
            })
            .await;
        match outcome {
            FlightOutcome::Skipped => {
                schedule_sync_retry(label, attempt, cfg, transport, single_flight)
            }
            FlightOutcome::Retry => {
                schedule_sync_retry(label, attempt + 1, cfg, transport, single_flight)
            }
            FlightOutcome::Done => {}
        }
    });
}

/// `runStartupSync`: one cycle; for the startup pass (force=false) any
/// dataset that still needs data gets the dense retry chain.
pub async fn run_startup_sync(cfg: Arc<RuntimeConfig>, transport: Arc<dyn Transport>, force: bool) {
    let single_flight = Arc::new(SingleFlight::default());
    let outcomes = run_cycle(
        &cfg,
        Arc::clone(&transport),
        Arc::clone(&single_flight),
        force,
    )
    .await;
    if force {
        // Periodic cycles never arm the dense retry chain (TS gates on
        // !forceCheck); the next periodic pass handles persistent failures.
        return;
    }
    for (label, needs_retry) in outcomes {
        if needs_retry {
            schedule_sync_retry(
                label,
                0,
                Arc::clone(&cfg),
                Arc::clone(&transport),
                single_flight.clone(),
            );
        }
    }
}

/// `startAutoSync` — the background task set for a running server. Returns
/// immediately; all cycles/retries run as spawned tasks.
fn start_sqlite_sync(cfg: Arc<RuntimeConfig>, transport: Arc<dyn Transport>) {
    super::database::start(Arc::clone(&cfg), Arc::clone(&transport));
    if cfg.local_image && cfg.images_enabled {
        let single_flight = Arc::new(SingleFlight::default());
        tokio::spawn(async move {
            let mut force = false;
            loop {
                let outcome = single_flight
                    .run("Images", run_images_sync(&cfg, transport.as_ref(), force))
                    .await;
                if !force && matches!(outcome, FlightOutcome::Retry) {
                    schedule_sync_retry(
                        "Images",
                        0,
                        Arc::clone(&cfg),
                        Arc::clone(&transport),
                        Arc::clone(&single_flight),
                    );
                }
                if cfg.auto_sync_interval_ms == 0 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(cfg.auto_sync_interval_ms)).await;
                force = true;
            }
        });
    }
}

/// Only the selected backend starts game-data workers. Images are shared.
pub fn start_background_sync(cfg: Arc<RuntimeConfig>, transport: Arc<dyn Transport>) {
    match cfg.data_backend {
        crate::config::DataBackend::Json => start_json_sync(cfg, transport),
        crate::config::DataBackend::Sqlite => start_sqlite_sync(cfg, transport),
    }
}

fn start_json_sync(cfg: Arc<RuntimeConfig>, transport: Arc<dyn Transport>) {
    let interval_ms = cfg.auto_sync_interval_ms;
    tokio::spawn(async move {
        let mut force = false;
        loop {
            run_startup_sync(Arc::clone(&cfg), Arc::clone(&transport), force).await;
            if interval_ms == 0 {
                log_info("Periodic auto-sync is disabled; startup sync completed.");
                return;
            }
            log_info(&format!("Next auto-sync check in {}s.", interval_ms / 1000));
            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            force = true;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_parsing_matches_the_oracle() {
        assert_eq!(resolve_auto_sync_interval_ms(None), 3_600_000);
        assert_eq!(resolve_auto_sync_interval_ms(Some("3600")), 3_600_000);
        assert_eq!(resolve_auto_sync_interval_ms(Some(" 60 ")), 60_000);
        assert_eq!(resolve_auto_sync_interval_ms(Some("+604800")), 604_800_000);
        assert_eq!(resolve_auto_sync_interval_ms(Some("0")), 0);
        // Invalid spellings and out-of-range values fall back to the default.
        for raw in [
            "", "abc", "1.5", "1e3", "-5", "30", "604801", "0x10", "１０",
        ] {
            assert_eq!(resolve_auto_sync_interval_ms(Some(raw)), 3_600_000, "{raw}");
        }
        // Huge integers stay integers in JS and fall to the range check.
        assert_eq!(
            resolve_auto_sync_interval_ms(Some("999999999999999999999")),
            3_600_000
        );
    }

    #[test]
    fn pair_retry_rule_ignores_generation_mismatch() {
        assert!(gamedata_pair_needs_retry(
            SyncStatus::NoData,
            SyncStatus::UpToDate
        ));
        assert!(gamedata_pair_needs_retry(
            SyncStatus::UpToDate,
            SyncStatus::OfflineFallback
        ));
        assert!(!gamedata_pair_needs_retry(
            SyncStatus::UpToDate,
            SyncStatus::Updated
        ));
    }
}
