/**
 * Stage/enemy cross-source fusion.
 * Reads stage_table.json, enemy_handbook_table.json, and zh_CN-levels data.
 * Mirrors python/src/prts_mcp/data/stage_enemy.py.
 */

import { registerActivationListener } from "../activation.js";
import { hasLevelsData, loadConfig } from "../config.js";
import type { CacheStat } from "../cacheStats.js";
import { normalizeEnemyDatabase } from "./enemyDatabase.js";
import {
  defineDataset,
  excelStore,
  levelsStore,
  type DatasetAccess,
} from "./datasetAccess.js";
import {
  formatStats,
  overwrittenEnemyName,
  stageSpecificEnemyData,
} from "./enemyStats.js";
import {
  enemyRefs,
  levelPath,
  parseLevel,
  spawnCounts,
  type EnemyRef,
  type LevelJson,
} from "./levelParser.js";
import { levelsMissingMessage, validateBounds } from "./messages.js";

const DATABASE_FILE = "enemydata/enemy_database.json";

interface StageEntry {
  stageId?: string;
  code?: string | null;
  name?: string | null;
  levelId?: string | null;
}

interface EnemyHandbookEntry {
  name?: string;
  hideInHandbook?: boolean;
}

interface EnemyData {
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StageEnemiesPayload {
  stage_id: string;
  stage_label: string;
  total: number;
  enemies: Array<{
    enemy_id: string;
    name: string;
    count: number;
    level: number;
    overwritten: boolean;
    stats_text: string;
  }>;
  empty_reason?: "no_match";
}

export interface EnemyAppearancesPayload {
  enemy_id: string;
  enemy_name: string;
  total: number;
  offset: number;
  limit: number;
  stages: Array<{
    stage_id: string;
    stage_name: string;
    code: string;
    count: number;
  }>;
  empty_reason?: "no_match" | "offset_out_of_range";
}

export function clearStageEnemyCaches(): void {
  stageEnemyAccess.clear();
}

export function getCacheStats(): Record<string, CacheStat> {
  return stageEnemyAccess.stats();
}

function missingLevelsMessage(): string {
  return stageEnemyAccess.missingMessage();
}

function loadStageTableImpl(): Record<string, StageEntry> {
  const raw = excelStore().readJson<{ stages?: Record<string, StageEntry> }>("stage_table.json");
  if (!raw || typeof raw !== "object" || !raw.stages) {
    throw new Error("stage_table.json missing 'stages' dict");
  }
  return raw.stages;
}

function loadEnemyHandbookImpl(): Record<string, EnemyHandbookEntry> {
  const raw = excelStore().readJson<{ enemyData?: Record<string, EnemyHandbookEntry> }>("enemy_handbook_table.json");
  if (!raw || typeof raw !== "object" || !raw.enemyData) {
    throw new Error("enemy_handbook_table.json missing 'enemyData' dict");
  }
  return raw.enemyData;
}

function loadEnemyDatabaseImpl(): Record<string, Record<number, EnemyData>> {
  return normalizeEnemyDatabase<EnemyData>(
    levelsStore().readJson(DATABASE_FILE),
  );
}

function buildNameToEnemyIdImpl(): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const [enemyId, info] of Object.entries(loadEnemyHandbook())) {
    if (info.name) mapping.set(info.name, enemyId);
  }
  return mapping;
}

function loadLevelJson(stage: StageEntry): LevelJson | string {
  const levelId = stage.levelId;
  if (!levelId) return "该关卡没有 levelId，可能是非战斗/特殊关卡。";
  const path = levelPath(levelId);
  const store = levelsStore();
  if (!store.exists(path)) return `未找到关卡战斗文件：${path}。`;
  const raw = store.readJson<LevelJson>(path);
  if (!raw || typeof raw !== "object") return `关卡战斗文件格式异常：${path}。`;
  return raw;
}

function handbookName(enemyId: string): string {
  return loadEnemyHandbook()[enemyId]?.name ?? enemyId;
}

function stageLabel(stage: StageEntry, stageId: string): string {
  const name = stage.name || "（无名）";
  const code = stage.code || stageId;
  return `${name} ${code}（${stageId}）`;
}

function sortedCounts(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function getStageEnemies(stageId: string): string {
  const data = buildStageEnemies(stageId);
  if (typeof data === "string") return data;
  return renderStageEnemies(data);
}

export function buildStageEnemies(stageId: string): StageEnemiesPayload | string {
  if (!hasLevelsData(loadConfig())) return missingLevelsMessage();
  let stage: StageEntry | undefined;
  let level: LevelJson | string;
  let counts: Map<string, number>;
  let refs: Map<string, EnemyRef>;
  try {
    stage = loadStageTable()[stageId];
    if (!stage) return `未找到关卡：${JSON.stringify(stageId)}。`;
    level = loadLevelJson(stage);
    if (typeof level === "string") return level;
    counts = spawnCounts(level);
    refs = enemyRefs(level);
  } catch (err) {
    return `读取关卡敌人失败：${err instanceof Error ? err.message : String(err)}`;
  }

  if (counts.size === 0) {
    return {
      stage_id: stageId,
      stage_label: stageLabel(stage, stageId),
      total: 0,
      enemies: [],
      empty_reason: "no_match",
    };
  }

  const enemies = sortedCounts(counts).map(([enemyId, count]) => {
    const ref = refs.get(enemyId);
    const levelNo = parseLevel(ref?.level);
    const data = stageSpecificEnemyData(loadEnemyDatabase(), enemyId, levelNo, ref?.overwrittenData);
    const name = overwrittenEnemyName(ref?.overwrittenData) ?? handbookName(enemyId);
    return {
      enemy_id: enemyId,
      name,
      count,
      level: levelNo,
      overwritten: Boolean(ref?.overwrittenData),
      stats_text: formatStats(data),
    };
  });

  return {
    stage_id: stageId,
    stage_label: stageLabel(stage, stageId),
    total: enemies.length,
    enemies,
  };
}

export function renderStageEnemies(data: StageEnemiesPayload): string {
  if (data.empty_reason === "no_match") {
    return `关卡 ${JSON.stringify(data.stage_id)} 未解析到实际出怪。`;
  }

  const lines = [`# ${data.stage_label} — 敌人列表`];
  for (const enemy of data.enemies) {
    lines.push(`\n## ${enemy.name}（${enemy.enemy_id}）`);
    lines.push(`- **出场数量**：${enemy.count}`);
    lines.push(`- **敌人等级**：${enemy.level}`);
    if (enemy.overwritten) lines.push("- **关卡覆盖**：是");
    lines.push(`- **战斗属性**：${enemy.stats_text}`);
  }
  return lines.join("\n");
}

function findEnemyAppearances(enemyId: string): Array<[string, number]> {
  return getEnemyAppearanceIndex().get(enemyId) ?? [];
}

function getEnemyAppearanceIndexImpl(): Map<string, Array<[string, number]>> {
  const index = new Map<string, Array<[string, number]>>();
  const stages = loadStageTable();
  const store = levelsStore();
  for (const [stageId, stage] of Object.entries(stages)) {
    if (!stage.levelId) continue;
    const path = levelPath(stage.levelId);
    if (!store.exists(path)) continue;
    const level = store.readJson<LevelJson>(path);
    if (!level || typeof level !== "object" || Array.isArray(level)) continue;
    for (const [enemyId, count] of spawnCounts(level)) {
      const appearances = index.get(enemyId);
      if (appearances) appearances.push([stageId, count]);
      else index.set(enemyId, [[stageId, count]]);
    }
  }
  return index;
}

const stageEnemyAccess: DatasetAccess = defineDataset({
  name: "stage_enemy",
  loaders: {
    stage_table: { load: loadStageTableImpl },
    enemy_handbook: { load: loadEnemyHandbookImpl },
    enemy_database: { load: loadEnemyDatabaseImpl },
    enemy_name_to_id: {
      load: buildNameToEnemyIdImpl,
      count: (m) => (m as Map<string, string>).size,
    },
    enemy_appearance_index: {
      load: getEnemyAppearanceIndexImpl,
      count: (m) => (m as Map<string, Array<[string, number]>>).size,
    },
  },
  store: excelStore,
  available: () => hasLevelsData(loadConfig()),
  missingMessage: levelsMissingMessage("关卡战斗"),
});

const loadStageTable = stageEnemyAccess.loader<Record<string, StageEntry>>("stage_table");
const loadEnemyHandbook = stageEnemyAccess.loader<Record<string, EnemyHandbookEntry>>("enemy_handbook");
const loadEnemyDatabase = stageEnemyAccess.loader<Record<string, Record<number, EnemyData>>>("enemy_database");
const buildNameToEnemyId = stageEnemyAccess.loader<Map<string, string>>("enemy_name_to_id");
const getEnemyAppearanceIndex = stageEnemyAccess.loader<Map<string, Array<[string, number]>>>("enemy_appearance_index");

registerActivationListener(clearStageEnemyCaches);

function resolveEnemyId(name: string): string | null {
  return buildNameToEnemyId().get(name) ?? (loadEnemyHandbook()[name] ? name : null);
}

export function getEnemyAppearances(name: string, limit = 50, offset = 0): string {
  const data = buildEnemyAppearances(name, limit, offset);
  if (typeof data === "string") return data;
  return renderEnemyAppearances(data);
}

export function buildEnemyAppearances(name: string, limit = 50, offset = 0): EnemyAppearancesPayload | string {
  const boundsError = validateBounds("limit", limit, { minimum: 1, maximum: 200 })
    ?? validateBounds("offset", offset, { minimum: 0 });
  if (boundsError !== null) return boundsError;
  if (!hasLevelsData(loadConfig())) return missingLevelsMessage();

  let enemyId: string | null;
  let appearances: Array<[string, number]>;
  let stages: Record<string, StageEntry>;
  try {
    enemyId = resolveEnemyId(name);
    if (enemyId === null) return `未找到敌人：${JSON.stringify(name)}。`;
    appearances = findEnemyAppearances(enemyId);
    stages = loadStageTable();
  } catch (err) {
    return `读取敌人出场关卡失败：${err instanceof Error ? err.message : String(err)}`;
  }

  const total = appearances.length;
  const page = appearances.slice(offset, offset + limit);
  const enemyName = handbookName(enemyId);
  if (page.length === 0) {
    return {
      enemy_id: enemyId,
      enemy_name: enemyName,
      total,
      offset,
      limit,
      stages: [],
      empty_reason: total === 0 ? "no_match" : "offset_out_of_range",
    };
  }

  const stageEntries = page.map(([stageId, count]) => {
    const stage = stages[stageId] ?? {};
    return {
      stage_id: stageId,
      stage_name: stage.name || "（无名）",
      code: stage.code || stageId,
      count,
    };
  });

  return {
    enemy_id: enemyId,
    enemy_name: enemyName,
    total,
    offset,
    limit,
    stages: stageEntries,
  };
}

export function renderEnemyAppearances(data: EnemyAppearancesPayload): string {
  if (data.empty_reason === "no_match") {
    return `未找到 ${data.enemy_name}（${data.enemy_id}）的实际出场关卡。`;
  }
  if (data.empty_reason === "offset_out_of_range") {
    return `offset ${data.offset} 超出范围（共 ${data.total} 条）。`;
  }

  const lines = [`# ${data.enemy_name}（${data.enemy_id}）— 出场关卡（共 ${data.total} 个）`];
  for (const stage of data.stages) {
    lines.push(`- **${stage.stage_name}** ${stage.code}（${stage.stage_id}）：${stage.count} 个`);
  }
  const { offset, limit, total } = data;
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  lines.push(`\n（显示第 ${start}–${end} 条，共 ${total} 条。使用 offset=${offset + limit} 查看下一页）`);
  return lines.join("\n");
}

export function getEnemyStageInfo(name: string, stageId: string): string {
  if (!hasLevelsData(loadConfig())) return missingLevelsMessage();
  let enemyId: string | null;
  let stage: StageEntry | undefined;
  let level: LevelJson | string;
  let counts: Map<string, number>;
  let refs: Map<string, EnemyRef>;
  try {
    enemyId = resolveEnemyId(name);
    if (enemyId === null) return `未找到敌人：${JSON.stringify(name)}。`;
    stage = loadStageTable()[stageId];
    if (!stage) return `未找到关卡：${JSON.stringify(stageId)}。`;
    level = loadLevelJson(stage);
    if (typeof level === "string") return level;
    counts = spawnCounts(level);
    refs = enemyRefs(level);
  } catch (err) {
    return `读取关卡敌人失败：${err instanceof Error ? err.message : String(err)}`;
  }

  if (!counts.has(enemyId)) {
    return `${handbookName(enemyId)}（${enemyId}）未在关卡 ${JSON.stringify(stageId)} 实际出场。`;
  }
  const ref = refs.get(enemyId);
  if (!ref) return `关卡 ${JSON.stringify(stageId)} 缺少 ${enemyId} 的 enemyDbRefs。`;

  const levelNo = parseLevel(ref.level);
  const data = stageSpecificEnemyData(loadEnemyDatabase(), enemyId, levelNo, ref.overwrittenData);
  const enemyName = overwrittenEnemyName(ref.overwrittenData) ?? handbookName(enemyId);
  const lines = [`# ${enemyName}（${enemyId}）@ ${stageLabel(stage, stageId)}`];
  lines.push(`- **出场数量**：${counts.get(enemyId) ?? 0}`);
  lines.push(`- **敌人等级**：${levelNo}`);
  if (ref.overwrittenData) lines.push("- **关卡覆盖**：是");
  lines.push(`- **战斗属性**：${formatStats(data)}`);
  return lines.join("\n");
}
