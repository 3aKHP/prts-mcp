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
}

interface TalentCandidate {
  name?: string;
  description?: string;
}

interface TalentSlot {
  candidates?: TalentCandidate[];
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

export interface OperatorTalentPayload {
  name: string;
  description: string;
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

  const talents: OperatorTalentPayload[] = [];
  for (const slot of Array.isArray(info.talents) ? info.talents : []) {
    const candidates = Array.isArray(slot.candidates) ? slot.candidates : [];
    let chosen: TalentCandidate | undefined;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if (c.name && c.name !== "？？？") {
        chosen = c;
        break;
      }
    }
    if (chosen) {
      talents.push({
        name: chosen.name ?? "",
        description: stripWikitext(chosen.description ?? ""),
      });
    }
  }

  const buildingSkills: BuildingSkillPayload[] | undefined = hasBuildingData()
    ? buildingSkillsFor(charId)
    : undefined;

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
