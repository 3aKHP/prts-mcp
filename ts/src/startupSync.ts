/**
 * Startup data sync orchestration.
 *
 * Split from server.ts. Owns the retry/backoff scheduling, single-flight
 * locking, and the cache-clearing cascade triggered when sync writes new data.
 * Mirrors python/src/prts_mcp/startup_sync.py.
 */

import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  clearOperatorCaches,
} from "./data/operator.js";
import { clearEnemyCaches } from "./data/enemy.js";
import { clearStageCaches } from "./data/stage.js";
import { clearItemCaches } from "./data/item.js";
import { clearStageEnemyCaches } from "./data/stageEnemy.js";
import { clearSearchCaches } from "./data/search.js";
import { clearStoryCaches } from "./data/story.js";
import { syncRelease, syncReleaseArchive } from "./data/sync.js";
import { archiveSpecForDataset, releaseSpecForDataset, GAMEDATA_EXCEL, GAMEDATA_LEVELS, STORY_ZH_CN } from "./data/datasets.js";

// ---------------------------------------------------------------------------
// Logging helper (shared with server.ts)
// ---------------------------------------------------------------------------

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${level} prts_mcp.server: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Constants + single-flight state
// ---------------------------------------------------------------------------

const SYNC_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const AUTO_SYNC_DEFAULT_INTERVAL_SECONDS = 3600;
const AUTO_SYNC_MIN_INTERVAL_SECONDS = 60;
const AUTO_SYNC_MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
const syncInFlight = new Set<string>();
let autoSyncStarted = false;
type SyncRunResult = "retry" | "done" | "skipped";

function shouldRetrySync(status: string): boolean {
  return status === "offline_fallback" || status === "no_data";
}

async function singleFlightSync(label: string, runSync: () => Promise<boolean>): Promise<SyncRunResult> {
  if (syncInFlight.has(label)) {
    log("INFO", `${label} sync is already running; skipping overlapping attempt.`);
    return "skipped";
  }
  syncInFlight.add(label);
  try {
    return await runSync() ? "retry" : "done";
  } finally {
    syncInFlight.delete(label);
  }
}

function scheduleSyncRetry(
  label: string,
  runSync: () => Promise<boolean>,
  attempt = 0,
): void {
  const delayMs = SYNC_RETRY_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    log("WARN", `${label} sync still needs retry after ${SYNC_RETRY_DELAYS_MS.length} attempts; waiting for the next periodic cycle or process start.`);
    return;
  }

  const timer = setTimeout(() => {
    void singleFlightSync(label, runSync)
      .then((result) => {
        if (result === "skipped") scheduleSyncRetry(label, runSync, attempt);
        else if (result === "retry") scheduleSyncRetry(label, runSync, attempt + 1);
      })
      .catch((err: unknown) => {
        log("ERROR", `${label} retry sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        scheduleSyncRetry(label, runSync, attempt + 1);
      });
  }, delayMs);
  timer.unref();

  log("INFO", `${label} sync will retry in ${Math.round(delayMs / 1000)}s.`);
}

// ---------------------------------------------------------------------------
// Startup sync entry point
// ---------------------------------------------------------------------------

export async function runStartupSync(forceCheck = false): Promise<void> {
  const cfg = loadConfig();
  const startupTasks: Promise<void>[] = [];

  // Gamedata sync
  if (cfg.isCustomGamedata) {
    log("INFO", `GAMEDATA_PATH is custom (${cfg.gamedataPath}); auto-sync disabled.`);
  } else {
    const archiveSpec = archiveSpecForDataset(
      GAMEDATA_EXCEL,
      join(cfg.gamedataPath, "archives", "zh_CN-excel.zip"),
      cfg.gamedataPath,
    );

    const runGamedataSync = async (): Promise<boolean> => {
      const r = await syncReleaseArchive(archiveSpec, forceCheck);
      const sha = r.commitSha ? r.commitSha.slice(0, 8) : "unknown";
      if (r.status === "updated") {
        clearOperatorCaches();
        clearEnemyCaches();
        clearStageCaches();
        clearItemCaches();
        clearStageEnemyCaches();
        clearSearchCaches();
        log("INFO", `Data updated from GitHub Release (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "up_to_date") {
        log("INFO", `Data is up to date (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "offline_fallback") {
        log("WARN", `Network unavailable; using cached data (${r.spec.repo} @ ${sha}). Error: ${r.error}`);
      } else {
        log("ERROR", `Sync failed for ${r.spec.repo} — no data. Error: ${r.error}`);
      }
      return shouldRetrySync(r.status);
    };

    startupTasks.push(
      singleFlightSync("Gamedata", runGamedataSync)
        .catch((err: unknown) => {
          log("ERROR", `Startup sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        })
        .then((result) => {
          if (result !== "done" && !forceCheck) {
            scheduleSyncRetry("Gamedata", runGamedataSync);
          }
        }),
    );

    const levelsSpec = archiveSpecForDataset(
      GAMEDATA_LEVELS,
      join(cfg.levelsPath, "archives", "zh_CN-levels.zip"),
      cfg.levelsPath,
    );

    const runLevelsSync = async (): Promise<boolean> => {
      const r = await syncReleaseArchive(levelsSpec, forceCheck);
      const sha = r.commitSha ? r.commitSha.slice(0, 8) : "unknown";
      if (r.status === "updated") {
        clearEnemyCaches();
        clearStageEnemyCaches();
        log("INFO", `Level data updated from GitHub Release (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "up_to_date") {
        log("INFO", `Level data is up to date (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "offline_fallback") {
        log("WARN", `Network unavailable; using cached level data (${r.spec.repo} @ ${sha}). Error: ${r.error}`);
      } else {
        log("ERROR", `Level data sync failed for ${r.spec.repo} — no data. Error: ${r.error}`);
      }
      return shouldRetrySync(r.status);
    };

    startupTasks.push(
      singleFlightSync("Gamedata levels", runLevelsSync)
        .catch((err: unknown) => {
          log("ERROR", `Level data sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        })
        .then((result) => {
          if (result !== "done" && !forceCheck) {
            scheduleSyncRetry("Gamedata levels", runLevelsSync);
          }
        }),
    );
  }

  // Storyjson release sync (always attempt unless user supplied STORYJSON_PATH)
  if (!process.env["STORYJSON_PATH"]) {
    const releaseSpec = releaseSpecForDataset(STORY_ZH_CN, cfg.storyjsonZip);

    const runStorySync = async (): Promise<boolean> => {
      const r = await syncRelease(releaseSpec, forceCheck);
      const sha = r.commitSha ? r.commitSha.slice(0, 8) : "unknown";
      if (r.status === "updated") {
        clearStoryCaches();
        log("INFO", `Storyjson updated from GitHub Release (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "up_to_date") {
        log("INFO", `Storyjson is up to date (${r.spec.repo} @ ${sha}).`);
      } else if (r.status === "offline_fallback") {
        log("WARN", `Network unavailable; using cached storyjson (${r.spec.repo} @ ${sha}). Error: ${r.error}`);
      } else {
        log("ERROR", `Storyjson sync failed for ${r.spec.repo} — no zip. Error: ${r.error}`);
      }
      return shouldRetrySync(r.status);
    };

    startupTasks.push(
      singleFlightSync("Storyjson", runStorySync)
        .catch((err: unknown) => {
          log("ERROR", `Storyjson sync threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        })
        .then((result) => {
          if (result !== "done" && !forceCheck) {
            scheduleSyncRetry("Storyjson", runStorySync);
          }
        }),
    );
  } else {
    log("INFO", `STORYJSON_PATH is set (${process.env["STORYJSON_PATH"]}); story auto-sync disabled.`);
  }

  await Promise.all(startupTasks);
}

export function resolveAutoSyncIntervalMs(
  raw = process.env["PRTS_AUTO_SYNC_INTERVAL_SECONDS"],
): number {
  if (raw === undefined) return AUTO_SYNC_DEFAULT_INTERVAL_SECONDS * 1000;
  const normalized = raw.trim();
  const interval = /^[+-]?\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (interval === 0) return 0;
  if (
    !Number.isInteger(interval)
    || interval < AUTO_SYNC_MIN_INTERVAL_SECONDS
    || interval > AUTO_SYNC_MAX_INTERVAL_SECONDS
  ) {
    log(
      "WARN",
      "Invalid PRTS_AUTO_SYNC_INTERVAL_SECONDS="
        + JSON.stringify(raw)
        + "; using "
        + AUTO_SYNC_DEFAULT_INTERVAL_SECONDS
        + "s.",
    );
    return AUTO_SYNC_DEFAULT_INTERVAL_SECONDS * 1000;
  }
  return interval * 1000;
}

interface AutoSyncTimer {
  unref?: () => void;
}

type AutoSyncSchedule = (
  callback: () => void,
  delayMs: number,
) => AutoSyncTimer;

export function runAutoSyncLoop(
  runSync: (forceCheck: boolean) => Promise<void> = runStartupSync,
  intervalMs = resolveAutoSyncIntervalMs(),
  schedule: AutoSyncSchedule = (callback, delayMs) =>
    setTimeout(callback, delayMs),
): void {
  let forceCheck = false;

  const runCycle = (): void => {
    void Promise.resolve()
      .then(() => runSync(forceCheck))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", "Auto-sync cycle threw unexpectedly: " + message);
      })
      .finally(() => {
        if (intervalMs === 0) {
          log("INFO", "Periodic auto-sync is disabled; startup sync completed.");
          return;
        }
        log(
          "INFO",
          "Next auto-sync check in " + Math.round(intervalMs / 1000) + "s.",
        );
        const timer = schedule(() => {
          forceCheck = true;
          runCycle();
        }, intervalMs);
        timer.unref?.();
      });
  };

  runCycle();
}

export function startAutoSync(): void {
  if (autoSyncStarted) {
    log("INFO", "Auto-sync is already running; skipping duplicate start.");
    return;
  }
  autoSyncStarted = true;
  runAutoSyncLoop();
}
