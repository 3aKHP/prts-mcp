/**
 * Runtime configuration for PRTS-MCP (TypeScript).
 *
 * Path design mirrors python/src/prts_mcp/config.py:
 *
 *   DEFAULT_GAMEDATA_PATH — where auto-sync writes data at runtime.
 *     Priority (highest → lowest):
 *     1. GAMEDATA_PATH env var  — user-supplied; auto-sync is DISABLED.
 *     2. /data/gamedata         — fixed volume mount-point inside Docker
 *                                 (detected via PRTS_MCP_ROOT == "/app").
 *     3. Per-user data dir      — ~/.local/share/prts-mcp/ (Linux/macOS)
 *                                 or %LOCALAPPDATA%\prts-mcp\ (Windows).
 *
 *   BUNDLED_GAMEDATA_PATH — read-only fallback baked into the Docker image.
 *     Always /app/data/gamedata inside the container.
 *
 *   effective_storyjson_zip — priority:
 *     1. STORYJSON_PATH env var — user-supplied zip path.
 *     2. /data/storyjson/zh_CN.zip — Docker volume mount-point.
 *     3. /app/data/storyjson/zh_CN.zip — bundled zip (only inside Docker).
 *     4. null — no story data available.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PRTS_API_ENDPOINT = "https://prts.wiki/api.php";
export const USER_AGENT = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)";
/** Minimum seconds between PRTS API requests. */
export const RATE_LIMIT_INTERVAL = 1.5;

const REQUIRED_OPERATOR_FILES = [
  "character_table.json",
  "handbook_info_table.json",
  "charword_table.json",
  "story_review_table.json",
] as const;

/** Fixed volume mount-point inside Docker. */
const DOCKER_VOLUME_PATH = "/data/gamedata";

/**
 * Bundled data directory baked into the package at publish/build time.
 * Resolved relative to this file so it works for both:
 *   - npm global install: <package_root>/dist/config.js → <package_root>/data/gamedata
 *   - Docker:             /app/dist/config.js           → /app/data/gamedata
 */
const _PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const BUNDLED_GAMEDATA_PATH = join(_PACKAGE_ROOT, "data", "gamedata");

/** Fixed storyjson volume mount-point inside Docker. */
const DOCKER_STORYJSON_ZIP = "/data/storyjson/zh_CN.zip";

/** Bundled storyjson zip baked into the package at publish/build time. */
const BUNDLED_STORYJSON_ZIP = join(_PACKAGE_ROOT, "data", "storyjson", "zh_CN.zip");

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveDefaultGamedataPath(): string {
  // Inside Docker (PRTS_MCP_ROOT == "/app") use the fixed volume path.
  if (process.env["PRTS_MCP_ROOT"] === "/app") return DOCKER_VOLUME_PATH;

  // Outside Docker: per-user data directory.
  if (process.platform === "win32") {
    const base =
      process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(base, "prts-mcp", "gamedata");
  }
  const base =
    process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
  return join(base, "prts-mcp", "gamedata");
}

export const DEFAULT_GAMEDATA_PATH = resolveDefaultGamedataPath();

function excelPath(gamedataRoot: string): string {
  return join(gamedataRoot, "zh_CN", "gamedata", "excel");
}

function filesComplete(excel: string): boolean {
  return REQUIRED_OPERATOR_FILES.every((f) => {
    const p = join(excel, f);
    return existsSync(p) && statSync(p).isFile();
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Config {
  /** Sync write target (volume or user dir). */
  gamedataPath: string;
  /** True when GAMEDATA_PATH was explicitly set by the user. */
  isCustomGamedata: boolean;
  /** Primary excel path (under gamedataPath). */
  excelPath: string;
  /** Bundled excel path (read-only fallback, only exists inside Docker). */
  bundledExcelPath: string;
  /**
   * The path operator.ts should actually read from.
   * Prefers the sync path when complete; falls back to bundled data; null
   * when neither location has data.
   */
  effectiveExcelPath: string | null;
  /**
   * Configured storyjson zip path (STORYJSON_PATH env var or default).
   * This is the sync write target, not necessarily the file that exists.
   */
  storyjsonZip: string;
  /**
   * The storyjson zip story.ts should actually read from.
   * Null when no zip is found anywhere.
   */
  effectiveStoryjsonZip: string | null;
}

export function hasOperatorData(cfg: Config): boolean {
  return cfg.effectiveExcelPath !== null;
}

export function hasStoryData(cfg: Config): boolean {
  return cfg.effectiveStoryjsonZip !== null;
}

export function loadConfig(): Config {
  const isCustomGamedata = "GAMEDATA_PATH" in process.env;
  const gamedataPath = isCustomGamedata
    ? process.env["GAMEDATA_PATH"]!
    : DEFAULT_GAMEDATA_PATH;

  const ep = excelPath(gamedataPath);
  const bep = excelPath(BUNDLED_GAMEDATA_PATH);

  let effectiveExcelPath: string | null = null;
  if (filesComplete(ep)) effectiveExcelPath = ep;
  else if (filesComplete(bep)) effectiveExcelPath = bep;

  // storyjson zip: default is alongside gamedata in the user data dir.
  const defaultStoryjsonZip = join(
    dirname(gamedataPath),
    "storyjson",
    "zh_CN.zip"
  );
  const storyjsonZip =
    process.env["STORYJSON_PATH"] ?? defaultStoryjsonZip;

  let effectiveStoryjsonZip: string | null = null;
  if (existsSync(storyjsonZip)) effectiveStoryjsonZip = storyjsonZip;
  else if (existsSync(DOCKER_STORYJSON_ZIP))
    effectiveStoryjsonZip = DOCKER_STORYJSON_ZIP;
  else if (existsSync(BUNDLED_STORYJSON_ZIP))
    effectiveStoryjsonZip = BUNDLED_STORYJSON_ZIP;

  return {
    gamedataPath,
    isCustomGamedata,
    excelPath: ep,
    bundledExcelPath: bep,
    effectiveExcelPath,
    storyjsonZip,
    effectiveStoryjsonZip,
  };
}
