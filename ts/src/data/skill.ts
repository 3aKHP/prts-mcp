/**
 * Combat-skill (战斗技能) data reader — skill_table.json backed.
 * Mirrors python/src/prts_mcp/data/skill.py. Joins character_table.json
 * skill refs against skill_table.json per-level entries and renders level
 * descriptions by substituting blackboard placeholders (`{key}` plain and
 * `{key:0%}` .NET-style formats). operator.ts never imports this module,
 * so the top-level import is cycle-free.
 */
import { registerActivationListener } from "../activation.js";
import { hasOperatorData, loadConfig } from "../config.js";
import type { CacheStat } from "../cacheStats.js";
import { stripWikitext } from "../utils/sanitizer.js";
import { defineDataset, excelStore, type DatasetAccess } from "./datasetAccess.js";
import { excelMissingMessage, regexErrorMessage, validateBounds } from "./messages.js";
import { getCharacterTable, nameToCharId, resolveCharId } from "./operator.js";

const SKILL_TYPE_ZH: Record<string, string> = {
  MANUAL: "手动",
  AUTO: "自动",
  PASSIVE: "被动",
};

const SP_TYPE_ZH: Record<string, string> = {
  INCREASE_WITH_TIME: "自动回复",
  INCREASE_WHEN_ATTACK: "攻击回复",
  INCREASE_WHEN_TAKEN_DAMAGE: "受击回复",
};

interface BlackboardEntry {
  key?: string;
  value?: number | null;
  valueStr?: string | null;
}

interface SpData {
  // Real passives carry the integer sentinel 8 instead of a string enum.
  spType?: string | number | null;
  spCost?: number | null;
  initSp?: number | null;
  maxChargeTime?: number | null;
}

interface SkillLevelEntry {
  name?: string;
  description?: string;
  skillType?: string | null;
  durationType?: string | null;
  duration?: number | null;
  blackboard?: BlackboardEntry[];
  spData?: SpData | null;
}

interface SkillTableEntry {
  skillId?: string;
  iconId?: string | null;
  hidden?: boolean;
  levels?: SkillLevelEntry[];
}

type SkillTable = Record<string, SkillTableEntry>;

export interface SkillLevelPayload {
  level: number;
  name: string;
  skill_type: string;
  skill_type_raw: string;
  sp_type: string;
  sp_cost: number | null;
  init_sp: number | null;
  max_charge_time: number | null;
  duration: number | null;
  duration_type: string;
  description: string;
}

export interface OperatorSkillPayload {
  skill_id: string;
  name: string;
  levels: SkillLevelPayload[];
}

export interface OperatorSkillsPayload {
  name: string;
  char_id: string;
  skills: OperatorSkillPayload[];
}

export function clearSkillCaches(): void {
  skillAccess.clear();
}

export function getCacheStats(): Record<string, CacheStat> {
  return skillAccess.stats();
}

/** Whether skill_table.json exists in the effective excel store. */
export function hasSkillData(): boolean {
  return excelStore().exists("skill_table.json");
}

function getSkillTableImpl(): SkillTable {
  const store = excelStore();
  const filePath = "skill_table.json";
  if (!store.exists(filePath)) {
    throw new Error(
      `战斗技能数据文件不存在：${store.resolveForDiagnostics(filePath)}。` +
        "数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向游戏数据根目录）。"
    );
  }
  return store.readJson<SkillTable>(filePath);
}

const skillAccess: DatasetAccess = defineDataset({
  name: "skill",
  loaders: {
    skill_table: {
      load: getSkillTableImpl,
      count: (r) => Object.keys(r as SkillTable).length,
    },
    skill_search_records: { load: getSkillSearchRecordsImpl },
  },
  store: excelStore,
  available: () => hasOperatorData(loadConfig()),
  missingMessage: excelMissingMessage("战斗技能"),
});

const getSkillTable = skillAccess.loader<SkillTable>("skill_table");
const getSkillSearchRecords = skillAccess.loader<SkillSearchRecord[]>("skill_search_records");

registerActivationListener(clearSkillCaches);

// ---------------------------------------------------------------------------
// Blackboard placeholder rendering
// ---------------------------------------------------------------------------

// Placeholder formats observed across all 1795 skill_table entries (closed
// set as of the 2.8.0 scan): "", "0", "0.0", "0%", "0.0%".
const PLACEHOLDER_RE = /\{([^{}:]+)(?::([^{}]*))?\}/g;
const KNOWN_FORMAT_RE = /^0(?:\.0+)?%?$/;

function roundHalfAway(value: number, decimals: number): number {
  // .NET numeric format strings round midpoints away from zero; the PY
  // twin shares this exact formula so rendered text stays byte-identical.
  // A zero result is normalized to +0: Python copysign would keep the
  // sign (rendering "-0"/"-0%") where ECMAScript toFixed drops it.
  const factor = 10 ** decimals;
  const rounded = Math.floor(Math.abs(value) * factor + 0.5) / factor;
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

export function formatPlaceholderValue(value: number, fmt: string): string | null {
  if (fmt === "") {
    if (Number.isInteger(value)) return `${value}`;
    return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (!KNOWN_FORMAT_RE.test(fmt)) return null;
  let v = value;
  const percent = fmt.endsWith("%");
  if (percent) {
    fmt = fmt.slice(0, -1);
    v = v * 100;
  }
  const decimals = fmt.includes(".") ? fmt.split(".", 2)[1]!.length : 0;
  const rendered = roundHalfAway(v, decimals).toFixed(decimals);
  return percent ? `${rendered}%` : rendered;
}

export function renderSkillDescription(
  description: string,
  blackboard: BlackboardEntry[] | undefined,
): string {
  const values = new Map<string, BlackboardEntry>();
  for (const entry of Array.isArray(blackboard) ? blackboard : []) {
    if (entry.key) values.set(entry.key, entry);
  }

  const substituted = (description || "").replace(
    PLACEHOLDER_RE,
    (token: string, key: string, fmtArg: string | undefined) => {
      const fmt = fmtArg ?? "";
      // A leading `-` in the key negates the positive twin's value — the
      // table's convention for debuffs (`-{-def}` with `def: -330`).
      const negated = key.startsWith("-");
      const entry = values.get(negated ? key.slice(1) : key);
      if (entry === undefined) return token;
      if (entry.valueStr !== null && entry.valueStr !== undefined) {
        // Negation only applies to numeric values; a string twin of a
        // minus key has no defined rendering — keep the literal token.
        return negated ? token : String(entry.valueStr);
      }
      if (typeof entry.value !== "number") return token;
      const rendered = formatPlaceholderValue(negated ? -entry.value : entry.value, fmt);
      return rendered ?? token;
    },
  );
  return stripWikitext(substituted);
}

// ---------------------------------------------------------------------------
// Per-operator payload (get_operator_skills)
// ---------------------------------------------------------------------------

function skillLevels(entry: SkillTableEntry): SkillLevelPayload[] {
  // skill_table level entries carry no explicit `level` field — the level
  // is the 1-based array index (levels[0] is Lv1, levels[9] is mastery 3).
  const levels: SkillLevelPayload[] = [];
  const rawLevels = Array.isArray(entry.levels) ? entry.levels : [];
  rawLevels.forEach((rawLv, idx) => {
    // Mirror the PY isinstance(lv, dict) guard: null/primitive level
    // entries are skipped, not crashed on.
    if (typeof rawLv !== "object" || rawLv === null) return;
    const lv = rawLv;
    const sp = typeof lv.spData === "object" && lv.spData !== null ? lv.spData : {};
    const skillTypeRaw = lv.skillType ?? "";
    // Real passives carry spType as the JSON integer 8 (a "no SP
    // recovery" sentinel), not a string — non-string spTypes render as
    // empty rather than leaking the raw value into payloads.
    const spTypeRaw = typeof sp.spType === "string" ? sp.spType : "";
    const durationTypeRaw = lv.durationType ?? "";
    levels.push({
      level: idx + 1,
      name: lv.name ?? "",
      skill_type: SKILL_TYPE_ZH[skillTypeRaw] ?? skillTypeRaw,
      skill_type_raw: skillTypeRaw,
      sp_type: SP_TYPE_ZH[spTypeRaw] ?? spTypeRaw,
      sp_cost: sp.spCost ?? null,
      init_sp: sp.initSp ?? null,
      max_charge_time: sp.maxChargeTime ?? null,
      duration: lv.duration ?? null,
      duration_type: durationTypeRaw,
      description: renderSkillDescription(lv.description ?? "", lv.blackboard),
    });
  });
  return levels;
}

export function buildOperatorSkills(name: string): OperatorSkillsPayload | string {
  const cfg = loadConfig();
  if (!hasOperatorData(cfg)) return skillAccess.missingMessage();

  const charId = resolveCharId(name);
  if (charId === null) {
    return `未找到干员 '${name}'。请使用游戏内中文名称（如'阿米娅'）。`;
  }

  const info = getCharacterTable()[charId] ?? {};

  let table: SkillTable;
  try {
    table = getSkillTable();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    return "skill_table.json 顶层不是 JSON 对象。";
  }

  const skills: OperatorSkillPayload[] = [];
  for (const ref of Array.isArray(info.skills) ? info.skills : []) {
    const skillId = ref?.skillId;
    if (!skillId) continue;
    const entry = table[skillId];
    if (typeof entry !== "object" || entry === null) continue;
    const levels = skillLevels(entry);
    if (levels.length === 0) continue;
    skills.push({
      skill_id: skillId,
      name: levels[levels.length - 1]!.name || levels[0]!.name,
      levels,
    });
  }

  if (skills.length === 0) {
    return `干员 '${name}' 暂无战斗技能数据。`;
  }
  return { name, char_id: charId, skills };
}

const LEVEL_LABELS: Record<number, string> = { 8: "专一", 9: "专二", 10: "专三" };

function levelLabel(level: number): string {
  return LEVEL_LABELS[level] ?? `Lv${level}`;
}

function plainNumber(value: number): string {
  return formatPlaceholderValue(value, "") ?? String(value);
}

function levelSuffix(level: SkillLevelPayload): string {
  const parts: string[] = [];
  if (level.skill_type_raw !== "PASSIVE" && level.sp_cost !== null) {
    parts.push(`SP ${level.sp_cost}`);
    if (level.init_sp) parts.push(`初始 ${level.init_sp}`);
    if (typeof level.max_charge_time === "number" && level.max_charge_time > 1) {
      parts.push(`可充能 ${level.max_charge_time} 次`);
    }
  }
  // -1 is the table's "no duration" sentinel (instant / on-next-attack
  // skills and passives); only positive durations render.
  if (typeof level.duration === "number" && level.duration > 0) {
    if (level.duration_type === "AMMO") {
      parts.push(`弹药 ${plainNumber(level.duration)} 发`);
    } else {
      parts.push(`持续 ${plainNumber(level.duration)} 秒`);
    }
  }
  return parts.length > 0 ? `（${parts.join("，")}）` : "";
}

export function renderOperatorSkills(data: OperatorSkillsPayload): string {
  const lines: string[] = [`# ${data.name} - 战斗技能`];
  for (const skill of data.skills) {
    const top = skill.levels[skill.levels.length - 1]!;
    let heading = skill.name;
    if (top.skill_type) {
      heading += `（${top.skill_type}`;
      if (top.sp_type) heading += `，${top.sp_type}`;
      heading += "）";
    }
    lines.push(`\n## ${heading}`);
    for (const level of skill.levels) {
      lines.push(`- **${levelLabel(level.level)}**：${level.description}${levelSuffix(level)}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Cross-operator search (search tool's skills scope)
// ---------------------------------------------------------------------------

interface SkillSearchRecord {
  operator: string;
  skill: string;
  text: string;
  haystack: string;
}

export interface SkillSearchPayload {
  scope: "skills";
  pattern: string;
  total: number;
  results: Array<{ operator: string; skill: string; text: string }>;
}

function getSkillSearchRecordsImpl(): SkillSearchRecord[] {
  if (!hasSkillData()) {
    // Older user-supplied data roots may lack skill_table.json; the
    // scope then reports no matches rather than a data error.
    return [];
  }
  const table = getSkillTable();
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error("skill_table.json 顶层不是 JSON 对象");
  }

  const ct = getCharacterTable();
  const records: SkillSearchRecord[] = [];
  for (const [opName, charId] of nameToCharId()) {
    const info = ct[charId] ?? {};
    for (const ref of Array.isArray(info.skills) ? info.skills : []) {
      const skillId = ref?.skillId;
      const entry = skillId ? table[skillId] : undefined;
      if (typeof entry !== "object" || entry === null) continue;
      const levels = skillLevels(entry);
      if (levels.length === 0) continue;
      const top = levels[levels.length - 1]!;
      records.push({
        operator: opName,
        skill: top.name || levels[0]!.name,
        text: top.description,
        haystack: levels.map((lv) => `${lv.name} ${lv.description}`).join(" "),
      });
    }
  }
  return records;
}

export function buildSkillSearch(pattern: string, maxResults = 30): SkillSearchPayload | string {
  const boundsError = validateBounds("max_results", maxResults, { minimum: 1, maximum: 100 });
  if (boundsError !== null) return boundsError;

  const cfg = loadConfig();
  if (!hasOperatorData(cfg)) return skillAccess.missingMessage();

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "iu");
  } catch (exc) {
    return regexErrorMessage(exc);
  }

  const results: SkillSearchRecord[] = [];
  let records: SkillSearchRecord[];
  try {
    records = getSkillSearchRecords();
  } catch (err) {
    // Same degrade-to-message contract as the sibling scopes.
    return err instanceof Error ? err.message : String(err);
  }
  // Haystack = per-level skill names + rendered descriptions across all
  // levels; results display the highest-level effect line.
  for (const record of records) {
    if (regex.test(record.haystack)) {
      results.push(record);
      if (results.length >= maxResults) break;
    }
  }

  return {
    scope: "skills",
    pattern,
    total: results.length,
    results: results.map((r) => ({ operator: r.operator, skill: r.skill, text: r.text })),
  };
}

export function renderSkillSearch(data: SkillSearchPayload): string {
  const { pattern, results } = data;
  if (results.length === 0) return `未找到匹配 '${pattern}' 的干员战斗技能。`;

  const lines: string[] = [`# 搜索 "${pattern}" 的结果（共 ${data.total} 条）`];
  for (const r of data.results) {
    lines.push(`- **${r.operator}**｜${r.skill}：${r.text}`);
  }
  return lines.join("\n");
}
