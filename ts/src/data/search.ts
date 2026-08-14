/**
 * Full-text search across operator data tables.
 * Mirrors python/src/prts_mcp/data/search.py.
 */

import { hasOperatorData, loadConfig } from "../config.js";
import { stripWikitext } from "../utils/sanitizer.js";
import {
  getCharacterTable,
  getHandbookTable,
  getCharwordTable,
} from "./operator.js";
import type { CacheStat } from "../cacheStats.js";
import { defineDataset, type DatasetAccess } from "./datasetAccess.js";
import { excelMissingMessage, regexErrorMessage, validateBounds } from "./messages.js";
import { buildEnemySearch, renderEnemySearch, type EnemySearchPayload } from "./enemy.js";
import { buildStageSearch, renderStageSearch, type StageSearchPayload } from "./stage.js";
import { buildItemSearch, renderItemSearch, type ItemSearchPayload } from "./item.js";

// Reuse types from operator.ts
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

interface OperatorSearchEntry {
  operator: string;
  category: string;
  field: string;
  text: string;
}

export interface OperatorSearchPayload {
  scope: "operators";
  pattern: string;
  total: number;
  results: OperatorSearchEntry[];
}

type SearchPayload =
  | OperatorSearchPayload
  | EnemySearchPayload
  | StageSearchPayload
  | ItemSearchPayload;

export function clearSearchCaches(): void {
  searchAccess.clear();
}

export function getCacheStats(): Record<string, CacheStat> {
  return searchAccess.stats();
}

export function searchOperatorData(pattern: string, maxResults = 30): string {
  const data = buildOperatorSearch(pattern, maxResults);
  if (typeof data === "string") return data;
  return renderOperatorSearch(data);
}

export function buildOperatorSearch(pattern: string, maxResults = 30): OperatorSearchPayload | string {
  const boundsError = validateBounds("max_results", maxResults, { minimum: 1, maximum: 100 });
  if (boundsError !== null) return boundsError;

  const cfg = loadConfig();
  if (!hasOperatorData(cfg)) return searchAccess.missingMessage();

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "iu");
  } catch (exc) {
    return regexErrorMessage(exc);
  }

  const results: OperatorSearchEntry[] = [];
  let records: OperatorSearchEntry[];
  try {
    records = getOperatorSearchRecords();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  for (const record of records) {
    if (regex.test(record.text)) {
      results.push(record);
      if (results.length >= maxResults) break;
    }
  }

  return {
    scope: "operators",
    pattern,
    total: results.length,
    results,
  };
}

export function renderOperatorSearch(data: OperatorSearchPayload): string {
  const { pattern, results } = data;
  if (results.length === 0) return `未找到匹配 '${pattern}' 的干员数据。`;

  const blocks: string[] = [`# 搜索 "${pattern}" 的结果（共 ${data.total} 条）`];
  for (const r of data.results) {
    blocks.push(
      `\n---\n\n[operators/${r.category}/${r.operator}]\n匹配：${r.field}\n${r.text}`
    );
  }

  return blocks.join("");
}

export function buildSearch(scope: string, pattern: string, maxResults = 30): SearchPayload | string {
  if (scope === "operators") return buildOperatorSearch(pattern, maxResults);
  if (scope === "enemies") return buildEnemySearch(pattern, maxResults);
  if (scope === "stages") return buildStageSearch(pattern, maxResults);
  if (scope === "items") return buildItemSearch(pattern, maxResults);
  return `不支持的搜索域：'${scope}'。可选：operators、enemies、stages、items。`;
}

export function renderSearch(data: SearchPayload): string {
  if (data.scope === "operators") return renderOperatorSearch(data);
  if (data.scope === "enemies") return renderEnemySearch(data);
  if (data.scope === "stages") return renderStageSearch(data);
  if (data.scope === "items") return renderItemSearch(data);
  throw new Error(`不支持的搜索域：${JSON.stringify((data as { scope?: unknown }).scope)}。`);
}

function getOperatorSearchRecordsImpl(): OperatorSearchEntry[] {
  const ct = getCharacterTable();
  const handbook = getHandbookTable();
  const charwords = getCharwordTable();

  const nameToId = new Map<string, string>();
  for (const [cid, info] of Object.entries(ct)) {
    if (info.name && cid.startsWith("char_")) nameToId.set(info.name, cid);
  }

  const charidToVoices = new Map<string, CharwordEntry[]>();
  for (const entry of Object.values(charwords.charWords ?? {})) {
    if (entry.charId && entry.voiceText) {
      const list = charidToVoices.get(entry.charId);
      if (list) list.push(entry);
      else charidToVoices.set(entry.charId, [entry]);
    }
  }

  const records: OperatorSearchEntry[] = [];
  for (const [name, charId] of nameToId) {
    const info = ct[charId];
    if (!info) continue;

    records.push({ operator: name, category: "basic", field: "干员名称", text: name });

    const desc = info.description ?? "";
    if (desc) {
      records.push({ operator: name, category: "basic", field: "攻击属性", text: stripWikitext(desc) });
    }

    const hbEntry = handbook.handbookDict?.[charId];
    if (hbEntry) {
      for (const story of hbEntry.storyTextAudio ?? []) {
        const title = story.storyTitle ?? "";
        for (const s of story.stories ?? []) {
          const text = s.storyText ?? "";
          if (text) records.push({ operator: name, category: "archives", field: title, text });
        }
      }
    }

    for (const v of charidToVoices.get(charId) ?? []) {
      records.push({
        operator: name,
        category: "voicelines",
        field: v.voiceTitle ?? "未知",
        text: v.voiceText!,
      });
    }
  }

  return records;
}

const searchAccess: DatasetAccess = defineDataset({
  name: "search",
  loaders: {
    search_records: { load: getOperatorSearchRecordsImpl },
  },
  missingMessage: excelMissingMessage("干员"),
});

const getOperatorSearchRecords = searchAccess.loader<OperatorSearchEntry[]>("search_records");
