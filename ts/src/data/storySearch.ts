/**
 * Full-text search across story dialogue, narration, and choice lines.
 *
 * Split from story.ts. Builds a lazily-cached search index over all story
 * chapters and provides regex search with filtering by speaker, line type,
 * and event scope.
 * Mirrors python/src/prts_mcp/data/story_search.py.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { DirectoryStore, type JsonStore, ZipStore } from "./stores.js";
import {
  type StoryLine,
  STORY_REVIEW_TABLE,
  isMemoirEvent,
  readStoryFromStore,
  storyStore,
  withStoryStore,
  type RawReviewTable,
} from "./storyReader.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface StorySearchChapter {
  eventId: string;
  storyKey: string;
  storyCode: string;
  storyName: string;
  lines: StoryLine[];
}

interface StorySearchRecord {
  chapterIndex: number;
  lineIndex: number;
  line: StoryLine;
}

export interface StorySearchIndex {
  eventIds: Set<string>;
  chapters: StorySearchChapter[];
  records: StorySearchRecord[];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let storySearchCache:
  | { descriptor: string; index: StorySearchIndex }
  | null = null;

export function clearSearchCache(): void {
  storySearchCache = null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const VALID_LINE_TYPES = new Set(["dialog", "narration", "choice"]);

function formatStoryLine(line: StoryLine): string {
  if (line.type === "dialog") {
    return `${line.role ?? "（旁白）"}：${line.text}`;
  } else if (line.type === "narration") {
    return `*${line.text}*`;
  } else {
    return `【选项】${line.text}`;
  }
}

// ---------------------------------------------------------------------------
// Public API — zip-path wrapper
// ---------------------------------------------------------------------------

export function searchStories(
  zipPath: string,
  pattern: string,
  character?: string,
  lineType?: string,
  contextLines = 1,
  maxResults = 30,
  eventId?: string,
): string {
  return withStoryStore(zipPath, (store) => searchStoriesFromStore(
    store,
    pattern,
    character,
    lineType,
    contextLines,
    maxResults,
    eventId,
  ));
}

interface SearchResult {
  eventId: string;
  storyCode: string;
  lineNumber: number;
  context: string;
}

// ---------------------------------------------------------------------------
// Public API — store-based
// ---------------------------------------------------------------------------

export function searchStoriesFromStore(
  store: JsonStore,
  pattern: string,
  character?: string,
  lineType?: string,
  contextLines = 1,
  maxResults = 30,
  eventId?: string,
): string {
  if (maxResults < 1) return "max_results 必须 >= 1。";
  if (maxResults > 100) return "max_results 必须 <= 100。";
  if (contextLines < 0) return "context_lines 必须 >= 0。";
  if (contextLines > 5) return "context_lines 必须 <= 5。";

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (exc) {
    return `正则表达式无效：${exc instanceof Error ? exc.message : String(exc)}`;
  }

  if (lineType !== undefined && !VALID_LINE_TYPES.has(lineType)) {
    const valid = Array.from(VALID_LINE_TYPES).sort().join(", ");
    return `无效的 line_type：${JSON.stringify(lineType)}，可选值：${valid}`;
  }

  let index: StorySearchIndex;
  try {
    index = storySearchIndex(store);
  } catch (exc) {
    return `读取剧情数据索引失败：${exc instanceof Error ? exc.message : String(exc)}`;
  }

  if (eventId !== undefined && !index.eventIds.has(eventId)) {
    return `未找到匹配的活动：${JSON.stringify(eventId)}。`;
  }

  const results: SearchResult[] = [];

  for (const record of index.records) {
    if (results.length >= maxResults) break;
    const chapter = index.chapters[record.chapterIndex];
    const line = record.line;

    if (eventId !== undefined && chapter.eventId !== eventId) continue;
    if (character !== undefined) {
      if (line.type !== "dialog" || (line.role ?? "").toLowerCase() !== character.toLowerCase()) {
        continue;
      }
    }
    if (lineType !== undefined && line.type !== lineType) continue;
    if (!regex.test(line.text)) continue;

    const start = Math.max(0, record.lineIndex - contextLines);
    const end = Math.min(chapter.lines.length, record.lineIndex + contextLines + 1);
    const ctxParts: string[] = [];
    for (let j = start; j < end; j++) {
      const prefix = j === record.lineIndex ? ">>> " : "    ";
      ctxParts.push(prefix + formatStoryLine(chapter.lines[j]));
    }

    results.push({
      eventId: chapter.eventId,
      storyCode: chapter.storyCode,
      lineNumber: record.lineIndex + 1,
      context: ctxParts.join("\n"),
    });
  }

  if (results.length === 0) {
    const filters: string[] = [];
    if (eventId) filters.push(`event_id=${JSON.stringify(eventId)}`);
    if (character) filters.push(`character=${JSON.stringify(character)}`);
    if (lineType) filters.push(`line_type=${JSON.stringify(lineType)}`);
    const filterSuffix = filters.length > 0 ? `（过滤条件：${filters.join("。")}）` : "";
    return `未找到匹配 '${pattern}' 的剧情台词。${filterSuffix}`;
  }

  const parts: string[] = [`# 搜索 "${pattern}" 的结果（共 ${results.length} 条）`];
  for (const r of results) {
    parts.push(
      `\n---\n\n[stories/${r.eventId}/${r.storyCode} L${r.lineNumber}]\n${r.context}`
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Index building + caching
// ---------------------------------------------------------------------------

export function storySearchIndex(store: JsonStore): StorySearchIndex {
  const descriptor = storyStoreDescriptor(store);
  if (descriptor !== null && storySearchCache?.descriptor === descriptor) {
    return storySearchCache.index;
  }
  const index = buildStorySearchIndex(store);
  if (descriptor !== null) storySearchCache = { descriptor, index };
  return index;
}

function storyStoreDescriptor(store: JsonStore): string | null {
  if (store instanceof ZipStore) {
    const stat = statSync(store.zipPath, { bigint: true });
    return `zip:${store.zipPath}:${stat.size}:${stat.mtimeNs}`;
  }
  if (store instanceof DirectoryStore) {
    const review = join(store.root, STORY_REVIEW_TABLE);
    try {
      const stat = statSync(review, { bigint: true });
      return `directory:${store.root}:${stat.size}:${stat.mtimeNs}`;
    } catch {
      return null;
    }
  }
  return null;
}

function buildStorySearchIndex(store: JsonStore): StorySearchIndex {
  const table = store.readJson<RawReviewTable>(STORY_REVIEW_TABLE);
  const eventIds = new Set<string>();
  const chapters: StorySearchChapter[] = [];
  const records: StorySearchRecord[] = [];

  for (const [evId, entry] of Object.entries(table)) {
    const datas = (entry.infoUnlockDatas ?? []).slice();
    if (datas.length === 0) continue;
    // Only include NONE entries that are operator memoirs
    if ((entry.entryType ?? "NONE") === "NONE" && !isMemoirEvent(evId)) continue;
    eventIds.add(evId);
    datas.sort((a, b) => (a.storySort ?? 0) - (b.storySort ?? 0));
    for (const d of datas) {
      if (!d.storyTxt) continue;
      let chapter;
      try {
        chapter = readStoryFromStore(store, d.storyTxt, true);
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        if (err instanceof Error && /not found/i.test(err.message)) continue;
        throw err;
      }
      const chapterIndex = chapters.length;
      chapters.push({
        eventId: evId,
        storyKey: d.storyTxt ?? "",
        storyCode: d.storyCode ?? "",
        storyName: d.storyName ?? "",
        lines: chapter.lines,
      });
      for (let i = 0; i < chapter.lines.length; i++) {
        records.push({ chapterIndex, lineIndex: i, line: chapter.lines[i] });
      }
    }
  }

  return { eventIds, chapters, records };
}
