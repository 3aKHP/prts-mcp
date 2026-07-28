/**
 * Stage/enemy cross-source fusion.
 * Reads stage_table.json, enemy_handbook_table.json, and zh_CN-levels data.
 * Mirrors python/src/prts_mcp/data/stage_enemy.py.
 */

import { loadConfig, hasLevelsData, registerActivationListener } from "../config.js";
import { DirectoryStore } from "./stores.js";

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

interface MValue {
  m_defined?: boolean;
  m_value?: unknown;
}

interface EnemyAttributes {
  maxHp?: MValue;
  atk?: MValue;
  def?: MValue;
  magicResistance?: MValue;
  moveSpeed?: MValue;
  baseAttackTime?: MValue;
  [key: string]: MValue | undefined;
}

interface EnemyData {
  attributes?: EnemyAttributes;
  [key: string]: unknown;
}

interface EnemyRef {
  id?: string;
  level?: number | string;
  overwrittenData?: Record<string, unknown> | null;
}

interface SpawnAction {
  actionType?: string | number;
  key?: string;
  count?: number;
}

interface LevelJson {
  enemyDbRefs?: EnemyRef[];
  waves?: Array<{
    fragments?: Array<{
      actions?: SpawnAction[];
    }>;
  }>;
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

let stageTable: Record<string, StageEntry> | null = null;
let enemyHandbook: Record<string, EnemyHandbookEntry> | null = null;
let enemyDatabase: Record<string, Record<number, EnemyData>> | null = null;
let nameToEnemyId: Map<string, string> | null = null;
let enemyAppearanceIndex: Map<string, Array<[string, number]>> | null = null;

export function clearStageEnemyCaches(): void {
  stageTable = null;
  enemyHandbook = null;
  enemyDatabase = null;
  nameToEnemyId = null;
  enemyAppearanceIndex = null;
}

registerActivationListener(clearStageEnemyCaches);

function excelStore(): DirectoryStore {
  const ep = loadConfig().effectiveExcelPath;
  if (ep === null) throw new Error("effectiveExcelPath is null");
  return new DirectoryStore(ep);
}

function levelsStore(): DirectoryStore {
  const lp = loadConfig().effectiveLevelsPath;
  if (lp === null) throw new Error("effectiveLevelsPath is null");
  return new DirectoryStore(`${lp}/zh_CN/gamedata/levels`);
}

function missingLevelsMessage(): string {
  const cfg = loadConfig();
  return (
    "关卡战斗数据暂不可用。请等待服务器自动从 GitHub Release 同步 " +
    "zh_CN-levels.zip 完成后重试。" +
    `（当前同步目标路径：${cfg.levelsPath}）`
  );
}

function loadStageTable(): Record<string, StageEntry> {
  loadConfig();
  if (stageTable === null) {
    const raw = excelStore().readJson<{ stages?: Record<string, StageEntry> }>("stage_table.json");
    if (!raw || typeof raw !== "object" || !raw.stages) {
      throw new Error("stage_table.json missing 'stages' dict");
    }
    stageTable = raw.stages;
  }
  return stageTable;
}

function loadEnemyHandbook(): Record<string, EnemyHandbookEntry> {
  loadConfig();
  if (enemyHandbook === null) {
    const raw = excelStore().readJson<{ enemyData?: Record<string, EnemyHandbookEntry> }>("enemy_handbook_table.json");
    if (!raw || typeof raw !== "object" || !raw.enemyData) {
      throw new Error("enemy_handbook_table.json missing 'enemyData' dict");
    }
    enemyHandbook = raw.enemyData;
  }
  return enemyHandbook;
}

function loadEnemyDatabase(): Record<string, Record<number, EnemyData>> {
  loadConfig();
  if (enemyDatabase === null) {
    const raw = levelsStore().readJson<{
      enemies?: Array<{ Key?: string; Value?: Array<{ level?: number | string; enemyData?: EnemyData }> }>;
    }>(DATABASE_FILE);
    const index: Record<string, Record<number, EnemyData>> = {};
    for (const row of raw.enemies ?? []) {
      if (!row.Key) continue;
      const levelMap: Record<number, EnemyData> = {};
      for (const value of row.Value ?? []) {
        if (value.enemyData) levelMap[parseLevel(value.level)] = value.enemyData;
      }
      index[row.Key] = levelMap;
    }
    enemyDatabase = index;
  }
  return enemyDatabase;
}

function buildNameToEnemyId(): Map<string, string> {
  loadConfig();
  if (nameToEnemyId === null) {
    nameToEnemyId = new Map();
    for (const [enemyId, info] of Object.entries(loadEnemyHandbook())) {
      if (info.name) nameToEnemyId.set(info.name, enemyId);
    }
  }
  return nameToEnemyId;
}

function levelPath(levelId: string): string {
  return `${levelId.toLowerCase().replace(/\\/g, "/")}.json`;
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

function mValue<T>(obj: unknown, defaultValue?: T): T | unknown {
  if (obj && typeof obj === "object" && "m_value" in obj) {
    return (obj as MValue).m_value;
  }
  return obj ?? defaultValue;
}

function parseLevel(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function mergeDefined(base: unknown, override: unknown): unknown {
  if (!override || typeof override !== "object") return base;
  const overrideRecord = override as Record<string, unknown>;
  if ("m_defined" in overrideRecord && "m_value" in overrideRecord) {
    return overrideRecord["m_defined"] ? overrideRecord["m_value"] : base;
  }
  const merged: Record<string, unknown> =
    base && typeof base === "object" && !Array.isArray(base)
      ? { ...(base as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(overrideRecord)) {
    if (value && typeof value === "object" && (value as MValue).m_defined === false) continue;
    merged[key] = mergeDefined(merged[key], value);
  }
  return merged;
}

function spawnCounts(level: LevelJson): Map<string, number> {
  const counts = new Map<string, number>();
  for (const wave of level.waves ?? []) {
    for (const fragment of wave.fragments ?? []) {
      for (const action of fragment.actions ?? []) {
        if (action.actionType !== "SPAWN" && action.actionType !== 0) continue;
        if (!action.key) continue;
        const rawCount = Number(action.count ?? 1);
        const count = Math.max(Number.isFinite(rawCount) ? Math.trunc(rawCount) : 1, 1);
        counts.set(action.key, (counts.get(action.key) ?? 0) + count);
      }
    }
  }
  return counts;
}

function enemyRefs(level: LevelJson): Map<string, EnemyRef> {
  const refs = new Map<string, EnemyRef>();
  for (const ref of level.enemyDbRefs ?? []) {
    if (ref.id) refs.set(ref.id, ref);
  }
  return refs;
}

function handbookName(enemyId: string): string {
  return loadEnemyHandbook()[enemyId]?.name ?? enemyId;
}

function overwrittenEnemyName(overwritten: unknown): string | null {
  if (!overwritten || typeof overwritten !== "object") return null;
  const record = overwritten as Record<string, unknown>;
  const name = record.name ?? record.prefabKey;
  const value = mValue(name);
  return value ? String(value) : null;
}

function stageLabel(stage: StageEntry, stageId: string): string {
  const name = stage.name || "（无名）";
  const code = stage.code || stageId;
  return `${name} ${code}（${stageId}）`;
}

function stageSpecificEnemyData(enemyId: string, level: number, overwritten?: unknown): EnemyData | null {
  const dbEntry = loadEnemyDatabase()[enemyId] ?? {};
  const base = dbEntry[level] ?? dbEntry[0];
  if (!base) return overwritten && typeof overwritten === "object" ? overwritten as EnemyData : null;
  const merged = mergeDefined(base, overwritten);
  return merged && typeof merged === "object" ? merged as EnemyData : base;
}

function formatNumber(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  return String(value ?? 0);
}

function formatFloatLike(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return `${value}.0`;
  return String(value ?? 0);
}

function formatStats(enemyData: EnemyData | null): string {
  if (!enemyData) return "战斗属性：无数据库记录";
  const attrs = enemyData.attributes ?? {};
  const hp = mValue(attrs.maxHp, 0);
  const atk = mValue(attrs.atk, 0);
  const defense = mValue(attrs.def, 0);
  const res = mValue(attrs.magicResistance, 0);
  const speed = mValue(attrs.moveSpeed, 0);
  const atkTime = mValue(attrs.baseAttackTime, 0);
  const parts = [`HP ${formatNumber(hp)}`, `ATK ${atk}`, `DEF ${defense}`, `RES ${res}`];
  if (speed) parts.push(`移速 ${formatFloatLike(speed)}`);
  if (atkTime) parts.push(`攻击间隔 ${formatFloatLike(atkTime)}s`);
  return parts.join("；");
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
    const data = stageSpecificEnemyData(enemyId, levelNo, ref?.overwrittenData);
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

function getEnemyAppearanceIndex(): Map<string, Array<[string, number]>> {
  loadConfig();
  if (enemyAppearanceIndex !== null) return enemyAppearanceIndex;
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
  enemyAppearanceIndex = index;
  return enemyAppearanceIndex;
}

function resolveEnemyId(name: string): string | null {
  return buildNameToEnemyId().get(name) ?? (loadEnemyHandbook()[name] ? name : null);
}

export function getEnemyAppearances(name: string, limit = 50, offset = 0): string {
  const data = buildEnemyAppearances(name, limit, offset);
  if (typeof data === "string") return data;
  return renderEnemyAppearances(data);
}

export function buildEnemyAppearances(name: string, limit = 50, offset = 0): EnemyAppearancesPayload | string {
  if (limit < 1) return "limit 必须 >= 1。";
  if (limit > 200) return "limit 必须 <= 200。";
  if (offset < 0) return "offset 必须 >= 0。";
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
  const data = stageSpecificEnemyData(enemyId, levelNo, ref.overwrittenData);
  const enemyName = overwrittenEnemyName(ref.overwrittenData) ?? handbookName(enemyId);
  const lines = [`# ${enemyName}（${enemyId}）@ ${stageLabel(stage, stageId)}`];
  lines.push(`- **出场数量**：${counts.get(enemyId) ?? 0}`);
  lines.push(`- **敌人等级**：${levelNo}`);
  if (ref.overwrittenData) lines.push("- **关卡覆盖**：是");
  lines.push(`- **战斗属性**：${formatStats(data)}`);
  return lines.join("\n");
}
