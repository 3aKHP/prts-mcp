/**
 * Operator data reader — loads and formats game data from local JSON files.
 * Mirrors python/src/prts_mcp/data/operator.py.
 *
 * JSON files are large (character_table.json ~4 MB) so they are loaded
 * lazily on first call and cached in module-level variables.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, hasOperatorData, type Config } from "../config.js";

// ---------------------------------------------------------------------------
// Module-level lazy caches
// ---------------------------------------------------------------------------

let _config: Config | null = null;

function getConfig(): Config {
  if (_config === null) _config = loadConfig();
  return _config;
}

// Raw table caches — null means "not yet loaded", undefined means "failed".
type TableCache<T> = T | null | undefined;

let _characterTable: TableCache<Record<string, CharacterEntry>> = null;
let _handbookTable: TableCache<HandbookTable> = null;
let _charwordTable: TableCache<CharwordTable> = null;
let _nameToId: Map<string, string> | null = null;

// ---------------------------------------------------------------------------
// JSON shape types (only the fields we actually use)
// ---------------------------------------------------------------------------

interface CharacterEntry {
  name?: string;
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function missingDataMessage(): string {
  const cfg = getConfig();
  return (
    "干员数据暂不可用。" +
    "容器启动时的 auto-sync 可能仍在进行中，请稍后重试；" +
    "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。" +
    `（当前同步目标路径：${cfg.excelPath}）`
  );
}

function loadJson<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(
      `干员数据文件不存在：${filePath}。` +
        "数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向 ArknightsGameData 仓库根目录）。"
    );
  }
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function excelFile(name: string): string {
  const ep = getConfig().effectiveExcelPath;
  if (ep === null) throw new Error("effectiveExcelPath is null");
  return join(ep, name);
}

function getCharacterTable(): Record<string, CharacterEntry> {
  if (_characterTable === null) {
    _characterTable = loadJson<Record<string, CharacterEntry>>(
      excelFile("character_table.json")
    );
  }
  if (_characterTable === undefined) throw new Error("character_table failed");
  return _characterTable;
}

function getHandbookTable(): HandbookTable {
  if (_handbookTable === null) {
    _handbookTable = loadJson<HandbookTable>(
      excelFile("handbook_info_table.json")
    );
  }
  if (_handbookTable === undefined) throw new Error("handbook_table failed");
  return _handbookTable;
}

function getCharwordTable(): CharwordTable {
  if (_charwordTable === null) {
    _charwordTable = loadJson<CharwordTable>(excelFile("charword_table.json"));
  }
  if (_charwordTable === undefined) throw new Error("charword_table failed");
  return _charwordTable;
}

function resolveCharId(name: string): string | null {
  if (_nameToId === null) {
    const ct = getCharacterTable();
    _nameToId = new Map(
      Object.entries(ct)
        .filter(([, info]) => info.name)
        .map(([cid, info]) => [info.name!, cid])
    );
  }
  return _nameToId.get(name) ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return formatted archive text for an operator by Chinese name. */
export function getOperatorArchives(name: string): string {
  const cfg = getConfig();
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
  for (const story of entry.storyTextAudio ?? []) {
    const title = story.storyTitle ?? "";
    const texts = (story.stories ?? [])
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
  const cfg = getConfig();
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
