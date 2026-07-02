/**
 * Story character tracking — who appears where, and who speaks in an event.
 *
 * Split from story.ts. Reuses the lazily-cached search index built by
 * storySearch (which already walks every chapter and line), so this module
 * performs no file IO of its own and needs no separate cache. Two questions
 * are answered:
 *
 * - *Where does a character show up?* — chapters/events where the character
 *   **speaks** (dialog `role` exact match, consistent with the `character`
 *   filter of searchStories) or is **mentioned** (name appears as a substring
 *   in any line's text).
 * - *Who speaks in an event?* — distinct speakers with their dialog line
 *   counts.
 *
 * Mirrors python/src/prts_mcp/data/story_character.py.
 */

import { type JsonStore } from "./stores.js";
import {
  type CharacterAppearance,
  type CharacterAppearanceResult,
  type SpeakerCount,
  withStoryStore,
} from "./storyReader.js";
import { storySearchIndex, type StorySearchChapter } from "./storySearch.js";

export interface CharacterAppearancesPayload {
  name: string;
  total: number;
  filters: {
    scope: string | null;
  };
  appearances: Array<{
    event_id: string;
    story_code: string;
    story_name: string;
    story_key: string;
    speaks: boolean;
    mentioned: boolean;
  }>;
}

export interface SpeakersInEventPayload {
  event_id: string;
  total: number;
  speakers: Array<{
    name: string;
    line_count: number;
  }>;
}

function pyRepr(value: string | null | undefined): string {
  if (value === null || value === undefined) return "None";
  return `'${value}'`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return [speaks, mentioned] flags for one indexed chapter.
 *
 * `speaks` is true when any dialog line's `role` equals nameLower
 * (case-insensitive), mirroring the `character` filter of searchStories.
 * `mentioned` is true when nameLower occurs as a substring in any line's text.
 */
function classifyChapter(
  chapter: StorySearchChapter,
  nameLower: string,
): [boolean, boolean] {
  let speaks = false;
  let mentioned = false;
  for (const line of chapter.lines) {
    if (line.type === "dialog" && (line.role ?? "").toLowerCase() === nameLower) {
      speaks = true;
    }
    if (line.text.toLowerCase().includes(nameLower)) {
      mentioned = true;
    }
    if (speaks && mentioned) {
      break;
    }
  }
  return [speaks, mentioned];
}

// ---------------------------------------------------------------------------
// Public API — zip-path wrappers
// ---------------------------------------------------------------------------

export function findCharacterAppearances(
  zipPath: string,
  name: string,
  scope?: string,
  maxEvents = 50,
): CharacterAppearanceResult {
  return withStoryStore(zipPath, (store) =>
    findCharacterAppearancesFromStore(store, name, scope, maxEvents),
  );
}

export function buildCharacterAppearances(
  zipPath: string,
  name: string,
  scope?: string,
  maxEvents = 50,
): CharacterAppearancesPayload {
  return withStoryStore(zipPath, (store) =>
    buildCharacterAppearancesFromStore(store, name, scope, maxEvents),
  );
}

export function renderCharacterAppearances(data: CharacterAppearancesPayload): string {
  if (data.appearances.length === 0) {
    const scope = data.filters.scope;
    const scopeNote = scope ? `（限定活动：${pyRepr(scope)}）` : "";
    return `未找到「${data.name}」的出场记录。${scopeNote}`;
  }

  const parts = [`# 「${data.name}」的出场（共 ${data.total} 章）`];
  for (const ap of data.appearances) {
    const tags: string[] = [];
    if (ap.speaks) tags.push("speaks");
    if (ap.mentioned) tags.push("mentioned");
    const nameDisp = `${ap.story_code} ${ap.story_name}`.trim();
    parts.push(`- [${tags.join("+")}] ${ap.event_id} / ${nameDisp}（key: ${ap.story_key}）`);
  }
  return parts.join("\n");
}

export function findSpeakersIn(
  zipPath: string,
  eventId: string,
): SpeakerCount[] {
  return withStoryStore(zipPath, (store) =>
    findSpeakersInFromStore(store, eventId),
  );
}

export function buildSpeakersInEvent(
  zipPath: string,
  eventId: string,
): SpeakersInEventPayload {
  return withStoryStore(zipPath, (store) => buildSpeakersInEventFromStore(store, eventId));
}

export function renderSpeakersInEvent(data: SpeakersInEventPayload): string {
  if (data.speakers.length === 0) {
    return `活动 ${pyRepr(data.event_id)} 暂无对话发言者数据。`;
  }

  const parts = [`# ${data.event_id} 的发言角色（共 ${data.total} 位）`];
  for (const sp of data.speakers) {
    parts.push(`- ${sp.name}（${sp.line_count} 句）`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public API — store-based variants
// ---------------------------------------------------------------------------

export function findCharacterAppearancesFromStore(
  store: JsonStore,
  name: string,
  scope?: string,
  maxEvents = 50,
): CharacterAppearanceResult {
  if (!name) throw new Error("name 不能为空。");
  if (maxEvents < 1) throw new Error("max_events 必须 >= 1。");
  if (maxEvents > 200) throw new Error("max_events 必须 <= 200。");

  const index = storySearchIndex(store);

  if (scope !== undefined && !index.eventIds.has(scope)) {
    throw new Error(`未找到匹配的活动：${JSON.stringify(scope)}。`);
  }

  const nameLower = name.toLowerCase();
  const appearances: CharacterAppearance[] = [];

  for (const chapter of index.chapters) {
    if (scope !== undefined && chapter.eventId !== scope) continue;
    const [speaks, mentioned] = classifyChapter(chapter, nameLower);
    if (!speaks && !mentioned) continue;
    appearances.push({
      eventId: chapter.eventId,
      storyKey: chapter.storyKey,
      storyCode: chapter.storyCode,
      storyName: chapter.storyName,
      speaks,
      mentioned,
    });
    if (appearances.length >= maxEvents) break;
  }

  return {
    name,
    totalChapters: appearances.length,
    appearances,
  };
}

export function buildCharacterAppearancesFromStore(
  store: JsonStore,
  name: string,
  scope?: string,
  maxEvents = 50,
): CharacterAppearancesPayload {
  const result = findCharacterAppearancesFromStore(store, name, scope, maxEvents);
  return {
    name: result.name,
    total: result.totalChapters,
    filters: { scope: scope ?? null },
    appearances: result.appearances.map((ap) => ({
      event_id: ap.eventId,
      story_code: ap.storyCode,
      story_name: ap.storyName,
      story_key: ap.storyKey,
      speaks: ap.speaks,
      mentioned: ap.mentioned,
    })),
  };
}

export function findSpeakersInFromStore(
  store: JsonStore,
  eventId: string,
): SpeakerCount[] {
  const index = storySearchIndex(store);

  if (!index.eventIds.has(eventId)) {
    throw new Error(`未找到匹配的活动：${JSON.stringify(eventId)}。`);
  }

  const counts = new Map<string, number>();
  for (const chapter of index.chapters) {
    if (chapter.eventId !== eventId) continue;
    for (const line of chapter.lines) {
      if (line.type === "dialog" && line.role) {
        counts.set(line.role, (counts.get(line.role) ?? 0) + 1);
      }
    }
  }

  const speakers: SpeakerCount[] = [];
  for (const [speakerName, lineCount] of counts) {
    speakers.push({ name: speakerName, lineCount });
  }
  // Sort by line count desc, then by name using codepoint ordering to match
  // the Python implementation's `(-line_count, name)` tuple sort.
  speakers.sort((a, b) => b.lineCount - a.lineCount || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return speakers;
}

export function buildSpeakersInEventFromStore(
  store: JsonStore,
  eventId: string,
): SpeakersInEventPayload {
  const speakers = findSpeakersInFromStore(store, eventId);
  return {
    event_id: eventId,
    total: speakers.length,
    speakers: speakers.map((sp) => ({
      name: sp.name,
      line_count: sp.lineCount,
    })),
  };
}
