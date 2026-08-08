/**
 * Enemy handbook + database reader.
 * Reads enemy_handbook_table.json and enemy_database.json from local game data.
 * Mirrors python/src/prts_mcp/data/enemy.py.
 */

import { checkActivationChange, loadConfig, registerActivationListener } from "../config.js";
import { DirectoryStore } from "./stores.js";
import { normalizeEnemyDatabase } from "./enemyDatabase.js";

// ---------------------------------------------------------------------------
// Module-level caches
// ---------------------------------------------------------------------------

let _handbook: EnemyHandbook | null = null;
let _dbIndex: Record<string, EnemyDbEntry> | null = null;
let _nameToEnemyId: Map<string, string> | null = null;
let _enemySearchRecords: EnemySearchRecord[] | null = null;

const HANDBOOK_FILE = "enemy_handbook_table.json";
const DATABASE_FILE = "enemy_database.json";

export function clearEnemyCaches(): void {
  _handbook = null;
  _dbIndex = null;
  _nameToEnemyId = null;
  _enemySearchRecords = null;
}

registerActivationListener(clearEnemyCaches);

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

interface MValue {
  m_defined?: boolean;
  m_value?: unknown;
}

interface EnemyDbAttrs {
  maxHp?: MValue;
  atk?: MValue;
  def?: MValue;
  magicResistance?: MValue;
  moveSpeed?: MValue;
  baseAttackTime?: MValue;
  attackSpeed?: MValue;
  massLevel?: MValue;
  hpRecoveryPerSec?: MValue;
  spRecoveryPerSec?: MValue;
  lifePointReduce?: MValue;
  stunImmune?: MValue;
  silenceImmune?: MValue;
  sleepImmune?: MValue;
  frozenImmune?: MValue;
  levitateImmune?: MValue;
  disarmedCombatImmune?: MValue;
  fearedImmune?: MValue;
  palsyImmune?: MValue;
  attractImmune?: MValue;
  [key: string]: MValue | undefined;
}

interface EnemySkill {
  prefabKey?: string;
  priority?: number;
  cooldown?: number;
  initCooldown?: number;
  spData?: { spCost?: MValue };
  blackboard?: Array<{ key?: string; value?: unknown }>;
}

interface EnemyDbEntry {
  attributes?: EnemyDbAttrs;
  skills?: EnemySkill[] | null;
  talentBlackboard?: Array<{ key?: string; value?: unknown }>;
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

export interface EnemyStatsPayload {
  max_hp: string | null;
  atk: string | null;
  def: string | null;
  resistance: string | null;
  move_speed: string | null;
  attack_interval: string | null;
  attack_speed: string | null;
  mass_level: string | null;
  hp_recovery_per_sec: string | null;
  immunities: string[];
  life_point_reduce: string | null;
  skills: Array<{
    prefab: string;
    timing: string;
    blackboard: string;
  }>;
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
  const cfg = loadConfig();
  return (
    "敌人图鉴数据暂不可用。" +
    "容器启动时的 auto-sync 可能仍在进行中，请稍后重试；" +
    "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。" +
    `（当前同步目标路径：${cfg.excelPath}）`
  );
}

function hasEnemyData(): boolean {
  const cfg = loadConfig();
  if (cfg.effectiveExcelPath === null) return false;
  return new DirectoryStore(cfg.effectiveExcelPath).exists(HANDBOOK_FILE);
}

function getHandbook(): EnemyHandbook {
  checkActivationChange();
  if (_handbook === null) {
    const cfg = loadConfig();
    if (cfg.effectiveExcelPath === null) throw new Error("effectiveExcelPath is null");
    const store = new DirectoryStore(cfg.effectiveExcelPath);
    if (!store.exists(HANDBOOK_FILE)) {
      throw new Error(
        `敌人图鉴数据文件不存在：${store.resolveForDiagnostics(HANDBOOK_FILE)}。`
      );
    }
    _handbook = store.readJson<EnemyHandbook>(HANDBOOK_FILE);
  }
  return _handbook;
}

function mValue<T>(obj: unknown, defaultValue?: T): T | undefined {
  if (obj && typeof obj === "object" && "m_value" in obj) {
    return (obj as MValue).m_value as T | undefined;
  }
  if (obj !== null && obj !== undefined) return obj as T;
  return defaultValue;
}

function getDbIndex(): Record<string, EnemyDbEntry> {
  checkActivationChange();
  if (_dbIndex === null) {
    const cfg = loadConfig();
    const lp = cfg.effectiveLevelsPath;
    if (!lp) { _dbIndex = {}; return _dbIndex; }
    const dbRoot = join(lp, "zh_CN", "gamedata", "levels", "enemydata");
    // path handling
    const store = new DirectoryStore(dbRoot);
    if (!store.exists(DATABASE_FILE)) { _dbIndex = {}; return _dbIndex; }
    const levels = normalizeEnemyDatabase<EnemyDbEntry>(store.readJson(DATABASE_FILE));
    const index: Record<string, EnemyDbEntry> = {};
    for (const [enemyId, levelMap] of Object.entries(levels)) {
      const first = levelMap[0] ?? Object.values(levelMap)[0];
      if (first) index[enemyId] = first;
    }
    _dbIndex = index;
  }
  return _dbIndex;
}

function join(...parts: (string | undefined | null)[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function buildNameToEnemyId(): Map<string, string> {
  checkActivationChange();
  if (_nameToEnemyId === null) {
    const raw = getHandbook();
    const ed = raw.enemyData ?? {};
    _nameToEnemyId = new Map(
      Object.entries(ed)
        .filter(([, info]) => info.name)
        .map(([eid, info]) => [info.name!, eid])
    );
  }
  return _nameToEnemyId;
}

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

const IMMUNITY_LABELS: Record<string, string> = {
  stunImmune: "眩晕",
  silenceImmune: "沉默",
  sleepImmune: "睡眠",
  frozenImmune: "冻结",
  levitateImmune: "浮空",
  disarmedCombatImmune: "缴械",
  fearedImmune: "恐惧",
  palsyImmune: "瘫痪",
  attractImmune: "牵引",
};

function formatNumber(n: number): string {
  // Locale-independent thousands separator (matches Python's f"{n:,}").
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

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

  if (limit < 1) return `无效的 limit 参数：${limit}，需 ≥ 1。`;
  if (offset < 0) return `无效的 offset 参数：${offset}，需 ≥ 0。`;

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

  const dbIndex = getDbIndex();
  const dbEntry = dbIndex[eid];
  if (dbEntry) payload.stats = extractEnemyStats(dbEntry);

  return payload;
}

function pythonFloatString(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

function extractEnemyStats(dbEntry: EnemyDbEntry): EnemyStatsPayload {
  const attrs = dbEntry.attributes ?? {};
  const hp = mValue<number>(attrs.maxHp, 0) ?? 0;
  const atk = mValue<number>(attrs.atk, 0) ?? 0;
  const def = mValue<number>(attrs.def, 0) ?? 0;
  const res = mValue<number>(attrs.magicResistance);
  const speed = mValue<number>(attrs.moveSpeed, 0) ?? 0;
  const atkTime = mValue<number>(attrs.baseAttackTime, 0) ?? 0;
  const atkSpeed = mValue<number>(attrs.attackSpeed, 100) ?? 100;
  const mass = mValue<number>(attrs.massLevel, 0) ?? 0;
  const hpRec = mValue<number>(attrs.hpRecoveryPerSec, 0) ?? 0;
  const lpr = mValue<number>(attrs.lifePointReduce, 0) ?? 0;

  const immunities: string[] = [];
  for (const [key, label] of Object.entries(IMMUNITY_LABELS)) {
    if (mValue<boolean>(attrs[key], false)) immunities.push(label);
  }

  const skills = (Array.isArray(dbEntry.skills) ? dbEntry.skills : []).map((s) => {
    const prefab = s.prefabKey ?? "未知";
    const cd = s.cooldown;
    const initCd = s.initCooldown;
    const spCost = mValue<number>(s.spData?.spCost);
    const cdParts: string[] = [];
    if (cd) cdParts.push(`冷却 ${cd}s`);
    if (initCd && initCd !== cd) cdParts.push(`初始 ${initCd}s`);
    if (spCost) cdParts.push(`SP ${spCost}`);
    const bbStrs = (Array.isArray(s.blackboard) ? s.blackboard : [])
      .slice(0, 6)
      .filter((b) => b.value != null)
      .map((b) => {
        const value = typeof b.value === "number" ? pythonFloatString(b.value) : b.value;
        return `${b.key ?? ""}=${value}`;
      });
    return {
      prefab,
      timing: cdParts.join("，"),
      blackboard: bbStrs.join("，"),
    };
  });

  return {
    max_hp: hp ? formatNumber(hp) : null,
    atk: atk ? String(atk) : null,
    def: def ? String(def) : null,
    resistance: res !== undefined && res !== null ? pythonFloatString(res) : null,
    move_speed: speed ? pythonFloatString(speed) : null,
    attack_interval: atkTime ? `${pythonFloatString(atkTime)}s` : null,
    attack_speed: atkSpeed !== 100 ? pythonFloatString(atkSpeed) : null,
    mass_level: mass ? String(mass) : null,
    hp_recovery_per_sec: hpRec ? pythonFloatString(hpRec) : null,
    immunities,
    life_point_reduce: lpr ? String(lpr) : null,
    skills,
  };
}

function hasEnemyStatsContent(stats: EnemyStatsPayload): boolean {
  const scalarFields = [
    "max_hp",
    "atk",
    "def",
    "resistance",
    "move_speed",
    "attack_interval",
    "attack_speed",
    "mass_level",
    "hp_recovery_per_sec",
    "life_point_reduce",
  ] as const;
  return scalarFields.some((field) => Boolean(stats[field])) ||
    stats.immunities.length > 0 ||
    stats.skills.length > 0;
}

export function renderEnemyInfo(data: EnemyInfoPayload): string {
  const lines: string[] = [];
  if (data.name) {
    lines.push(`# ${data.name} - 敌人图鉴\n`);
    lines.push(`- **ID**：${data.enemy_id}`);
  }

  if (data.enemy_index) lines.push(`- **编号**：${data.enemy_index}`);
  if (data.level_label) lines.push(`- **威胁等级**：${data.level_label}`);
  if (data.description) lines.push(`- **描述**：${data.description}`);
  if (data.attack_type) lines.push(`- **攻击方式**：${data.attack_type}`);
  if (data.ability) lines.push(`- **特殊能力**：${data.ability}`);
  if (data.damage_types_label) lines.push(`- **伤害类型**：${data.damage_types_label}`);
  if (data.enemy_tags.length > 0) lines.push(`- **标签**：${data.enemy_tags.join("、")}`);

  const stats = data.stats;
  if (stats && hasEnemyStatsContent(stats)) {
    lines.push("## 战斗属性");
    for (const [field, label] of [
      ["max_hp", "最大生命"],
      ["atk", "攻击力"],
      ["def", "防御力"],
      ["resistance", "法术抗性"],
      ["move_speed", "移动速度"],
      ["attack_interval", "攻击间隔"],
      ["attack_speed", "攻击速度"],
      ["mass_level", "重量等级"],
      ["hp_recovery_per_sec", "每秒生命回复"],
    ] as const) {
      const val = stats[field];
      if (val) lines.push(`- **${label}**：${val}`);
    }
    if (stats.immunities.length > 0) lines.push(`- **免疫**：${stats.immunities.join("、")}`);
    if (stats.life_point_reduce) lines.push(`- **生命值扣除**：${stats.life_point_reduce}`);
    if (stats.skills.length > 0) {
      lines.push("\n## 技能");
      for (const skill of stats.skills) {
        const parts = [`- **${skill.prefab}**`];
        if (skill.timing) parts.push(`（${skill.timing}）`);
        if (skill.blackboard) parts.push(": " + skill.blackboard);
        lines.push(parts.join(""));
      }
    }
  }

  return lines.join("\n");
}

export function searchEnemies(pattern: string, maxResults = 30): string {
  const data = buildEnemySearch(pattern, maxResults);
  if (typeof data === "string") return data;
  return renderEnemySearch(data);
}

export function buildEnemySearch(pattern: string, maxResults = 30): EnemySearchPayload | string {
  if (!hasEnemyData()) return missingDataMessage();
  if (maxResults < 1) return "max_results 必须 >= 1。";
  if (maxResults > 100) return "max_results 必须 <= 100。";

  let regex: RegExp;
  try { regex = new RegExp(pattern, "i"); } catch (err) {
    return `正则表达式无效：${err instanceof Error ? err.message : String(err)}`;
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
  const lines: string[] = [];
  if (entry.name) lines.push(`# ${entry.name} - 敌人图鉴\n`);
  if (entry.enemy_index) lines.push(`- **编号**：${entry.enemy_index}`);
  if (entry.level_label) lines.push(`- **威胁等级**：${entry.level_label}`);
  if (entry.description) lines.push(`- **描述**：${entry.description}`);
  if (entry.attack_type) lines.push(`- **攻击方式**：${entry.attack_type}`);
  if (entry.ability) lines.push(`- **特殊能力**：${entry.ability}`);
  if (entry.damage_types_label) lines.push(`- **伤害类型**：${entry.damage_types_label}`);
  if (entry.enemy_tags.length > 0) lines.push(`- **标签**：${entry.enemy_tags.join("、")}`);
  return lines.join("\n");
}

function getEnemySearchRecords(): EnemySearchRecord[] {
  checkActivationChange();
  if (_enemySearchRecords !== null) return _enemySearchRecords;
  const ed = getHandbook().enemyData ?? {};
  _enemySearchRecords = Object.entries(ed)
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
  return _enemySearchRecords;
}
