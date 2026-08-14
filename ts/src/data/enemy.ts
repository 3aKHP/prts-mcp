/**
 * Enemy handbook + database reader.
 * Reads enemy_handbook_table.json and enemy_database.json from local game data.
 * Mirrors python/src/prts_mcp/data/enemy.py.
 */

import { registerActivationListener } from "../activation.js";
import { loadConfig } from "../config.js";
import type { CacheStat } from "../cacheStats.js";
import { level0Index, normalizeEnemyDatabase } from "./enemyDatabase.js";
import { defineDataset, excelStore, levelsStore, type DatasetAccess } from "./datasetAccess.js";
import {
  extractEnemyStats,
  type EnemyDbEntry,
  type EnemyStatsPayload,
} from "./enemyStats.js";
import { renderHandbookCard, renderStatsBlock } from "./enemyRender.js";

export type { EnemyStatsPayload } from "./enemyStats.js";
import {
  excelMissingMessage,
  regexErrorMessage,
  validateBounds,
} from "./messages.js";

// ---------------------------------------------------------------------------
// Module-level caches (dataset access contract)
// ---------------------------------------------------------------------------

const HANDBOOK_FILE = "enemy_handbook_table.json";
const DATABASE_FILE = "enemydata/enemy_database.json";

export function clearEnemyCaches(): void {
  enemyAccess.clear();
}

export function getCacheStats(): Record<string, CacheStat> {
  return enemyAccess.stats();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnemyHandbookEntry {
  enemyId?: string;
  enemyIndex?: string;
  enemyTags?: string[] | null;
  sortId?: number;
  name?: string;
  enemyLevel?: string;
  description?: string;
  attackType?: string | null;
  ability?: string | null;
  hideInHandbook?: boolean;
  damageType?: string[];
}

interface EnemyHandbook {
  enemyData?: Record<string, EnemyHandbookEntry>;
  raceData?: Record<string, { id?: string; raceName?: string }>;
}

// Database file has { enemies: [{ Key, Value: [{ level, enemyData }] }] }
interface EnemyDbRow {
  Key?: string;
  Value?: Array<{ level?: number; enemyData?: EnemyDbEntry }>;
}

interface EnemyDatabase {
  enemies?: EnemyDbRow[];
}

interface EnemySearchRecord {
  enemyId: string;
  info: EnemyHandbookEntry;
  searchText: string;
}

export interface EnemiesListingPayload {
  total: number;
  offset: number;
  limit: number;
  full: boolean;
  filters: {
    threat_level: string | null;
    threat_level_filter: string | null;
  };
  enemies: Array<{
    enemy_id: string;
    name: string;
    enemy_index: string;
    level_raw: string;
    level_label: string;
    description_excerpt: string;
  }>;
  empty_reason?: "offset_out_of_range";
}

export interface EnemyInfoPayload {
  name: string;
  enemy_id: string;
  enemy_index: string;
  level_raw: string;
  level_label: string;
  description: string;
  attack_type: string;
  ability: string;
  damage_types_raw: string[];
  damage_types_label: string;
  enemy_tags: string[];
  stats: EnemyStatsPayload | null;
}

export interface EnemySearchPayload {
  scope: "enemies";
  pattern: string;
  total: number;
  results: Array<{
    enemy_id: string;
    name: string;
    enemy_index: string;
    level_raw: string;
    level_label: string;
    description: string;
    attack_type: string;
    ability: string;
    damage_types_raw: string[];
    damage_types_label: string;
    enemy_tags: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function missingDataMessage(): string {
  return enemyAccess.missingMessage();
}

function hasEnemyData(): boolean {
  const cfg = loadConfig();
  if (cfg.effectiveExcelPath === null) return false;
  return excelStore().exists(HANDBOOK_FILE);
}

function hasDatabase(): boolean {
  const cfg = loadConfig();
  if (cfg.effectiveLevelsPath === null) return false;
  return levelsStore().exists(DATABASE_FILE);
}

function getHandbookImpl(): EnemyHandbook {
  const store = excelStore();
  if (!store.exists(HANDBOOK_FILE)) {
    throw new Error(
      `敌人图鉴数据文件不存在：${store.resolveForDiagnostics(HANDBOOK_FILE)}。`
    );
  }
  return store.readJson<EnemyHandbook>(HANDBOOK_FILE);
}

function getDbLevelsImpl(): Record<string, Record<number, EnemyDbEntry>> {
  // Raw normalized levels map ({} if absent); the level-0 projection
  // (level0Index) is applied at use sites — stageEnemy consumes the raw map.
  if (!hasDatabase()) return {};
  const store = levelsStore();
  return normalizeEnemyDatabase<EnemyDbEntry>(store.readJson(DATABASE_FILE));
}

function buildNameToEnemyIdImpl(): Map<string, string> {
  const raw = getHandbook();
  const ed = raw.enemyData ?? {};
  return new Map(
    Object.entries(ed)
      .filter(([, info]) => info.name)
      .map(([eid, info]) => [info.name!, eid])
  );
}

function getEnemySearchRecordsImpl(): EnemySearchRecord[] {
  const ed = getHandbook().enemyData ?? {};
  return Object.entries(ed)
    .filter(([, info]) => !info.hideInHandbook)
    .map(([enemyId, info]) => ({
      enemyId,
      info,
      searchText: [
        info.name ?? "",
        info.description ?? "",
        info.ability ?? "",
        ...(Array.isArray(info.enemyTags) ? info.enemyTags : []),
      ].join(" "),
    }));
}

const enemyAccess: DatasetAccess = defineDataset({
  name: "enemy",
  loaders: {
    enemy_handbook: {
      load: getHandbookImpl,
      count: (r) => Object.keys((r as EnemyHandbook).enemyData ?? {}).length,
    },
    enemy_database: { load: getDbLevelsImpl },
    enemy_name_to_id: {
      load: buildNameToEnemyIdImpl,
      count: (m) => (m as Map<string, string>).size,
    },
    enemy_search_records: { load: getEnemySearchRecordsImpl },
  },
  store: excelStore,
  available: hasEnemyData,
  missingMessage: excelMissingMessage("敌人图鉴"),
});

export const getHandbook = enemyAccess.loader<EnemyHandbook>("enemy_handbook");
export const getDbLevels = enemyAccess.loader<Record<string, Record<number, EnemyDbEntry>>>("enemy_database");
export const buildNameToEnemyId = enemyAccess.loader<Map<string, string>>("enemy_name_to_id");
const getEnemySearchRecords = enemyAccess.loader<EnemySearchRecord[]>("enemy_search_records");

registerActivationListener(clearEnemyCaches);

function resolveEnemyId(name: string): string | null {
  return buildNameToEnemyId().get(name) ?? null;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

const ENEMY_LEVEL_ZH: Record<string, string> = {
  BOSS: "领袖",
  ELITE: "精英",
  NORMAL: "普通",
};

const DAMAGE_TYPE_ZH: Record<string, string> = {
  PHYSIC: "物理",
  MAGIC: "法术",
  HEAL: "治疗",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listEnemies(
  threatLevel?: string | null,
  limit = 50,
  offset = 0,
  full = false,
): string {
  const data = buildEnemiesListing(threatLevel, limit, offset, full);
  if (typeof data === "string") return data;
  return renderEnemiesListing(data);
}

export function buildEnemiesListing(
  threatLevel?: string | null,
  limit = 50,
  offset = 0,
  full = false,
): EnemiesListingPayload | string {
  if (!hasEnemyData()) return missingDataMessage();

  const boundsError = validateBounds("limit", limit, { minimum: 1, maximum: 200 })
    ?? validateBounds("offset", offset, { minimum: 0 });
  if (boundsError !== null) return boundsError;

  let raw: EnemyHandbook;
  try { raw = getHandbook(); } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const ed = raw.enemyData ?? {};
  let entries = Object.entries(ed).filter(
    ([, info]) => !info.hideInHandbook && info.name
  );

  if (threatLevel) {
    const filter = threatLevel.toUpperCase();
    if (!ENEMY_LEVEL_ZH[filter]) {
      return `无效的 threat_level 参数：${JSON.stringify(threatLevel)}，可选值：boss、elite、normal。`;
    }
    entries = entries.filter(([, i]) => (i.enemyLevel ?? "").toUpperCase() === filter);
  }

  entries.sort((a, b) => {
    const sa = a[1].sortId ?? 9999;
    const sb = b[1].sortId ?? 9999;
    return sa !== sb ? sa - sb : a[0].localeCompare(b[0]);
  });

  const total = entries.length;
  const filters = { threat_level: threatLevel ?? null, threat_level_filter: threatLevel ? threatLevel.toUpperCase() : null };

  if (!full && offset >= total && total > 0) {
    return {
      total,
      offset,
      limit,
      full,
      filters,
      enemies: [],
      empty_reason: "offset_out_of_range",
    };
  }

  const displayed = full ? entries : entries.slice(offset, offset + limit);

  const enemies = displayed.map(([enemyId, info]) => {
    const levelRaw = info.enemyLevel ?? "";
    const desc = (info.description ?? "").replace(/\n/g, " ").slice(0, 60);
    return {
      enemy_id: enemyId,
      name: info.name ?? "",
      enemy_index: info.enemyIndex ?? "",
      level_raw: levelRaw,
      level_label: ENEMY_LEVEL_ZH[levelRaw] ?? levelRaw,
      description_excerpt: desc,
    };
  });

  return {
    total,
    offset,
    limit,
    full,
    filters,
    enemies,
  };
}

export function renderEnemiesListing(data: EnemiesListingPayload): string {
  if (data.empty_reason === "offset_out_of_range") {
    return `# 敌人图鉴（共 ${data.total} 个）\n\noffset=${data.offset} 超出范围（总计 ${data.total} 条）。`;
  }

  const { total, offset, limit, full } = data;
  let out = `# 敌人图鉴（共 ${total} 个）\n`;
  for (const enemy of data.enemies) {
    let line = `- **${enemy.name}** [${enemy.level_label}] (${enemy.enemy_index})`;
    if (enemy.description_excerpt) line += ` — ${enemy.description_excerpt}`;
    out += line + "\n";
  }

  if (!full && total > offset + limit) {
    out += `\n（显示第 ${offset + 1}–${Math.min(offset + limit, total)} 条，共 ${total} 条。使用 offset=${offset + limit} 查看下一页）`;
  }

  return out.trim();
}

export function getEnemyInfo(name: string): string {
  const data = buildEnemyInfo(name);
  if (typeof data === "string") return data;
  return renderEnemyInfo(data);
}

export function buildEnemyInfo(name: string): EnemyInfoPayload | string {
  if (!hasEnemyData()) return missingDataMessage();

  let eid: string | null;
  try { eid = resolveEnemyId(name); } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (eid === null) return `未找到敌人 '${name}'。请使用游戏内名称。`;

  let raw: EnemyHandbook;
  try { raw = getHandbook(); } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const info = raw.enemyData?.[eid];
  if (!info) return `敌人 '${name}' 暂无详细信息。`;

  const levelRaw = info.enemyLevel ?? "";
  const damageTypesRaw = Array.isArray(info.damageType) ? info.damageType : [];
  const payload: EnemyInfoPayload = {
    name: info.name ?? "",
    enemy_id: info.enemyId ?? "",
    enemy_index: info.enemyIndex ?? "",
    level_raw: levelRaw,
    level_label: ENEMY_LEVEL_ZH[levelRaw] ?? levelRaw,
    description: info.description ?? "",
    attack_type: info.attackType ?? "",
    ability: info.ability ?? "",
    damage_types_raw: damageTypesRaw,
    damage_types_label: damageTypesRaw.map((dt) => DAMAGE_TYPE_ZH[dt] ?? dt).join("、"),
    enemy_tags: Array.isArray(info.enemyTags) ? info.enemyTags : [],
    stats: null,
  };

  const dbEntry = level0Index(getDbLevels())[eid];
  if (dbEntry) payload.stats = extractEnemyStats(dbEntry);

  return payload;
}

export function renderEnemyInfo(data: EnemyInfoPayload): string {
  const lines = renderHandbookCard(data, true);
  if (data.stats) lines.push(...renderStatsBlock(data.stats));
  return lines.join("\n");
}

export function searchEnemies(pattern: string, maxResults = 30): string {
  const data = buildEnemySearch(pattern, maxResults);
  if (typeof data === "string") return data;
  return renderEnemySearch(data);
}

export function buildEnemySearch(pattern: string, maxResults = 30): EnemySearchPayload | string {
  if (!hasEnemyData()) return missingDataMessage();
  const boundsError = validateBounds("max_results", maxResults, { minimum: 1, maximum: 100 });
  if (boundsError !== null) return boundsError;

  let regex: RegExp;
  try { regex = new RegExp(pattern, "iu"); } catch (err) {
    return regexErrorMessage(err);
  }

  let records: EnemySearchRecord[];
  try { records = getEnemySearchRecords(); } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const matches: EnemySearchRecord[] = [];
  for (const record of records) {
    if (regex.test(record.searchText)) {
      matches.push(record);
      if (matches.length >= maxResults) break;
    }
  }

  return {
    scope: "enemies",
    pattern,
    total: matches.length,
    results: matches.map(enemySearchEntry),
  };
}

export function renderEnemySearch(data: EnemySearchPayload): string {
  const { pattern, results } = data;
  if (results.length === 0) return `未找到匹配 '${pattern}' 的敌人。`;

  const lines: string[] = [`# 搜索结果：${pattern}（共 ${data.total} 个）\n`];
  for (const entry of results) { lines.push(renderEnemySearchCard(entry)); lines.push(""); }
  return lines.join("\n").trim();
}

function enemySearchEntry(record: EnemySearchRecord): EnemySearchPayload["results"][number] {
  const info = record.info;
  const levelRaw = info.enemyLevel ?? "";
  const damageTypesRaw = Array.isArray(info.damageType) ? info.damageType : [];
  return {
    enemy_id: record.enemyId,
    name: info.name ?? "",
    enemy_index: info.enemyIndex ?? "",
    level_raw: levelRaw,
    level_label: ENEMY_LEVEL_ZH[levelRaw] ?? levelRaw,
    description: info.description ?? "",
    attack_type: info.attackType ?? "",
    ability: info.ability ?? "",
    damage_types_raw: damageTypesRaw,
    damage_types_label: damageTypesRaw.map((dt) => DAMAGE_TYPE_ZH[dt] ?? dt).join("、"),
    enemy_tags: Array.isArray(info.enemyTags) ? info.enemyTags : [],
  };
}

function renderEnemySearchCard(entry: EnemySearchPayload["results"][number]): string {
  return renderHandbookCard(entry).join("\n");
}
