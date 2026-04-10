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
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
] as const;

/** Fixed volume mount-point inside Docker. */
const DOCKER_VOLUME_PATH = "/data/gamedata";

/** Bundled data baked into the image at build time. */
export const BUNDLED_GAMEDATA_PATH = "/app/data/gamedata";

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
  return REQUIRED_OPERATOR_FILES.every((f) => existsSync(join(excel, f)));
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
}

export function hasOperatorData(cfg: Config): boolean {
  return cfg.effectiveExcelPath !== null;
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

  return {
    gamedataPath,
    isCustomGamedata,
    excelPath: ep,
    bundledExcelPath: bep,
    effectiveExcelPath,
  };
}
