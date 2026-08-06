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
 *
 *   effectiveLevelsPath — priority:
 *     1. Runtime sync path beside gamedata (or /data/gamedata-levels in Docker).
 *     2. Bundled fallback beside package data.
 *     3. null — no level combat data available.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PRTS_API_ENDPOINT = "https://prts.wiki/api.php";
export const USER_AGENT = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)";
/** Minimum seconds between PRTS API requests. */
export const RATE_LIMIT_INTERVAL = 1.5;

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

/** Fixed levels volume path inside Docker. */
const DOCKER_LEVELS_PATH = "/data/gamedata-levels";

/** Bundled levels fallback baked into the package at publish/build time. */
export const BUNDLED_LEVELS_PATH = join(_PACKAGE_ROOT, "data", "gamedata-levels");

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

/** Image artwork assets (2.5.0) sit alongside gamedata under the data root. */
export const DEFAULT_IMAGES_PATH = join(dirname(DEFAULT_GAMEDATA_PATH), "images");

function envBool(name: string, defaultVal: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultVal;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function excelPath(gamedataRoot: string): string {
  return join(gamedataRoot, "zh_CN", "gamedata", "excel");
}

function activatedRoot(root: string): string {
  try {
    const value = JSON.parse(
      readFileSync(join(root, "archives", "extract_meta.json"), "utf-8"),
    ) as { data_root?: unknown };
    if (typeof value.data_root !== "string" || value.data_root.length === 0) return root;
    const base = realpathSync(root);
    const activated = realpathSync(resolve(root, value.data_root));
    const rel = relative(base, activated);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return root;
    return existsSync(activated) && statSync(activated).isDirectory() ? activated : root;
  } catch {
    return root;
  }
}

function gamedataPairPath(gamedataRoot: string, levelsRoot: string): string {
  const gamedataParent = dirname(resolve(gamedataRoot));
  const levelsParent = dirname(resolve(levelsRoot));
  if (gamedataParent !== levelsParent) {
    return join(gamedataParent, ".gamedata_pair.invalid");
  }
  return join(gamedataParent, ".gamedata_pair.json");
}

function activatedPair(
  gamedataRoot: string,
  levelsRoot: string,
): readonly [string, string] | null {
  try {
    const value = JSON.parse(
      readFileSync(gamedataPairPath(gamedataRoot, levelsRoot), "utf-8"),
    ) as {
      commit_sha?: unknown;
      excel_data_root?: unknown;
      levels_data_root?: unknown;
    };
    if (typeof value.commit_sha !== "string" || value.commit_sha.length === 0) return null;
    if (typeof value.excel_data_root !== "string" || value.excel_data_root.length === 0) return null;
    if (typeof value.levels_data_root !== "string" || value.levels_data_root.length === 0) return null;
    const excelBase = realpathSync(gamedataRoot);
    const levelsBase = realpathSync(levelsRoot);
    const activeExcelRoot = realpathSync(resolve(excelBase, value.excel_data_root));
    const activeLevelsRoot = realpathSync(resolve(levelsBase, value.levels_data_root));
    const excelRel = relative(excelBase, activeExcelRoot);
    const levelsRel = relative(levelsBase, activeLevelsRoot);
    if (excelRel === ".." || excelRel.startsWith(`..${sep}`) || isAbsolute(excelRel)) return null;
    if (levelsRel === ".." || levelsRel.startsWith(`..${sep}`) || isAbsolute(levelsRel)) return null;
    if (!statSync(activeExcelRoot).isDirectory()) return null;
    if (!statSync(activeLevelsRoot).isDirectory()) return null;
    return [activeExcelRoot, activeLevelsRoot];
  } catch {
    return null;
  }
}

function levelsPath(gamedataRoot: string): string {
  return join(dirname(gamedataRoot), "gamedata-levels");
}

function resolveLevelsPath(gamedataRoot: string): string {
  if ("GAMEDATA_PATH" in process.env && levelsComplete(gamedataRoot)) {
    return gamedataRoot;
  }
  if ("GAMEDATA_PATH" in process.env) return levelsPath(gamedataRoot);
  if (process.env["PRTS_MCP_ROOT"] === "/app") return DOCKER_LEVELS_PATH;
  return levelsPath(gamedataRoot);
}

function filesComplete(excel: string): boolean {
  return REQUIRED_OPERATOR_FILES.every((f) => {
    const p = join(excel, f);
    return existsSync(p) && statSync(p).isFile();
  });
}

function levelsComplete(root: string): boolean {
  const p = join(root, "zh_CN", "gamedata", "levels", "enemydata", "enemy_database.json");
  return existsSync(p) && statSync(p).isFile();
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
  /** Sync write target for zh_CN-levels.zip extraction. */
  levelsPath: string;
  /** Bundled excel path (read-only fallback, only exists inside Docker). */
  bundledExcelPath: string;
  /** Bundled level data path (read-only fallback). */
  bundledLevelsPath: string;
  /**
   * The path operator.ts should actually read from.
   * Prefers the sync path when complete; falls back to bundled data; null
   * when neither location has data.
   */
  effectiveExcelPath: string | null;
  /** The path level/stage-enemy readers should read from. */
  effectiveLevelsPath: string | null;
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
  /** IMAGES_ENABLED — master switch; false → operator_artwork not registered. */
  imagesEnabled: boolean;
  /** LOCAL_IMAGE — true = AKDP local assets, false = MediaWiki fallback (future). */
  localImage: boolean;
  /** ORIGINAL_IMAGE — true = also sync original-variant shards. */
  originalImage: boolean;
  /** Image asset sync target (PRTS_IMAGE_DIR or default). */
  imagesPath: string;
}

export function hasOperatorData(cfg: Config): boolean {
  return cfg.effectiveExcelPath !== null;
}

export function hasStoryData(cfg: Config): boolean {
  return cfg.effectiveStoryjsonZip !== null;
}

export function hasLevelsData(cfg: Config): boolean {
  return cfg.effectiveLevelsPath !== null;
}

export function loadConfig(): Config {
  if (activationSnapshot !== null) return activationSnapshot.config;
  checkActivationChange();
  const isCustomGamedata = "GAMEDATA_PATH" in process.env;
  const gamedataPath = isCustomGamedata
    ? process.env["GAMEDATA_PATH"]!
    : DEFAULT_GAMEDATA_PATH;

  const ep = excelPath(gamedataPath);
  const lp = resolveLevelsPath(gamedataPath);
  const pair = activatedPair(gamedataPath, lp);
  const activeEp = excelPath(pair?.[0] ?? activatedRoot(gamedataPath));
  const bundledPair = activatedPair(BUNDLED_GAMEDATA_PATH, BUNDLED_LEVELS_PATH);
  const bundledGamedataRoot = bundledPair?.[0] ?? activatedRoot(BUNDLED_GAMEDATA_PATH);
  const bep = excelPath(bundledGamedataRoot);
  const blp = bundledPair?.[1] ?? activatedRoot(BUNDLED_LEVELS_PATH);

  let effectiveExcelPath: string | null = null;
  if (filesComplete(activeEp)) effectiveExcelPath = activeEp;
  else if (filesComplete(bep)) effectiveExcelPath = bep;

  let effectiveLevelsPath: string | null = null;
  const activeLp = pair?.[1] ?? activatedRoot(lp);
  if (levelsComplete(activeLp)) effectiveLevelsPath = activeLp;
  else if (levelsComplete(blp)) effectiveLevelsPath = blp;

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

  const imagesPath = process.env["PRTS_IMAGE_DIR"] ?? DEFAULT_IMAGES_PATH;
  const config = {
    gamedataPath,
    isCustomGamedata,
    excelPath: ep,
    levelsPath: lp,
    bundledExcelPath: bep,
    bundledLevelsPath: blp,
    effectiveExcelPath,
    effectiveLevelsPath,
    storyjsonZip,
    effectiveStoryjsonZip,
    imagesEnabled: envBool("IMAGES_ENABLED", false),
    localImage: envBool("LOCAL_IMAGE", true),
    originalImage: envBool("ORIGINAL_IMAGE", false),
    imagesPath,
  };
  return config;
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
