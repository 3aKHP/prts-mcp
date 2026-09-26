/**
 * Full-text search across operator data tables.
 * Mirrors python/src/prts_mcp/data/search.py.
 */

import { loadConfig, hasOperatorData } from "../config.js";
import { stripWikitext } from "../utils/sanitizer.js";
import {
  getCharacterTable,
  getHandbookTable,
  getCharwordTable,
} from "./operator.js";

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

interface SearchResult {
  operator: string;
  category: string;
  field: string;
  text: string;
}

let operatorSearchRecords: SearchResult[] | null = null;

export function clearSearchCaches(): void {
  operatorSearchRecords = null;
}

export function searchOperatorData(pattern: string, maxResults = 30): string {
  if (maxResults < 1) return "max_results 必须 >= 1。";
  if (maxResults > 100) return "max_results 必须 <= 100。";

  const cfg = loadConfig();
  if (!hasOperatorData(cfg)) {
    return (
      "干员数据暂不可用。" +
      "容器启动时的 auto-sync 可能仍在进行中，请稍后重试；" +
      "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。" +
      `（当前同步目标路径：${cfg.excelPath}）`
    );
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (exc) {
    return `正则表达式无效：${exc instanceof Error ? exc.message : String(exc)}`;
  }

  const results: SearchResult[] = [];
  let records: SearchResult[];
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

  if (results.length === 0) {
    return `未找到匹配 '${pattern}' 的干员数据。`;
  }

  const blocks: string[] = [`# 搜索 "${pattern}" 的结果（共 ${results.length} 条）`];
  for (const r of results) {
    blocks.push(
      `\n---\n\n[operators/${r.category}/${r.operator}]\n匹配：${r.field}\n${r.text}`
    );
  }

  return blocks.join("");
}

function getOperatorSearchRecords(): SearchResult[] {
  if (operatorSearchRecords !== null) return operatorSearchRecords;

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

  const records: SearchResult[] = [];
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
      for (const story of Array.isArray(hbEntry.storyTextAudio) ? hbEntry.storyTextAudio : []) {
        const title = story.storyTitle ?? "";
        for (const s of Array.isArray(story.stories) ? story.stories : []) {
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

  operatorSearchRecords = records;
  return records;
}
