/**
 * Operator data reader — loads and formats game data from local JSON files.
 * Mirrors python/src/prts_mcp/data/operator.py.
 *
 * JSON files are large (character_table.json ~4 MB) so they are loaded
 * lazily on first call and cached in module-level variables.
 */

import { registerActivationListener } from "../activation.js";
import { hasOperatorData, loadConfig } from "../config.js";
import { stripWikitext } from "../utils/sanitizer.js";
import {
  buildingSkillsFor,
  hasBuildingData,
  type BuildingSkillPayload,
} from "./building.js";
import { clearSearchCaches } from "./search.js";
import type { CacheStat } from "../cacheStats.js";
import { defineDataset, excelStore, type DatasetAccess } from "./datasetAccess.js";
import { excelMissingMessage } from "./messages.js";

// ---------------------------------------------------------------------------
// Module-level lazy caches (dataset access contract)
// ---------------------------------------------------------------------------

// Config is NOT cached here: loadConfig() re-checks file existence on each
// call, so effectiveExcelPath correctly reflects data written by auto-sync
// after startup. The cost is negligible (env-var reads + existsSync calls).

export function clearOperatorCaches(): void {
  operatorAccess.clear();
  // The search-cache propagation rider lives in the dataset's onClear hook.
}

export function getCacheStats(): Record<string, CacheStat> {
  return operatorAccess.stats();
}

// ---------------------------------------------------------------------------
// JSON shape types (only the fields we actually use)
// ---------------------------------------------------------------------------

interface CharacterEntry {
  name?: string;
  appellation?: string;
  displayNumber?: string;
  description?: string;
  rarity?: string;
  profession?: string;
  subProfessionId?: string;
  position?: string;
  nationId?: string;
  groupId?: string;
  teamId?: string;
  tagList?: string[];
  itemUsage?: string;
  itemDesc?: string;
  itemObtainApproach?: string;
  talents?: TalentSlot[];
  skills?: Array<{ skillId?: string | null } | null>;
}

interface TalentCandidate {
  name?: string;
  description?: string;
  unlockCondition?: { phase?: string; level?: number } | null;
  requiredPotentialRank?: number | null;
}

interface TalentSlot {
  candidates?: TalentCandidate[];
}

const TALENT_PHASE_ZH: Record<string, string> = {
  PHASE_0: "精英0",
  PHASE_1: "精英1",
  PHASE_2: "精英2",
};

/** Project a talent slot's candidates into per-tier payloads.
 *
 * Pre-unlock placeholder candidates (`？？？`) are skipped, mirroring the
 * top-pick rule; order follows the raw table (later = stronger).
 */
function talentCandidates(slot: TalentSlot): OperatorTalentCandidatePayload[] {
  const out: OperatorTalentCandidatePayload[] = [];
  for (const c of Array.isArray(slot.candidates) ? slot.candidates : []) {
    const name = c.name ?? "";
    if (!name || name === "？？？") continue;
    const phase = c.unlockCondition?.phase ?? "";
    out.push({
      name,
      description: stripWikitext(c.description ?? ""),
      unlock: TALENT_PHASE_ZH[phase] ?? phase,
      potential_rank: c.requiredPotentialRank ?? 0,
    });
  }
  return out;
}

interface StoryEntry {
  storyTitle?: string;
  stories?: Array<{ storyText?: string }>;
}

interface HandbookEntry {
  storyTextAudio?: StoryEntry[];
}

interface HandbookTable {
  handbookDict?: Record<string, HandbookEntry>;
}

interface CharwordEntry {
  charId?: string;
  voiceTitle?: string;
  voiceText?: string;
}

interface CharwordTable {
  charWords?: Record<string, CharwordEntry>;
}

export interface OperatorTalentCandidatePayload {
  name: string;
  description: string;
  unlock: string;
  potential_rank: number;
}

export interface OperatorTalentPayload {
  name: string;
  description: string;
  candidates: OperatorTalentCandidatePayload[];
}

export interface OperatorBasicInfoPayload {
  name: string;
  display_number: string;
  appellation: string;
  rarity: string;
  rarity_raw: string;
  profession: string;
  profession_raw: string;
  sub_profession_id: string;
  position: string;
  position_raw: string;
  affiliation: string;
  tag_list: string[];
  attack_attribute: string | null;
  item_usage: string | null;
  item_desc: string | null;
  item_obtain: string | null;
  talents: OperatorTalentPayload[];
  // Omitted (not []) when building_data.json is absent so older
  // user-supplied data roots keep the pre-2.7.0 payload shape.
  building_skills?: BuildingSkillPayload[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function missingDataMessage(): string {
  return operatorAccess.missingMessage();
}

function loadJson<T>(filePath: string): T {
  const store = excelStore();
  if (!store.exists(filePath)) {
    throw new Error(
      `干员数据文件不存在：${store.resolveForDiagnostics(filePath)}。` +
        "数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向游戏数据根目录）。"
    );
  }
  return store.readJson<T>(filePath);
}

function getCharacterTableImpl(): Record<string, CharacterEntry> {
  return loadJson<Record<string, CharacterEntry>>("character_table.json");
}

function getHandbookTableImpl(): HandbookTable {
  return loadJson<HandbookTable>("handbook_info_table.json");
}

function getCharwordTableImpl(): CharwordTable {
  return loadJson<CharwordTable>("charword_table.json");
}

function buildNameToIdImpl(): Map<string, string> {
  const ct = getCharacterTable();
  return new Map(
    Object.entries(ct)
      .filter(([cid, info]) => info.name && cid.startsWith("char_"))
      .map(([cid, info]) => [info.name!, cid])
  );
}

const operatorAccess: DatasetAccess = defineDataset({
  name: "operator",
  loaders: {
    character_table: { load: getCharacterTableImpl },
    handbook_table: {
      load: getHandbookTableImpl,
      count: (r) => Object.keys((r as HandbookTable).handbookDict ?? {}).length,
    },
    charword_table: {
      load: getCharwordTableImpl,
      count: (r) => Object.keys((r as CharwordTable).charWords ?? {}).length,
    },
    name_to_id: {
      load: buildNameToIdImpl,
      count: (m) => (m as Map<string, string>).size,
    },
  },
  store: excelStore,
  available: () => hasOperatorData(loadConfig()),
  missingMessage: excelMissingMessage("干员"),
  // Lambda defers the operator↔search cycle to call time.
  onClear: () => clearSearchCaches(),
});

const getCharacterTable = operatorAccess.loader<Record<string, CharacterEntry>>("character_table");
const getHandbookTable = operatorAccess.loader<HandbookTable>("handbook_table");
const getCharwordTable = operatorAccess.loader<CharwordTable>("charword_table");
const buildNameToId = operatorAccess.loader<Map<string, string>>("name_to_id");

export { getCharacterTable, getHandbookTable, getCharwordTable };

export function resolveCharId(name: string): string | null {
  return buildNameToId().get(name) ?? null;
}

/**
 * Shared name→charId folding for the cross-operator search records
 * (mirrors PY `_build_name_to_id`): duplicate names collapse to the last
 * cid while keeping first-insertion position. Centralised here so the
 * sibling data modules don't re-implement the loop.
 */
export function nameToCharId(): Map<string, string> {
  return buildNameToId();
}

registerActivationListener(clearOperatorCaches);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return formatted archive text for an operator by Chinese name. */
export function getOperatorArchives(name: string): string {
  const cfg = loadConfig();
  if (!hasOperatorData(cfg)) return missingDataMessage();

  let charId: string | null;
  try {
    charId = resolveCharId(name);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (charId === null) {
    return `未找到干员 '${name}'。请使用游戏内中文名称（如'阿米娅'）。`;
  }

  let handbook: HandbookTable;
  try {
    handbook = getHandbookTable();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const entry = handbook.handbookDict?.[charId];
  if (!entry) return `干员 '${name}' 暂无档案数据。`;

  const sections: string[] = [];
  for (const story of Array.isArray(entry.storyTextAudio) ? entry.storyTextAudio : []) {
    const title = story.storyTitle ?? "";
    const texts = (Array.isArray(story.stories) ? story.stories : [])
      .map((s) => s.storyText ?? "")
      .filter(Boolean);
    if (texts.length > 0) {
      sections.push(`### ${title}\n` + texts.join("\n"));
    }
  }

  if (sections.length === 0) return `干员 '${name}' 档案内容为空。`;
  return `# ${name} - 干员档案\n\n` + sections.join("\n\n");
}

/** Return formatted voice-line text for an operator by Chinese name. */
export function getOperatorVoicelines(name: string): string {
  const cfg = loadConfig();
  if (!hasOperatorData(cfg)) return missingDataMessage();

  let charId: string | null;
  try {
    charId = resolveCharId(name);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (charId === null) {
    return `未找到干员 '${name}'。请使用游戏内中文名称（如'阿米娅'）。`;
  }

  let charwords: CharwordTable;
  try {
    charwords = getCharwordTable();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const lines: string[] = [];
  for (const entry of Object.values(charwords.charWords ?? {})) {
    if (entry.charId === charId && entry.voiceText) {
      const title = entry.voiceTitle ?? "未知";
      lines.push(`**${title}**: ${entry.voiceText}`);
    }
  }

  if (lines.length === 0) return `干员 '${name}' 暂无语音数据。`;
  return `# ${name} - 语音记录\n\n` + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Basic info
// ---------------------------------------------------------------------------

const PROFESSION_ZH: Record<string, string> = {
  CASTER: "术师",
  MEDIC: "医疗",
  PIONEER: "先锋",
  SNIPER: "狙击",
  SPECIAL: "特种",
  SUPPORT: "辅助",
  TANK: "重装",
  WARRIOR: "近卫",
};

const POSITION_ZH: Record<string, string> = {
  RANGED: "远程",
  MELEE: "近战",
  ALL: "通用",
  NONE: "-",
};

/** Return basic profile info for an operator by Chinese name. */
export function getOperatorBasicInfo(name: string): string {
  const data = buildOperatorBasicInfo(name);
  if (typeof data === "string") return data;
  return renderOperatorBasicInfo(data);
}

export function buildOperatorBasicInfo(name: string): OperatorBasicInfoPayload | string {
  const cfg = loadConfig();
  if (!hasOperatorData(cfg)) return missingDataMessage();

  let charId: string | null;
  try {
    charId = resolveCharId(name);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (charId === null) {
    return `未找到干员 '${name}'。请使用游戏内中文名称（如'阿米娅'）。`;
  }

  let ct: Record<string, CharacterEntry>;
  try {
    ct = getCharacterTable();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const info = ct[charId];
  if (!info) return `干员 '${name}' 暂无基本信息。`;

  const rarityRaw = info.rarity ?? "";
  const rarity = rarityRaw.startsWith("TIER_")
    ? rarityRaw.replace("TIER_", "") + "★"
    : rarityRaw;

  const profession = PROFESSION_ZH[info.profession ?? ""] ?? (info.profession ?? "");
  const position = POSITION_ZH[info.position ?? ""] ?? (info.position ?? "");

  const affiliationParts = [info.nationId, info.groupId, info.teamId].filter(Boolean) as string[];
  const affiliation = affiliationParts.length > 0 ? affiliationParts.join(" / ") : "-";

  // The top candidate stays the headline; per-tier candidates (unlock
  // phase + potential rank) ride along for structured consumers.
  const talents: OperatorTalentPayload[] = [];
  for (const slot of Array.isArray(info.talents) ? info.talents : []) {
    const tierCandidates = talentCandidates(slot);
    if (tierCandidates.length > 0) {
      const chosen = tierCandidates[tierCandidates.length - 1]!;
      talents.push({
        name: chosen.name,
        description: chosen.description,
        candidates: tierCandidates,
      });
    }
  }

  let buildingSkills: BuildingSkillPayload[] | undefined;
  if (hasBuildingData()) {
    try {
      buildingSkills = buildingSkillsFor(charId);
    } catch {
      // Missing or corrupt building_data.json degrades to the
      // pre-2.7.0 payload shape (mirrors getCharSkins' tolerance for
      // skin_table.json).
      buildingSkills = undefined;
    }
  }

  return {
    name,
    display_number: info.displayNumber ?? "",
    appellation: info.appellation ?? "",
    rarity,
    rarity_raw: rarityRaw,
    profession,
    profession_raw: info.profession ?? "",
    sub_profession_id: info.subProfessionId ?? "",
    position,
    position_raw: info.position ?? "",
    affiliation,
    tag_list: Array.isArray(info.tagList) ? info.tagList : [],
    attack_attribute: info.description ? stripWikitext(info.description) : null,
    item_usage: info.itemUsage || null,
    item_desc: info.itemDesc || null,
    item_obtain: info.itemObtainApproach || null,
    talents,
    ...(buildingSkills !== undefined ? { building_skills: buildingSkills } : {}),
  };
}

/** Compact unlock/potential annotation for one talent slot. */
function talentTierNote(candidates: OperatorTalentCandidatePayload[]): string {
  const phases = [...new Set(candidates.map((c) => c.unlock).filter(Boolean))];
  const parts: string[] = [];
  if (phases.length > 0) parts.push(`${phases[0]}解锁`);
  for (const phase of phases.slice(1)) parts.push(`${phase}强化`);
  const maxRank = Math.max(...candidates.map((c) => c.potential_rank ?? 0));
  // Number.isInteger mirrors the PY isinstance(max_rank, int) guard so a
  // hypothetical non-integer rank renders identically on both sides.
  if (Number.isInteger(maxRank) && maxRank > 0) parts.push(`潜能${maxRank}档强化`);
  return parts.length > 0 ? `（${parts.join("；")}）` : "";
}

export function renderOperatorBasicInfo(data: OperatorBasicInfoPayload): string {
  const lines: string[] = [`# ${data.name} - 干员基本信息\n`];
  lines.push(`- **编号**：${data.display_number}`);
  lines.push(`- **英文名**：${data.appellation}`);
  lines.push(`- **稀有度**：${data.rarity}`);
  lines.push(`- **职业**：${data.profession}（${data.sub_profession_id}）`);
  lines.push(`- **站位**：${data.position}`);
  lines.push(`- **所属**：${data.affiliation}`);
  if (data.tag_list.length > 0) {
    lines.push(`- **招募标签**：${data.tag_list.join("、")}`);
  }
  if (data.attack_attribute !== null) {
    lines.push(`- **攻击属性**：${data.attack_attribute}`);
  }
  if (data.item_usage) {
    lines.push(`\n**图鉴**：${data.item_usage}`);
  }
  if (data.item_desc) {
    lines.push(`\n> ${data.item_desc}`);
  }
  if (data.item_obtain) {
    lines.push(`\n**获取方式**：${data.item_obtain}`);
  }
  if (data.talents.length > 0) {
    lines.push("\n## 天赋");
    for (const talent of data.talents) {
      lines.push(`- **${talent.name}**：${talent.description}`);
      const note = talentTierNote(talent.candidates ?? []);
      if (note) lines.push(`  ${note}`);
    }
  }
  const buildingSkills = data.building_skills;
  if (buildingSkills !== undefined && buildingSkills.length > 0) {
    lines.push("\n## 基建技能");
    for (const skill of buildingSkills) {
      lines.push(
        `- **${skill.name}**（${skill.room}，${skill.unlock}解锁）：${skill.description}`,
      );
    }
  }
  return lines.join("\n");
}
