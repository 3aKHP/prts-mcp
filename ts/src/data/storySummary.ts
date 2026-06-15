/**
 * Story chapter and event summary readers.
 *
 * Split from story.ts. Provides event-level overview (getEventSummary)
 * and per-chapter summary with a three-tier fallback chain:
 * LLM long summary → official one-liner → chapter storyInfo field.
 * Mirrors python/src/prts_mcp/data/story_summary.py.
 */

import type { JsonStore } from "./stores.js";
import {
  EVENT_SUMMARIES,
  type RawReviewTable,
  STORY_REVIEW_TABLE,
  STORYINFO,
  SUMMARIES,
  storyZipPath,
  withStoryStore,
} from "./storyReader.js";

// ---------------------------------------------------------------------------
// Event summary (all chapters of an event)
// ---------------------------------------------------------------------------

export function getEventSummary(zipPath: string, eventId: string): string {
  return withStoryStore(zipPath, (store) => getEventSummaryFromStore(store, eventId));
}

export function getEventSummaryFromStore(store: JsonStore, eventId: string): string {
  // --- event metadata ---
  let table: RawReviewTable;
  try {
    table = store.readJson<RawReviewTable>(STORY_REVIEW_TABLE);
  } catch (exc) {
    return `读取剧情数据索引失败：${exc instanceof Error ? exc.message : String(exc)}`;
  }

  const entry = table[eventId];
  if (!entry) {
    return `未找到活动：${JSON.stringify(eventId)}。请先调用 list_story_events 确认活动 ID。`;
  }

  const eventName = entry.name ?? eventId;
  const datas = (entry.infoUnlockDatas ?? []).slice();
  datas.sort((a, b) => (a.storySort ?? 0) - (b.storySort ?? 0));

  if (datas.length === 0) {
    return `活动 ${JSON.stringify(eventId)}（${eventName}）暂无剧情章节。`;
  }

  // --- load summary index ---
  let summaries: Record<string, string> = {};
  if (store.exists(STORYINFO)) {
    try {
      const raw = store.readJson<Record<string, unknown>>(STORYINFO);
      for (const [k, v] of Object.entries(raw)) {
        if (v) summaries[k] = String(v);
      }
    } catch {
      // storyinfo.json is optional for this tool
    }
  }

  // --- tier 1: LLM event summary ---
  let eventSummaryText = "";
  if (store.exists(EVENT_SUMMARIES)) {
    try {
      const raw = store.readJson<Record<string, unknown>>(EVENT_SUMMARIES);
      const text = raw[eventId];
      if (typeof text === "string") eventSummaryText = text.trim();
    } catch {
      // continue without LLM event summary
    }
  }

  // --- build output ---
  const total = datas.length;
  const lines: string[] = [`# ${eventName} — 共 ${total} 章`];
  if (eventSummaryText) lines.push(`\n${eventSummaryText}`);
  for (const d of datas) {
    const storyKey = d.storyTxt;
    if (!storyKey) continue;
    const code = d.storyCode ?? "";
    const name = d.storyName ?? "";
    const tag = d.avgTag ? `[${d.avgTag}] ` : "";

    const summary = summaries[storyKey] ?? "";
    if (summary) {
      lines.push(`\n${code} ${tag}${name}\n  ${summary}`);
    } else {
      lines.push(`\n${code} ${tag}${name}`);
    }
  }

  return lines.join("\n");
}

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
