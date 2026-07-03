/**
 * Core story data reader — types, constants, and chapter/event parsing.
 *
 * Split from story.ts for module boundaries (see STYLE.md). This module owns
 * the data types and the low-level store-based reading primitives; higher-level
 * search, summary, and memoir logic live in their own modules.
 * Mirrors python/src/prts_mcp/data/story_reader.py.
 */

import { JsonStore, ZipStore } from "./stores.js";

// ---------------------------------------------------------------------------
// Zip path constants
// ---------------------------------------------------------------------------

export const STORY_REVIEW_TABLE = "zh_CN/gamedata/excel/story_review_table.json";
export const STORYINFO = "zh_CN/storyinfo.json";
export const SUMMARIES = "zh_CN/summaries.json";
export const EVENT_SUMMARIES = "zh_CN/event_summaries.json";
export const CHARDICT = "zh_CN/chardict.json";

export function storyZipPath(storyKey: string): string {
  return `zh_CN/gamedata/story/${storyKey}.json`;
}

// entryType → category filter mapping (mirrors Python _CATEGORY_MAP)
export const CATEGORY_MAP: Record<string, string[]> = {
  main: ["MAINLINE"],
  activities: ["ACTIVITY", "MINI_ACTIVITY"],
  memoirs: ["NONE"],
};

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

const RICH_TAG_RE = /<[^>]+>/g;
export const MEMOIR_EVENT_RE = /^story_([a-z0-9_]+)_set_\d+$/;

export function cleanText(text: string): string {
  return text.replace(/\{@nickname\}/g, "博士").replace(RICH_TAG_RE, "").trim();
}

export function isMemoirEvent(eventId: string): boolean {
  return MEMOIR_EVENT_RE.test(eventId);
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

export type RawReviewTable = Record<string, RawReviewEntry>;

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

export interface MemoirChapter {
  eventId: string;
  storyKey: string;
  storyCode: string;
  storyName: string;
}

export interface OperatorMemoirResult {
  operatorName: string;
  internalCode: string;
  operatorId: string;
  totalChapters: number;
  chapters: MemoirChapter[];
}

export interface CharacterAppearance {
  /** A single chapter where a character speaks or is mentioned. */
  eventId: string;
  storyKey: string;
  storyCode: string;
  storyName: string;
  speaks: boolean;
  mentioned: boolean;
}

export interface CharacterAppearanceResult {
  /** Aggregated appearance report for findCharacterAppearances. */
  name: string;
  totalChapters: number;
  appearances: CharacterAppearance[];
}

export interface SpeakerCount {
  /** A speaker and how many dialog lines they have (within one event). */
  name: string;
  lineCount: number;
}

export interface StoryEventsListingPayload {
  total: number;
  filters: {
    category: string | null;
    category_normalized: string | null;
  };
  events: Array<{
    event_id: string;
    name: string;
    entry_type: string;
    story_count: number;
  }>;
}

export interface StoriesListingPayload {
  event_id: string;
  total: number;
  include_summaries: boolean;
  chapters: Array<{
    story_code: string;
    story_name: string;
    story_key: string;
    avg_tag: string | null;
    summary?: string;
  }>;
  event_summary?: string;
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

export function storyStore(zipPath: string): ZipStore {
  return new ZipStore(zipPath);
}

export function withStoryStore<T>(zipPath: string, read: (store: ZipStore) => T): T {
  const store = storyStore(zipPath);
  try {
    return read(store);
  } finally {
    store.close();
  }
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
// Public API — zip-path wrappers
// ---------------------------------------------------------------------------

export function listStoryEvents(
  zipPath: string,
  category?: string
): EventInfo[] {
  return withStoryStore(zipPath, (store) => listStoryEventsFromStore(store, category));
}

export function buildStoryEventsListing(
  zipPath: string,
  category?: string,
): StoryEventsListingPayload {
  return withStoryStore(zipPath, (store) => buildStoryEventsListingFromStore(store, category));
}

export function pyRepr(value: string | null | undefined): string {
  if (value === null || value === undefined) return "None";
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === quote) out += `\\${quote}`;
    else {
      const code = ch.codePointAt(0) ?? 0;
      out += code < 32 || code === 127
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : ch;
    }
  }
  return out + quote;
}

export function renderStoryEventsListing(data: StoryEventsListingPayload): string {
  if (data.events.length === 0) {
    return `未找到符合条件的活动（category=${pyRepr(data.filters.category)}）。`;
  }

  return data.events
    .map((ev) => `- [${ev.entry_type}] ${ev.event_id}：${ev.name}（${ev.story_count} 章）`)
    .join("\n");
}

export function listStories(
  zipPath: string,
  eventId: string
): ChapterSummary[] {
  return withStoryStore(zipPath, (store) => listStoriesFromStore(store, eventId));
}

export function buildStoriesListing(
  zipPath: string,
  eventId: string,
  includeSummaries = false,
): StoriesListingPayload {
  return withStoryStore(zipPath, (store) =>
    buildStoriesListingFromStore(store, eventId, includeSummaries),
  );
}

export function renderStoriesListing(data: StoriesListingPayload): string {
  if (data.chapters.length === 0) {
    return `活动 ${pyRepr(data.event_id)} 暂无剧情章节。`;
  }

  const lines: string[] = [];
  if (data.event_summary) {
    lines.push(data.event_summary, "");
  }
  for (const ch of data.chapters) {
    const tag = ch.avg_tag ? `[${ch.avg_tag}] ` : "";
    lines.push(`- ${ch.story_code} ${tag}${ch.story_name}（key: ${ch.story_key}）`);
    if (data.include_summaries && ch.summary) {
      lines.push(`  ${ch.summary}`);
    }
  }
  return lines.join("\n");
}

export function readStory(
  zipPath: string,
  storyKey: string,
  includeNarration = true
): StoryChapter {
  return withStoryStore(zipPath, (store) => readStoryFromStore(store, storyKey, includeNarration));
}

export function readActivity(
  zipPath: string,
  eventId: string,
  includeNarration = true,
  page?: number,
  pageSize = 5
): ActivityResult {
  return withStoryStore(zipPath, (store) => readActivityFromStore(
    store,
    eventId,
    includeNarration,
    page,
    pageSize,
  ));
}

// ---------------------------------------------------------------------------
// Public API — store-based variants
// ---------------------------------------------------------------------------

export function listStoryEventsFromStore(
  store: JsonStore,
  category?: string
): EventInfo[] {
  const allowedTypes = category ? (CATEGORY_MAP[category] ?? null) : null;
  const table = store.readJson<RawReviewTable>(STORY_REVIEW_TABLE);

  const events: EventInfo[] = [];
  for (const [eventId, entry] of Object.entries(table)) {
    const entryType = entry.entryType ?? "NONE";
    if (allowedTypes !== null) {
      if (allowedTypes.length === 1 && allowedTypes[0] === "NONE") {
        // "memoirs" category: NONE entries whose eventId matches memoir pattern
        if (!isMemoirEvent(eventId)) continue;
      } else if (!allowedTypes.includes(entryType)) {
        continue;
      }
    }
    events.push({
      eventId,
      name: entry.name ?? eventId,
      entryType,
      storyCount: (entry.infoUnlockDatas ?? []).length,
    });
  }
  return events;
}

export function buildStoryEventsListingFromStore(
  store: JsonStore,
  category?: string,
): StoryEventsListingPayload {
  const events = listStoryEventsFromStore(store, category);
  const categoryNormalized = category && category in CATEGORY_MAP ? category : null;
  return {
    total: events.length,
    filters: {
      category: category ?? null,
      category_normalized: categoryNormalized,
    },
    events: events.map((ev) => ({
      event_id: ev.eventId,
      name: ev.name,
      entry_type: ev.entryType,
      story_count: ev.storyCount,
    })),
  };
}

export function listStoriesFromStore(
  store: JsonStore,
  eventId: string
): ChapterSummary[] {
  const table = store.readJson<RawReviewTable>(STORY_REVIEW_TABLE);

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

export function buildStoriesListingFromStore(
  store: JsonStore,
  eventId: string,
  includeSummaries = false,
): StoriesListingPayload {
  const chapters = listStoriesFromStore(store, eventId);
  let chapterSummaries: Record<string, string> = {};
  let eventSummaryText = "";

  if (includeSummaries) {
    try {
      if (store.exists(STORYINFO)) {
        const raw = store.readJson<Record<string, unknown>>(STORYINFO);
        chapterSummaries = Object.fromEntries(
          Object.entries(raw)
            .filter(([, value]) => Boolean(value))
            .map(([key, value]) => [key, String(value)]),
        );
      }
      if (store.exists(EVENT_SUMMARIES)) {
        const rawEvents = store.readJson<Record<string, unknown>>(EVENT_SUMMARIES);
        const text = rawEvents[eventId];
        if (typeof text === "string") eventSummaryText = text.trim();
      }
    } catch {
      chapterSummaries = {};
      eventSummaryText = "";
    }
  }

  const data: StoriesListingPayload = {
    event_id: eventId,
    total: chapters.length,
    include_summaries: includeSummaries,
    chapters: chapters.map((ch) => ({
      story_code: ch.storyCode,
      story_name: ch.storyName,
      story_key: ch.storyKey,
      avg_tag: ch.avgTag,
      ...(includeSummaries ? { summary: chapterSummaries[ch.storyKey] ?? "" } : {}),
    })),
  };
  if (eventSummaryText) data.event_summary = eventSummaryText;
  return data;
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
    if (page < 1) throw new Error("page 参数必须 >= 1");
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
    } catch (err) {
      if (err instanceof SyntaxError) { /* corrupt JSON */ }
      else if (err instanceof Error && /not found/i.test(err.message)) { /* missing */ }
      else throw err;
    }
  }

  return { eventId, eventName, totalChapters: total, hasMore, chapters };
}
