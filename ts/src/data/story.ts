/**
 * Story data reader for PRTS-MCP (TypeScript).
 *
 * This module is now a compatibility re-export shim. The implementation has
 * been split into focused submodules for clarity (see STYLE.md file-size
 * guidelines):
 *
 * - storyReader: types, constants, and chapter/event parsing
 * - storySearch: full-text search index and searchStories
 * - storyMemoir: operator memoir discovery via chardict.json
 * - storySummary: event and per-chapter summaries
 *
 * Only the public symbols that existed on main are re-exported here — internal
 * helpers from storyReader are NOT re-exported, to avoid widening the public API.
 * Mirrors python/src/prts_mcp/data/story.py.
 */

// Public types from storyReader
export type {
  StoryLine,
  StoryChapter,
  EventInfo,
  ChapterSummary,
  ActivityResult,
  MemoirChapter,
  OperatorMemoirResult,
  CharacterAppearance,
  CharacterAppearanceResult,
  SpeakerCount,
} from "./storyReader.js";

// Public reader functions from storyReader
export {
  buildStoriesListing,
  buildStoriesListingFromStore,
  buildStoryEventsListing,
  buildStoryEventsListingFromStore,
  listStoryEvents,
  listStoryEventsFromStore,
  listStories,
  listStoriesFromStore,
  readStory,
  readStoryFromStore,
  readActivity,
  readActivityFromStore,
  renderStoriesListing,
  renderStoryEventsListing,
} from "./storyReader.js";

// Search
export {
  searchStories,
  searchStoriesFromStore,
} from "./storySearch.js";

// Memoir
export {
  buildOperatorMemoirs,
  buildOperatorMemoirsFromStore,
  getOperatorMemoirs,
  getOperatorMemoirsFromStore,
  renderOperatorMemoirs,
} from "./storyMemoir.js";

// Summary
export {
  getStorySummary,
  getStorySummaryFromStore,
} from "./storySummary.js";

// Character tracking
export {
  buildCharacterAppearances,
  buildCharacterAppearancesFromStore,
  buildSpeakersInEvent,
  buildSpeakersInEventFromStore,
  findCharacterAppearances,
  findCharacterAppearancesFromStore,
  findSpeakersIn,
  findSpeakersInFromStore,
  renderCharacterAppearances,
  renderSpeakersInEvent,
} from "./storyCharacter.js";

// Cache management
import { clearSearchCache } from "./storySearch.js";
import { clearCharDictCache } from "./storyMemoir.js";

export function clearStoryCaches(): void {
  clearSearchCache();
  clearCharDictCache();
}
