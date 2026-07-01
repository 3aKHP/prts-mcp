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

export function findSpeakersIn(
  zipPath: string,
  eventId: string,
): SpeakerCount[] {
  return withStoryStore(zipPath, (store) =>
    findSpeakersInFromStore(store, eventId),
  );
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
