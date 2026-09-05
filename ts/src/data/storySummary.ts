/**
 * Story chapter summary reader.
 *
 * Split from story.ts. Provides per-chapter summary with a three-tier fallback
 * chain: LLM long summary → official one-liner → chapter storyInfo field.
 * Mirrors python/src/prts_mcp/data/story_summary.py.
 */

import type { JsonStore } from "./stores.js";
import {
  chapterSummaryFromStore,
  loadChapterSummariesFromStore,
  withStoryStore,
} from "./storyReader.js";

// ---------------------------------------------------------------------------
// Per-chapter summary
// ---------------------------------------------------------------------------

export function getStorySummary(zipPath: string, storyKey: string): string {
  return withStoryStore(zipPath, (store) => getStorySummaryFromStore(store, storyKey));
}

export function getStorySummaryFromStore(store: JsonStore, storyKey: string): string {
  const text = chapterSummaryFromStore(store, storyKey, loadChapterSummariesFromStore(store));
  return text || `未找到剧情章节 '${storyKey}' 的梗概。`;
}
