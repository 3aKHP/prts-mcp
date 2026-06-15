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
 * All public symbols are re-exported here so existing
 * `import { ... } from "./story.js"` imports continue to work unchanged.
 * Mirrors python/src/prts_mcp/data/story.py.
 */

export * from "./storyReader.js";
export {
  searchStories,
  searchStoriesFromStore,
  clearSearchCache,
} from "./storySearch.js";
export {
  getOperatorMemoirs,
  getOperatorMemoirsFromStore,
} from "./storyMemoir.js";
export {
  getEventSummary,
  getEventSummaryFromStore,
  getStorySummary,
  getStorySummaryFromStore,
} from "./storySummary.js";

import { clearSearchCache } from "./storySearch.js";
import { clearCharDictCache } from "./storyMemoir.js";

export function clearStoryCaches(): void {
  clearSearchCache();
  clearCharDictCache();
}
