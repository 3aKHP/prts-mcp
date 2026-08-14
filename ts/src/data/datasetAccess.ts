/**
 * Dataset access contract: parameterized scaffold for gamedata domains.
 *
 * Every gamedata domain module used to hand-roll the same scaffold: module-
 * level `let` caches, a `checkActivationChange()` prologue per loader, a
 * CacheMetrics instance per cache, clear functions, stats exports and an
 * activation-listener registration. This contract parameterizes it:
 * `defineDataset(spec)` builds a named access object holding status-machine
 * cached loaders and registers it in a module-level registry that
 * `cacheStats` / consumers read instead of hand-enumerated module lists.
 *
 * The registry is keyed by dataset name and re-registration REPLACES the
 * previous entry, mirroring PY dict re-assignment — re-importing a module
 * (the test `?cacheBust=` pattern) re-registers cleanly instead of leaking
 * stale instances. `defineDataset` never auto-registers an activation
 * listener; each domain module keeps exactly one explicit
 * `registerActivationListener(clearXCaches)` call.
 *
 * Mirrors python/src/prts_mcp/data/dataset_access.py (1:1 symbol mapping:
 * defineDataset↔define_dataset, loader↔cached, …).
 */
import { checkActivationChange } from "../activation.js";
import { loadConfig } from "../config.js";
import { CacheMetrics } from "./cacheMetrics.js";
import { DirectoryStore } from "./stores.js";
import type { CacheStat } from "../cacheStats.js";

export type OnErrorMode = "throw" | "cacheFailure" | "null" | "empty";

export interface LoaderSpec<T = unknown> {
  /** Zero-arg; derived loaders call other cached accessors inside. */
  load: () => T;
  /** Overrides the default length-based count for stats(). */
  count?: (value: T) => number;
  /**
   * "throw" (default): exceptions propagate and the entry stays empty, so
   * the next call retries (the mid-process data-appearance behavior).
   * "cacheFailure": the first exception propagates but is remembered;
   * subsequent calls re-raise the same error until clear().
   * "null" / "empty": exceptions are swallowed and null/`{}` is cached as a
   * loaded value. Absence-as-null/empty is expressed by `load` itself
   * returning null/`{}` (a loaded value), not by these modes.
   */
  onError?: OnErrorMode;
}

export interface DatasetSpec {
  /** Registry key == /debug/cache module key. */
  name: string;
  /** Keys == getCacheStats() inner keys. */
  loaders: Record<string, LoaderSpec<unknown>>;
  store?: () => DirectoryStore;
  available?: () => boolean;
  missingMessage?: () => string;
  /** Post-clear hook (e.g. operator→clearSearchCaches rider). */
  onClear?: () => void;
}

export interface DatasetAccess {
  readonly name: string;
  /** Cached accessor: checkActivationChange + metrics + status-machine fill. */
  loader<T = unknown>(key: string): () => T;
  clear(): void;
  stats(): Record<string, CacheStat>;
  store(): DirectoryStore;
  available(): boolean;
  missingMessage(): string;
}

interface LoaderEntry {
  status: "empty" | "loaded" | "failed";
  value?: unknown;
  error?: unknown;
}

interface WiredLoader {
  spec: LoaderSpec<unknown>;
  entry: LoaderEntry;
  metrics: CacheMetrics;
}

function entryLoaded(entry: LoaderEntry): boolean {
  return entry.status === "loaded";
}

function countValue(spec: LoaderSpec<unknown>, entry: LoaderEntry): number {
  if (entry.status !== "loaded") return 0;
  const value = entry.value;
  if (spec.count) return spec.count(value);
  if (Array.isArray(value) || typeof value === "string") return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value as object).length;
  return 1;
}

function wireLoader(spec: LoaderSpec<unknown>): WiredLoader {
  return { spec, entry: { status: "empty" }, metrics: new CacheMetrics() };
}

function buildAccess(spec: DatasetSpec): DatasetAccess {
  const wired = new Map<string, WiredLoader>();
  for (const [key, loaderSpec] of Object.entries(spec.loaders)) {
    wired.set(key, wireLoader(loaderSpec));
  }

  return {
    name: spec.name,
    loader<T = unknown>(key: string): () => T {
      const slot = wired.get(key);
      if (slot === undefined) throw new Error(`dataset ${spec.name} has no loader ${key}`);
      return () => {
        checkActivationChange();
        slot.metrics.access(entryLoaded(slot.entry));
        if (slot.entry.status === "loaded") return slot.entry.value as T;
        if (slot.entry.status === "failed") throw slot.entry.error;
        try {
          const value = slot.spec.load();
          slot.entry = { status: "loaded", value };
          return value as T;
        } catch (err) {
          const mode = slot.spec.onError ?? "throw";
          if (mode === "cacheFailure") {
            slot.entry = { status: "failed", error: err };
          } else if (mode === "null") {
            slot.entry = { status: "loaded", value: null };
            return null as T;
          } else if (mode === "empty") {
            slot.entry = { status: "loaded", value: {} };
            return {} as T;
          }
          throw err;
        }
      };
    },
    clear(): void {
      for (const slot of wired.values()) {
        slot.metrics.clear();
        slot.entry = { status: "empty" };
      }
      spec.onClear?.();
    },
    stats(): Record<string, CacheStat> {
      const out: Record<string, CacheStat> = {};
      for (const [key, slot] of wired) {
        out[key] = slot.metrics.snapshot(
          entryLoaded(slot.entry),
          countValue(slot.spec, slot.entry),
        );
      }
      return out;
    },
    store(): DirectoryStore {
      if (spec.store === undefined) {
        throw new Error(`dataset ${spec.name} has no store factory`);
      }
      return spec.store();
    },
    available(): boolean {
      return spec.available?.() ?? true;
    },
    missingMessage(): string {
      return spec.missingMessage?.() ?? "";
    },
  };
}

const REGISTRY = new Map<string, DatasetAccess>();

/** Build a DatasetAccess and register it under spec.name (re-registration replaces). */
export function defineDataset(spec: DatasetSpec): DatasetAccess {
  const access = buildAccess(spec);
  REGISTRY.set(spec.name, access);
  return access;
}

/** Read-only view of the registered datasets. */
export function datasetRegistry(): ReadonlyMap<string, DatasetAccess> {
  return REGISTRY;
}

/** {datasetName: {loaderKey: CacheStat}} for /debug/cache aggregation. */
export function registryStats(): Record<string, Record<string, CacheStat>> {
  const out: Record<string, Record<string, CacheStat>> = {};
  for (const [name, access] of REGISTRY) out[name] = access.stats();
  return out;
}

/** Store rooted at the effective excel path (throws when unset). */
export function excelStore(): DirectoryStore {
  const ep = loadConfig().effectiveExcelPath;
  if (ep === null) throw new Error("effectiveExcelPath is null — GAMEDATA_PATH may be unset");
  return new DirectoryStore(ep);
}

/** Store rooted at `<levels>/zh_CN/gamedata/levels` (callers suffix). */
export function levelsStore(): DirectoryStore {
  const lp = loadConfig().effectiveLevelsPath;
  if (lp === null) throw new Error("effectiveLevelsPath is null — levels data may be unsynced");
  return new DirectoryStore(`${lp}/zh_CN/gamedata/levels`);
}
