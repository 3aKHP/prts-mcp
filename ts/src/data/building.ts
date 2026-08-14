/**
 * Base-skill (基建技能) data reader — building_data.json backed.
 * Mirrors python/src/prts_mcp/data/building.py. Deliberately dependency-free
 * beyond the dataset-access layer: operator and search consume this module,
 * so it must not import them (cycle hygiene).
 */
import { registerActivationListener } from "../activation.js";
import { hasOperatorData, loadConfig } from "../config.js";
import type { CacheStat } from "../cacheStats.js";
import { defineDataset, excelStore, type DatasetAccess } from "./datasetAccess.js";
import { excelMissingMessage, regexErrorMessage, validateBounds } from "./messages.js";
// operator.ts imports this module back; the cycle is safe because both
// sides only use each other's bindings inside function bodies.
import { getCharacterTable } from "./operator.js";

const ROOM_ZH: Record<string, string> = {
  CONTROL: "控制中枢",
  POWER: "发电站",
  MANUFACTURE: "制造站",
  TRADING: "贸易站",
  WORKSHOP: "加工站",
  TRAINING: "训练室",
  DORMITORY: "宿舍",
  HIRE: "人力办公室",
  MEETING: "会客室",
};

const PHASE_ZH: Record<string, string> = {
  PHASE_0: "精英0",
  PHASE_1: "精英1",
  PHASE_2: "精英2",
};

export interface BuildingSkillPayload {
  name: string;
  room: string;
  description: string;
  unlock: string;
}

interface BuffData {
  buffId?: string;
  cond?: { phase?: string };
}

interface BuffCharSlot {
  buffData?: BuffData[];
}

interface BuildingChar {
  buffChar?: BuffCharSlot[];
}

interface BuildingBuff {
  buffName?: string;
  roomType?: string;
  description?: string;
}

interface BuildingTable {
  chars?: Record<string, BuildingChar>;
  buffs?: Record<string, BuildingBuff>;
}

export function clearBuildingCaches(): void {
  buildingAccess.clear();
}

export function getCacheStats(): Record<string, CacheStat> {
  return buildingAccess.stats();
}

function getBuildingTableImpl(): BuildingTable {
  const store = excelStore();
  const filePath = "building_data.json";
  if (!store.exists(filePath)) {
    throw new Error(
      `基建技能数据文件不存在：${store.resolveForDiagnostics(filePath)}。` +
        "数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向游戏数据根目录）。"
    );
  }
  return store.readJson<BuildingTable>(filePath);
}

const buildingAccess: DatasetAccess = defineDataset({
  name: "building",
  loaders: {
    building_table: {
      load: getBuildingTableImpl,
      count: (r) => Object.keys((r as BuildingTable).buffs ?? {}).length,
    },
    building_skill_records: { load: getBuildingSkillRecordsImpl },
  },
  store: excelStore,
  available: () => hasOperatorData(loadConfig()),
  missingMessage: excelMissingMessage("基建技能"),
});

const getBuildingTable = buildingAccess.loader<BuildingTable>("building_table");
const getBuildingSkillRecords = buildingAccess.loader<BuildingSkillRecord[]>("building_skill_records");

registerActivationListener(clearBuildingCaches);

/** Whether building_data.json exists in the effective excel store. */
export function hasBuildingData(): boolean {
  return excelStore().exists("building_data.json");
}

function cleanDescription(desc: string): string {
  if (!desc) return "";
  return desc.replace(/<[^>]+>/g, "").trim();
}

function phaseRank(buffData: BuffData): number {
  const phase = buffData.cond?.phase ?? "";
  const n = Number.parseInt(phase.replace("PHASE_", ""), 10);
  return Number.isNaN(n) ? -1 : n;
}

/** Return an operator's base skills, highest phase per buff slot. */
export function buildingSkillsFor(charId: string): BuildingSkillPayload[] {
  const table = getBuildingTable();
  const chars = table.chars ?? {};
  const buffs = table.buffs ?? {};
  const entry = chars[charId];
  const skills: BuildingSkillPayload[] = [];
  for (const slot of Array.isArray(entry?.buffChar) ? entry!.buffChar! : []) {
    // A slot's buffData lists per-elite-phase variants of the same
    // skill; keep only the highest phase (lower ones are weaker).
    let best: BuffData | undefined;
    for (const buffData of Array.isArray(slot.buffData) ? slot.buffData : []) {
      if (best === undefined || phaseRank(buffData) > phaseRank(best)) {
        best = buffData;
      }
    }
    if (best === undefined) continue;
    const buff = buffs[best.buffId ?? ""];
    if (!buff) continue;
    const roomRaw = buff.roomType ?? "";
    const phase = best.cond?.phase ?? "";
    skills.push({
      name: buff.buffName ?? "",
      room: ROOM_ZH[roomRaw] ?? roomRaw,
      description: cleanDescription(buff.description ?? ""),
      unlock: PHASE_ZH[phase] ?? phase,
    });
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Cross-operator search (search tool's building_skills scope)
// ---------------------------------------------------------------------------

interface BuildingSkillRecord {
  operator: string;
  skill: string;
  room: string;
  unlock: string;
  text: string;
}

export interface BuildingSkillSearchPayload {
  scope: "building_skills";
  pattern: string;
  total: number;
  results: BuildingSkillRecord[];
}

function getBuildingSkillRecordsImpl(): BuildingSkillRecord[] {
  const ct = getCharacterTable();

  const records: BuildingSkillRecord[] = [];
  try {
    for (const [cid, info] of Object.entries(ct)) {
      if (!info.name || !cid.startsWith("char_")) continue;
      for (const s of buildingSkillsFor(cid)) {
        records.push({
          operator: info.name,
          skill: s.name,
          room: s.room,
          unlock: s.unlock,
          text: s.description,
        });
      }
    }
  } catch (err) {
    // Older user-supplied data roots may lack building_data.json; the
    // scope then reports no matches rather than a data error.
    if (err instanceof Error && err.message.startsWith("基建技能数据文件不存在")) {
      return [];
    }
    throw err;
  }
  return records;
}

export function buildBuildingSkillSearch(pattern: string, maxResults = 30): BuildingSkillSearchPayload | string {
  const boundsError = validateBounds("max_results", maxResults, { minimum: 1, maximum: 100 });
  if (boundsError !== null) return boundsError;

  const cfg = loadConfig();
  if (!hasOperatorData(cfg)) return buildingAccess.missingMessage();

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "iu");
  } catch (exc) {
    return regexErrorMessage(exc);
  }

  const results: BuildingSkillRecord[] = [];
  for (const record of getBuildingSkillRecords()) {
    if (regex.test(`${record.skill} ${record.room} ${record.text}`)) {
      results.push(record);
      if (results.length >= maxResults) break;
    }
  }

  return {
    scope: "building_skills",
    pattern,
    total: results.length,
    results,
  };
}

export function renderBuildingSkillSearch(data: BuildingSkillSearchPayload): string {
  const { pattern, results } = data;
  if (results.length === 0) return `未找到匹配 '${pattern}' 的干员基建技能。`;

  const lines: string[] = [`# 搜索 "${pattern}" 的结果（共 ${data.total} 条）`];
  for (const r of data.results) {
    lines.push(
      `- **${r.operator}**｜${r.skill}（${r.room}，${r.unlock}解锁）：${r.text}`,
    );
  }
  return lines.join("\n");
}
