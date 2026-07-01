/**
 * Story chapter summary reader.
 *
 * Split from story.ts. Provides per-chapter summary with a three-tier fallback
 * chain: LLM long summary → official one-liner → chapter storyInfo field.
 * Mirrors python/src/prts_mcp/data/story_summary.py.
 */

import type { JsonStore } from "./stores.js";
import {
  STORYINFO,
  SUMMARIES,
  storyZipPath,
  withStoryStore,
} from "./storyReader.js";

// ---------------------------------------------------------------------------
// Per-chapter summary
// ---------------------------------------------------------------------------

export function getStorySummary(zipPath: string, storyKey: string): string {
  return withStoryStore(zipPath, (store) => getStorySummaryFromStore(store, storyKey));
}

export function getStorySummaryFromStore(store: JsonStore, storyKey: string): string {
  // --- tier 1: LLM summaries (future) ---
  if (store.exists(SUMMARIES)) {
    try {
      const raw = store.readJson<Record<string, unknown>>(SUMMARIES);
      const text = raw[storyKey];
      if (typeof text === "string" && text) return text.trim();
    } catch {
      // continue to next fallback
    }
  }

  // --- tier 2: storyinfo.json ---
  if (store.exists(STORYINFO)) {
    try {
      const raw = store.readJson<Record<string, unknown>>(STORYINFO);
      const text = raw[storyKey];
      if (typeof text === "string" && text) return text.trim();
    } catch {
      // continue to next fallback
    }
  }

  // --- tier 3: chapter JSON storyInfo ---
  const storyPath = storyZipPath(storyKey);
  if (store.exists(storyPath)) {
    try {
      const raw = store.readJson<Record<string, unknown>>(storyPath);
      const text = raw["storyInfo"];
      if (typeof text === "string" && text) return text.trim();
    } catch {
      // continue to not-found
    }
  }

  return `未找到剧情章节 '${storyKey}' 的梗概。`;
}
