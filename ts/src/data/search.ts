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
  resolveCharId,
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

export function searchOperatorData(pattern: string, maxResults = 30): string {
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

  let ct: Record<string, { name?: string; description?: string }>;
  let handbook: HandbookTable;
  let charwords: CharwordTable;
  try {
    ct = getCharacterTable();
    handbook = getHandbookTable();
    charwords = getCharwordTable();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  // Build name → id and charId → voice entries index
  const nameToId = new Map<string, string>();
  for (const [cid, info] of Object.entries(ct)) {
    if (info.name) nameToId.set(info.name, cid);
  }

  const charidToVoices = new Map<string, CharwordEntry[]>();
  for (const entry of Object.values(charwords.charWords ?? {})) {
    if (entry.charId && entry.voiceText) {
      const list = charidToVoices.get(entry.charId);
      if (list) {
        list.push(entry);
      } else {
        charidToVoices.set(entry.charId, [entry]);
      }
    }
  }

  const results: SearchResult[] = [];

  for (const [name, charId] of nameToId) {
    if (results.length >= maxResults) break;
    const info = ct[charId];
    if (!info) continue;

    // --- basic: operator name ---
    if (regex.test(name)) {
      results.push({ operator: name, category: "basic", field: "干员名称", text: name });
      if (results.length >= maxResults) break;
    }

    // --- basic: description ---
    const desc = info.description ?? "";
    if (desc) {
      const cleaned = stripWikitext(desc);
      if (regex.test(cleaned)) {
        results.push({ operator: name, category: "basic", field: "攻击属性", text: cleaned });
        if (results.length >= maxResults) break;
      }
    }

    // --- archives ---
    const hbEntry = handbook.handbookDict?.[charId];
    if (hbEntry) {
      for (const story of hbEntry.storyTextAudio ?? []) {
        if (results.length >= maxResults) break;
        const title = story.storyTitle ?? "";
        for (const s of story.stories ?? []) {
          if (results.length >= maxResults) break;
          const text = s.storyText ?? "";
          if (text && regex.test(text)) {
            results.push({ operator: name, category: "archives", field: title, text });
          }
        }
      }
    }

    // --- voicelines ---
    const voices = charidToVoices.get(charId);
    if (voices) {
      for (const v of voices) {
        if (results.length >= maxResults) break;
        if (regex.test(v.voiceText!)) {
          results.push({
            operator: name,
            category: "voicelines",
            field: v.voiceTitle ?? "未知",
            text: v.voiceText!,
          });
        }
      }
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
