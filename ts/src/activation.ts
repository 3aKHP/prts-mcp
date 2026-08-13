/**
 * GameData generation activation (TypeScript).
 *
 * Mirrors python/src/prts_mcp/activation.py: detect when the auto-synced
 * generation pointer changes and pin one stable generation for a complete
 * synchronous tool call. Extracted from config.ts — STYLE.md requires the
 * state+update+query trinity be its own unit, not a hidden singleton in config.
 *
 * config.ts and activation.ts reference each other only inside function bodies,
 * so the ESM mutual top-level import is cycle-safe. loadConfig is synchronous
 * (cannot `await import()`), which rules out a Python-style late import here.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

// CYCLE INVARIANT: config.ts <-> activation.ts import each other. Forced --
// loadConfig is synchronous and cannot `await import()`, so Python's late-import
// DAG is unavailable here. Safe ONLY because each module reads the other
// exclusively inside function bodies (never at module top-level). Do NOT add a
// top-level use of the other module's exports here -- that is a TDZ hazard.
import {
  DEFAULT_GAMEDATA_PATH,
  gamedataPairPath,
  loadConfig,
  resolveLevelsPath,
  type Config,
} from "./config.js";

const activationListeners = new Set<() => void>();
let activationSignature: string | null = null;
let activationSnapshot: { config: Config; signature: string } | null = null;

/** Register a cache invalidator for activated GameData generation changes. */
export function registerActivationListener(listener: () => void): void {
  activationListeners.add(listener);
}

function activationMetaToken(root: string): readonly unknown[] {
  return activationPathToken(join(root, "archives", "extract_meta.json"));
}

function activationPathToken(path: string): readonly unknown[] {
  try {
    const info = statSync(path);
    return [path, info.ino, info.size, info.mtimeMs, info.ctimeMs];
  } catch {
    return [path, null];
  }
}

/** Invalidate GameData caches when either activation pointer is replaced. */
export function checkActivationChange(): void {
  if (activationSnapshot !== null) return;
  const isCustom = "GAMEDATA_PATH" in process.env;
  const gamedata = isCustom
    ? process.env["GAMEDATA_PATH"]!
    : DEFAULT_GAMEDATA_PATH;
  const levels = resolveLevelsPath(gamedata);
  const signature = JSON.stringify([
    ...activationPathToken(gamedataPairPath(gamedata, levels)),
    ...activationMetaToken(gamedata),
    ...activationMetaToken(levels),
  ]);
  const previous = activationSignature;
  activationSignature = signature;
  if (previous === null || previous === signature) return;
  for (const listener of activationListeners) {
    try {
      listener();
    } catch (err) {
      console.error("Failed to invalidate a GameData cache", err);
    }
  }
}

/** Return the config pinned by the active activation snapshot, or null. */
export function peekPinnedConfig(): Config | null {
  return activationSnapshot?.config ?? null;
}

/** Keep one activated generation stable for a complete synchronous tool call. */
export function withActivationSnapshot<T>(run: () => T): T {
  if (activationSnapshot !== null) return run();
  let config: Config;
  let signature: string;
  for (;;) {
    checkActivationChange();
    signature = activationSignature ?? "";
    config = loadConfig();
    checkActivationChange();
    if (signature === (activationSignature ?? "")) break;
  }
  const snapshot = { config, signature };
  activationSnapshot = snapshot;
  try {
    return run();
  } finally {
    if (activationSnapshot === snapshot) activationSnapshot = null;
  }
}

/**
 * Test-only: reset activation state so each test starts from a clean baseline.
 * The leading underscores signal "not for production". Required because TS
 * tests cannot patch module privates, and once activation lives in its own
 * module the config cacheBust trick (`import("config.ts?q")`) no longer
 * isolates activation state.
 */
export function __resetActivationForTesting(): void {
  activationListeners.clear();
  activationSignature = null;
  activationSnapshot = null;
}
