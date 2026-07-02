/**
 * Operator memoir discovery via chardict.json reverse lookup.
 *
 * Split from story.ts. Resolves an operator Chinese name to its internal
 * code, then finds all memoir events (story_{code}_set_N) and their chapters.
 * Mirrors python/src/prts_mcp/data/story_memoir.py.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { DirectoryStore, type JsonStore, ZipStore } from "./stores.js";
import {
  CHARDICT,
  type MemoirChapter,
  type OperatorMemoirResult,
  type RawReviewTable,
  STORY_REVIEW_TABLE,
  storyStore,
  withStoryStore,
} from "./storyReader.js";

export interface OperatorMemoirsPayload {
  operator_name: string;
  internal_code: string;
  operator_id: string;
  total: number;
  chapters: Array<{
    story_code: string;
    story_name: string;
    story_key: string;
  }>;
}

// ---------------------------------------------------------------------------
// Chardict types + cache
// ---------------------------------------------------------------------------

interface CharDictEntry {
  name?: string;
  id?: string;
}

let charDictCache: { descriptor: string; data: Record<string, CharDictEntry> } | null = null;

export function clearCharDictCache(): void {
  charDictCache = null;
}

// ---------------------------------------------------------------------------
// Chardict loading
// ---------------------------------------------------------------------------

function loadCharDict(store: JsonStore): Record<string, CharDictEntry> {
  const descriptor = charDictStoreDescriptor(store);
  if (descriptor !== null && charDictCache?.descriptor === descriptor) {
    return charDictCache.data;
  }
  if (!store.exists(CHARDICT)) {
    return {};
  }
  let data: Record<string, CharDictEntry>;
  try {
    data = store.readJson<Record<string, CharDictEntry>>(CHARDICT);
  } catch {
    data = {};
  }
  if (descriptor !== null) charDictCache = { descriptor, data };
  return data;
}

function charDictStoreDescriptor(store: JsonStore): string | null {
  if (store instanceof ZipStore) {
    try {
      const stat = statSync(store.zipPath, { bigint: true });
      return `zip:${store.zipPath}:${stat.size}:${stat.mtimeNs}:chardict`;
    } catch {
      return null;
    }
  }
  if (store instanceof DirectoryStore) {
    const chardict = join(store.root, CHARDICT);
    try {
      const stat = statSync(chardict, { bigint: true });
      return `directory:${store.root}:${stat.size}:${stat.mtimeNs}:chardict`;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Code resolution
// ---------------------------------------------------------------------------

function resolveOperatorCode(
  charDict: Record<string, CharDictEntry>,
  operatorName: string
): string | null {
  for (const [code, info] of Object.entries(charDict)) {
    if (info.name === operatorName) return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API — zip-path wrapper
// ---------------------------------------------------------------------------

export function getOperatorMemoirs(
  zipPath: string,
  operatorName: string,
): OperatorMemoirResult {
  return withStoryStore(zipPath, (store) => getOperatorMemoirsFromStore(store, operatorName));
}

export function buildOperatorMemoirs(
  zipPath: string,
  operatorName: string,
): OperatorMemoirsPayload {
  return withStoryStore(zipPath, (store) => buildOperatorMemoirsFromStore(store, operatorName));
}

export function renderOperatorMemoirs(data: OperatorMemoirsPayload): string {
  const lines: string[] = [
    `# ${data.operator_name}（code: ${data.internal_code}，id: ${data.operator_id}）`,
    `共 ${data.total} 章密录\n`,
  ];
  for (const ch of data.chapters) {
    lines.push(`- ${ch.story_code} ${ch.story_name}（key: ${ch.story_key}）`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API — store-based
// ---------------------------------------------------------------------------

export function getOperatorMemoirsFromStore(
  store: JsonStore,
  operatorName: string,
): OperatorMemoirResult {
  const charDict = loadCharDict(store);
  if (Object.keys(charDict).length === 0) {
    throw new Error("chardict.json 未在 story zip 中找到。");
  }

  const code = resolveOperatorCode(charDict, operatorName);
  if (code === null) {
    throw new Error(
      `未找到干员名称 '${operatorName}' 对应的内部代码。请使用游戏内中文名称。`
    );
  }

  const charInfo = charDict[code];
  const operatorId = charInfo.id ?? "";

  const table = store.readJson<RawReviewTable>(STORY_REVIEW_TABLE);
  const prefix = `story_${code}_set_`;
  const memoirEvents = Object.keys(table)
    .filter((eid) => eid.startsWith(prefix))
    .sort((a, b) => {
      const aNum = parseInt(a.split("_").pop() ?? "0", 10) || 0;
      const bNum = parseInt(b.split("_").pop() ?? "0", 10) || 0;
      return aNum - bNum;
    });

  if (memoirEvents.length === 0) {
    throw new Error(`干员 '${operatorName}' (code=${code}) 暂无密录数据。`);
  }

  const chapters: MemoirChapter[] = [];
  for (const eventId of memoirEvents) {
    const entry = table[eventId];
    const datas = (entry?.infoUnlockDatas ?? []).slice();
    datas.sort((a, b) => (a.storySort ?? 0) - (b.storySort ?? 0));
    for (const d of datas) {
      if (!d.storyTxt) continue;
      chapters.push({
        eventId,
        storyKey: d.storyTxt,
        storyCode: d.storyCode ?? "",
        storyName: d.storyName ?? "",
      });
    }
  }

  return {
    operatorName,
    internalCode: code,
    operatorId,
    totalChapters: chapters.length,
    chapters,
  };
}

export function buildOperatorMemoirsFromStore(
  store: JsonStore,
  operatorName: string,
): OperatorMemoirsPayload {
  const result = getOperatorMemoirsFromStore(store, operatorName);
  return {
    operator_name: result.operatorName,
    internal_code: result.internalCode,
    operator_id: result.operatorId,
    total: result.totalChapters,
    chapters: result.chapters.map((ch) => ({
      story_code: ch.storyCode,
      story_name: ch.storyName,
      story_key: ch.storyKey,
    })),
  };
}
