/**
 * Story data reader for PRTS-MCP (TypeScript).
 *
 * Reads from the bundled/synced zh_CN.zip (ArknightsStoryJson fork release).
 * Mirrors python/src/prts_mcp/data/story.py.
 *
 * Zip internal layout (all paths prefixed with "zh_CN/"):
 *   zh_CN/storyinfo.json                          — {story_key: summary_text}
 *   zh_CN/gamedata/excel/story_review_table.json  — event metadata + ordered chapter list
 *   zh_CN/gamedata/story/{story_key}.json         — per-chapter dialogue JSON
 */

import { JsonStore, ZipStore } from "./stores.js";

// ---------------------------------------------------------------------------
// Zip path constants
// ---------------------------------------------------------------------------

const STORY_REVIEW_TABLE = "zh_CN/gamedata/excel/story_review_table.json";

function storyZipPath(storyKey: string): string {
  return `zh_CN/gamedata/story/${storyKey}.json`;
}

// entryType → category filter mapping (mirrors Python _CATEGORY_MAP)
const CATEGORY_MAP: Record<string, string[]> = {
  main: ["MAINLINE"],
  activities: ["ACTIVITY", "MINI_ACTIVITY"],
};

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

const RICH_TAG_RE = /<[^>]+>/g;

function cleanText(text: string): string {
  return text.replace(/\{@nickname\}/g, "博士").replace(RICH_TAG_RE, "").trim();
}

// ---------------------------------------------------------------------------
// JSON shape types (only fields we use)
// ---------------------------------------------------------------------------

interface RawStoryItem {
  prop?: string;
  attributes?: Record<string, unknown>;
}

interface RawStoryChapter {
  storyCode?: string;
  storyName?: string;
  avgTag?: string | null;
  eventName?: string;
  storyInfo?: string;
  storyList?: RawStoryItem[];
}

interface RawInfoUnlockData {
  storyTxt?: string;
  storyCode?: string;
  storyName?: string;
  avgTag?: string | null;
  storySort?: number;
}

interface RawReviewEntry {
  id?: string;
  name?: string;
  entryType?: string;
  infoUnlockDatas?: RawInfoUnlockData[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StoryLine {
  type: "dialog" | "narration" | "choice";
  role: string | null;
  text: string;
}

export interface StoryChapter {
  storyKey: string;
  storyCode: string;
  storyName: string;
  avgTag: string | null;
  eventName: string;
  storyInfo: string;
  lines: StoryLine[];
}

export interface EventInfo {
  eventId: string;
  name: string;
  entryType: string;
  storyCount: number;
}

export interface ChapterSummary {
  storyKey: string;
  storyCode: string;
  storyName: string;
  avgTag: string | null;
  sortOrder: number;
}

export interface ActivityResult {
  eventId: string;
  eventName: string;
  totalChapters: number;
  hasMore: boolean;
  chapters: StoryChapter[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function storyStore(zipPath: string): ZipStore {
  return new ZipStore(zipPath);
}

function parseStoryList(
  storyList: RawStoryItem[],
  includeNarration: boolean
): StoryLine[] {
  const lines: StoryLine[] = [];
  for (const item of storyList) {
    const prop = (item.prop ?? "").toLowerCase();
    const attrs = (item.attributes ?? {}) as Record<string, unknown>;

    if (prop === "name") {
      const name = String(attrs["name"] ?? "");
      const content = String(attrs["content"] ?? "");
      if (content && (includeNarration || name)) {
        lines.push({
          type: "dialog",
          role: name ? cleanText(name) : null,
          text: cleanText(content),
        });
      }
    } else if (
      includeNarration &&
      (prop === "sticker" || prop === "subtitle" || prop === "animtext")
    ) {
      // Sticker uses "text" OR "content" field — check both (see porting guide §4.2)
      const content = String(attrs["content"] ?? attrs["text"] ?? "");
      if (content) {
        lines.push({ type: "narration", role: null, text: cleanText(content) });
      }
    } else if (prop === "decision") {
      const options = attrs["options"];
      if (Array.isArray(options)) {
        for (const opt of options) {
          let text = "";
          if (typeof opt === "string") text = opt;
          else if (opt !== null && typeof opt === "object") {
            text = String((opt as Record<string, unknown>)["text"] ?? "");
          }
          if (text) {
            lines.push({ type: "choice", role: null, text: cleanText(text) });
          }
        }
      }
    }
    // All other props (Dialog, Background, PlayMusic, etc.) are skipped.
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a list of events from story_review_table.json.
 *
 * @param zipPath  Absolute path to zh_CN.zip.
 * @param category Optional filter — "main" or "activities".
 */
export function listStoryEvents(
  zipPath: string,
  category?: string
): EventInfo[] {
  return listStoryEventsFromStore(storyStore(zipPath), category);
}

export function listStoryEventsFromStore(
  store: JsonStore,
  category?: string
): EventInfo[] {
  const allowedTypes = category ? (CATEGORY_MAP[category] ?? null) : null;
  const table = store.readJson<Record<string, RawReviewEntry>>(
    STORY_REVIEW_TABLE
  );

  const events: EventInfo[] = [];
  for (const [eventId, entry] of Object.entries(table)) {
    const entryType = entry.entryType ?? "NONE";
    if (allowedTypes !== null && !allowedTypes.includes(entryType)) continue;
    events.push({
      eventId,
      name: entry.name ?? eventId,
      entryType,
      storyCount: (entry.infoUnlockDatas ?? []).length,
    });
  }
  return events;
}

/**
 * Return ordered chapter list for an event.
 *
 * @param zipPath  Absolute path to zh_CN.zip.
 * @param eventId  Event key, e.g. "act31side".
 * @throws Error if eventId is not found in story_review_table.
 */
export function listStories(
  zipPath: string,
  eventId: string
): ChapterSummary[] {
  return listStoriesFromStore(storyStore(zipPath), eventId);
}

export function listStoriesFromStore(
  store: JsonStore,
  eventId: string
): ChapterSummary[] {
  const table = store.readJson<Record<string, RawReviewEntry>>(
    STORY_REVIEW_TABLE
  );

  const entry = table[eventId];
  if (!entry) throw new Error(`Event not found: "${eventId}"`);

  const datas = (entry.infoUnlockDatas ?? []).slice();
  datas.sort((a, b) => (a.storySort ?? 0) - (b.storySort ?? 0));

  const chapters: ChapterSummary[] = [];
  for (const d of datas) {
    if (!d.storyTxt) continue;
    chapters.push({
      storyKey: d.storyTxt,
      storyCode: d.storyCode ?? "",
      storyName: d.storyName ?? "",
      avgTag: d.avgTag ?? null,
      sortOrder: d.storySort ?? 0,
    });
  }
  return chapters;
}

/**
 * Read and parse a single story chapter from the zip.
 *
 * @param zipPath         Absolute path to zh_CN.zip.
 * @param storyKey        Story key from storyTxt / storyinfo.json.
 * @param includeNarration Whether to include narration/scene lines (default true).
 * @throws Error if the story file is not found in the zip.
 */
export function readStory(
  zipPath: string,
  storyKey: string,
  includeNarration = true
): StoryChapter {
  return readStoryFromStore(storyStore(zipPath), storyKey, includeNarration);
}

export function readStoryFromStore(
  store: JsonStore,
  storyKey: string,
  includeNarration = true
): StoryChapter {
  const innerPath = storyZipPath(storyKey);
  if (!store.exists(innerPath)) {
    throw new Error(`Story not found in store: "${storyKey}"`);
  }
  const raw = store.readJson<RawStoryChapter>(innerPath);

  const lines = parseStoryList(raw.storyList ?? [], includeNarration);

  return {
    storyKey,
    storyCode: raw.storyCode ?? "",
    storyName: raw.storyName ?? "",
    avgTag: raw.avgTag ?? null,
    eventName: raw.eventName ?? "",
    storyInfo: raw.storyInfo ?? "",
    lines,
  };
}

/**
 * Read all chapters of an activity in official story order.
 *
 * @param zipPath         Absolute path to zh_CN.zip.
 * @param eventId         Event key, e.g. "act31side".
 * @param includeNarration Whether to include narration lines (default true).
 * @param page            1-based page index. undefined = return all chapters.
 * @param pageSize        Chapters per page when page is set (default 5).
 * @throws Error if eventId is not found.
 */
export function readActivity(
  zipPath: string,
  eventId: string,
  includeNarration = true,
  page?: number,
  pageSize = 5
): ActivityResult {
  return readActivityFromStore(
    storyStore(zipPath),
    eventId,
    includeNarration,
    page,
    pageSize,
  );
}

export function readActivityFromStore(
  store: JsonStore,
  eventId: string,
  includeNarration = true,
  page?: number,
  pageSize = 5
): ActivityResult {
  const summaries = listStoriesFromStore(store, eventId);
  const total = summaries.length;

  let selected: ChapterSummary[];
  let hasMore: boolean;
  if (page !== undefined) {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    selected = summaries.slice(start, end);
    hasMore = end < total;
  } else {
    selected = summaries;
    hasMore = false;
  }

  const chapters: StoryChapter[] = [];
  let eventName = "";
  for (const summary of selected) {
    try {
      const chapter = readStoryFromStore(store, summary.storyKey, includeNarration);
      if (!eventName) eventName = chapter.eventName;
      chapters.push(chapter);
    } catch (error) {
      console.warn(`Skipping unreadable chapter "${summary.storyKey}":`, error);
    }
  }

  return { eventId, eventName, totalChapters: total, hasMore, chapters };
}

// ---------------------------------------------------------------------------
// Search helpers
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

/**
 * Search story text across all events (or a single event).
 *
 * Convenience wrapper around searchStoriesFromStore that auto-creates
 * a ZipStore from *zipPath*.
 */
export function searchStories(
  zipPath: string,
  pattern: string,
  character?: string,
  lineType?: string,
  contextLines = 1,
  maxResults = 30,
  eventId?: string,
): string {
  return searchStoriesFromStore(
    new ZipStore(zipPath),
    pattern,
    character,
    lineType,
    contextLines,
    maxResults,
    eventId,
  );
}

interface SearchResult {
  eventId: string;
  storyCode: string;
  lineNumber: number;
  context: string;
}

/**
 * Full-text search across story dialogue, narration and choice lines.
 */
export function searchStoriesFromStore(
  store: JsonStore,
  pattern: string,
  character?: string,
  lineType?: string,
  contextLines = 1,
  maxResults = 30,
  eventId?: string,
): string {
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

  let table: Record<string, RawReviewEntry>;
  try {
    table = store.readJson<Record<string, RawReviewEntry>>(STORY_REVIEW_TABLE);
  } catch (exc) {
    return `读取剧情数据索引失败：${exc instanceof Error ? exc.message : String(exc)}`;
  }

  // Build active event list, excluding NONE entries
  const activeEvents: Array<[string, RawReviewEntry]> = [];
  for (const [evId, entry] of Object.entries(table)) {
    if (eventId !== undefined && evId !== eventId) continue;
    if ((entry.entryType ?? "NONE") === "NONE") continue;
    activeEvents.push([evId, entry]);
  }

  if (eventId !== undefined && activeEvents.length === 0) {
    return `未找到匹配的活动：${JSON.stringify(eventId)}。`;
  }

  const results: SearchResult[] = [];

  for (const [evId, entry] of activeEvents) {
    if (results.length >= maxResults) break;

    const datas = (entry.infoUnlockDatas ?? []).slice();
    datas.sort((a, b) => (a.storySort ?? 0) - (b.storySort ?? 0));

    for (const d of datas) {
      if (results.length >= maxResults) break;
      if (!d.storyTxt) continue;
      const storyCode = d.storyCode ?? "";

      let chapter: StoryChapter;
      try {
        chapter = readStoryFromStore(store, d.storyTxt, true);
      } catch {
        continue;
      }

      for (let i = 0; i < chapter.lines.length; i++) {
        if (results.length >= maxResults) break;
        const line = chapter.lines[i];

        // --- filters ---
        if (character !== undefined) {
          if (line.type !== "dialog" || (line.role ?? "").toLowerCase() !== character.toLowerCase()) {
            continue;
          }
        }
        if (lineType !== undefined && line.type !== lineType) continue;

        if (!regex.test(line.text)) continue;

        // --- context collection ---
        const start = Math.max(0, i - contextLines);
        const end = Math.min(chapter.lines.length, i + contextLines + 1);
        const ctxParts: string[] = [];
        for (let j = start; j < end; j++) {
          const prefix = j === i ? ">>> " : "    ";
          ctxParts.push(prefix + formatStoryLine(chapter.lines[j]));
        }

        results.push({
          eventId: evId,
          storyCode,
          lineNumber: i + 1,
          context: ctxParts.join("\n"),
        });
      }
    }
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
