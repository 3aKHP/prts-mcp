/**
 * Tests for story character tracking — findCharacterAppearances and findSpeakersIn.
 * Mirrors python/tests/test_story_character.py.
 *
 * Fixture dialogue (the source of truth for the assertions below):
 *   ch1 (TEST-1 开端):
 *     - 阿米娅：你好，博士。        ← 阿米娅 speaks; "博士" in text
 *     - *罗德岛走廊*               ← narration, no names
 *     - 博士：我们出发吧。          ← 博士 speaks; no names in text
 *   ch2 (TEST-2 终章):
 *     - 博士：任务完成。阿米娅干得不错。  ← 博士 speaks; "阿米娅" in text
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";

import { DirectoryStore, ZipStore, type JsonStore } from "../src/data/stores.ts";
import {
  findCharacterAppearancesFromStore,
  findSpeakersInFromStore,
} from "../src/data/storyCharacter.ts";

// ---------------------------------------------------------------------------
// Story test data (same shape as search.test.ts)
// ---------------------------------------------------------------------------

const STORY_REVIEW_PATH = "zh_CN/gamedata/excel/story_review_table.json";
const FIRST_STORY_KEY = "activities/act_test/level_act_test_01_beg";
const SECOND_STORY_KEY = "activities/act_test/level_act_test_02_end";

function storyPath(storyKey: string): string {
  return `zh_CN/gamedata/story/${storyKey}.json`;
}

function storyFiles(): Record<string, unknown> {
  return {
    [STORY_REVIEW_PATH]: {
      act_test: {
        name: "测试活动",
        entryType: "ACTIVITY",
        infoUnlockDatas: [
          {
            storyTxt: FIRST_STORY_KEY,
            storyCode: "TEST-1",
            storyName: "开端",
            avgTag: "BEG",
            storySort: 1,
          },
          {
            storyTxt: SECOND_STORY_KEY,
            storyCode: "TEST-2",
            storyName: "终章",
            avgTag: "END",
            storySort: 2,
          },
        ],
      },
    },
    [storyPath(FIRST_STORY_KEY)]: {
      storyCode: "TEST-1",
      storyName: "开端",
      avgTag: "BEG",
      eventName: "测试活动",
      storyInfo: "测试简介",
      storyList: [
        { prop: "name", attributes: { name: "阿米娅", content: "你好，博士。" } },
        { prop: "sticker", attributes: { content: "罗德岛走廊" } },
        { prop: "name", attributes: { name: "博士", content: "我们出发吧。" } },
      ],
    },
    [storyPath(SECOND_STORY_KEY)]: {
      storyCode: "TEST-2",
      storyName: "终章",
      avgTag: "END",
      eventName: "测试活动",
      storyInfo: "",
      storyList: [
        { prop: "name", attributes: { name: "博士", content: "任务完成。阿米娅干得不错。" } },
      ],
    },
  };
}

function writeStoryDir(root: string): void {
  for (const [path, data] of Object.entries(storyFiles())) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(data), "utf-8");
  }
}

function writeStoryZip(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const zip = new AdmZip();
  for (const [innerPath, data] of Object.entries(storyFiles())) {
    zip.addFile(innerPath, Buffer.from(JSON.stringify(data), "utf-8"));
  }
  zip.writeZip(path);
}

function storyStore(kind: "directory" | "zip", root: string): JsonStore {
  if (kind === "directory") {
    writeStoryDir(root);
    return new DirectoryStore(root);
  } else {
    const zipPath = join(root, "zh_CN.zip");
    writeStoryZip(zipPath);
    return new ZipStore(zipPath);
  }
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-character-test-"));
}

// ---------------------------------------------------------------------------
// findCharacterAppearances
// ---------------------------------------------------------------------------

for (const kind of ["directory", "zip"] as const) {
  test(`find_character_appearances: 博士 speaks both, mentioned in ch1 (${kind})`, () => {
    const store = storyStore(kind, tempRoot());
    const result = findCharacterAppearancesFromStore(store, "博士");

    assert.equal(result.name, "博士");
    assert.equal(result.totalChapters, 2);
    const [ch1, ch2] = result.appearances;
    assert.equal(ch1.storyKey, FIRST_STORY_KEY);
    assert.equal(ch1.speaks, true);
    assert.equal(ch1.mentioned, true);   // "博士" in 阿米娅's ch1 text
    assert.equal(ch2.storyKey, SECOND_STORY_KEY);
    assert.equal(ch2.speaks, true);
    assert.equal(ch2.mentioned, false);  // 博士 not in ch2 text
  });

  test(`find_character_appearances: 阿米娅 speaks ch1, mentioned ch2 (${kind})`, () => {
    const store = storyStore(kind, tempRoot());
    const result = findCharacterAppearancesFromStore(store, "阿米娅");

    assert.equal(result.totalChapters, 2);
    const [ch1, ch2] = result.appearances;
    assert.equal(ch1.speaks, true);
    assert.equal(ch1.mentioned, false);  // 阿米娅 not in ch1 text
    assert.equal(ch2.speaks, false);
    assert.equal(ch2.mentioned, true);   // "阿米娅" in ch2 text
  });

  test(`find_character_appearances: scope filter (${kind})`, () => {
    const store = storyStore(kind, tempRoot());
    const result = findCharacterAppearancesFromStore(store, "博士", "act_test");
    assert.equal(result.totalChapters, 2);
  });

  test(`find_character_appearances: unknown scope throws (${kind})`, () => {
    const store = storyStore(kind, tempRoot());
    assert.throws(() => findCharacterAppearancesFromStore(store, "博士", "no_such_event"));
  });

  test(`find_character_appearances: no match returns empty (${kind})`, () => {
    const store = storyStore(kind, tempRoot());
    const result = findCharacterAppearancesFromStore(store, "不存在的角色");
    assert.equal(result.totalChapters, 0);
    assert.deepEqual(result.appearances, []);
  });

  test(`find_character_appearances: substring false positive on text only (${kind})`, () => {
    // mentioned is substring on line text (role is exact). "阿" is not in any
    // ch1 text, but is a substring of "阿米娅" in ch2 text → only ch2.
    const store = storyStore(kind, tempRoot());
    const result = findCharacterAppearancesFromStore(store, "阿");
    assert.equal(result.totalChapters, 1);
    assert.equal(result.appearances[0].storyKey, SECOND_STORY_KEY);
    assert.equal(result.appearances[0].speaks, false);
    assert.equal(result.appearances[0].mentioned, true);
  });
}

test("find_character_appearances: empty name throws", () => {
  const store = storyStore("directory", tempRoot());
  assert.throws(() => findCharacterAppearancesFromStore(store, ""));
});

test("find_character_appearances: max_events bounds", () => {
  const store = storyStore("directory", tempRoot());
  assert.throws(() => findCharacterAppearancesFromStore(store, "博士", undefined, 0));
  assert.throws(() => findCharacterAppearancesFromStore(store, "博士", undefined, 201));
});

test("find_character_appearances: max_events cap", () => {
  const store = storyStore("directory", tempRoot());
  const result = findCharacterAppearancesFromStore(store, "博士", undefined, 1);
  assert.equal(result.totalChapters, 1);
});

// ---------------------------------------------------------------------------
// findSpeakersIn
// ---------------------------------------------------------------------------

for (const kind of ["directory", "zip"] as const) {
  test(`find_speakers_in: speakers with counts (${kind})`, () => {
    // 阿米娅 speaks once (ch1), 博士 speaks twice (ch1 + ch2).
    const store = storyStore(kind, tempRoot());
    const speakers = findSpeakersInFromStore(store, "act_test");

    const byName: Record<string, number> = {};
    for (const s of speakers) byName[s.name] = s.lineCount;
    assert.deepEqual(byName, { "博士": 2, "阿米娅": 1 });
  });

  test(`find_speakers_in: sorted by count desc (${kind})`, () => {
    const store = storyStore(kind, tempRoot());
    const speakers = findSpeakersInFromStore(store, "act_test");
    const counts = speakers.map((s) => s.lineCount);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
    // 博士 (2) ranks above 阿米娅 (1).
    assert.equal(speakers[0].name, "博士");
  });
}

test("find_speakers_in: unknown event throws", () => {
  const store = storyStore("directory", tempRoot());
  assert.throws(() => findSpeakersInFromStore(store, "no_such_event"));
});

// ---------------------------------------------------------------------------
// Edge case: event exists but has no dialog (narration only)
// ---------------------------------------------------------------------------

const NARRATION_ONLY_KEY = "activities/act_narration/level_narration_01";

function narrationOnlyFiles(): Record<string, unknown> {
  return {
    [STORY_REVIEW_PATH]: {
      act_narration: {
        name: "纯旁白活动",
        entryType: "ACTIVITY",
        infoUnlockDatas: [
          {
            storyTxt: NARRATION_ONLY_KEY,
            storyCode: "NAR-1",
            storyName: "旁白章",
            avgTag: null,
            storySort: 1,
          },
        ],
      },
    },
    [storyPath(NARRATION_ONLY_KEY)]: {
      storyCode: "NAR-1",
      storyName: "旁白章",
      avgTag: null,
      eventName: "纯旁白活动",
      storyInfo: "",
      storyList: [
        { prop: "sticker", attributes: { content: "只有旁白文本。" } },
      ],
    },
  };
}

function narrationOnlyStore(kind: "directory" | "zip", root: string): JsonStore {
  const files = narrationOnlyFiles();
  if (kind === "directory") {
    for (const [path, data] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data), "utf-8");
    }
    return new DirectoryStore(root);
  } else {
    const zipPath = join(root, "zh_CN.zip");
    mkdirSync(dirname(zipPath), { recursive: true });
    const zip = new AdmZip();
    for (const [innerPath, data] of Object.entries(files)) {
      zip.addFile(innerPath, Buffer.from(JSON.stringify(data), "utf-8"));
    }
    zip.writeZip(zipPath);
    return new ZipStore(zipPath);
  }
}

for (const kind of ["directory", "zip"] as const) {
  test(`find_speakers_in: narration-only event returns empty (${kind})`, () => {
    const store = narrationOnlyStore(kind, tempRoot());
    const speakers = findSpeakersInFromStore(store, "act_narration");
    assert.deepEqual(speakers, []);
  });

  test(`find_character_appearances: narration-only event has no speaker match (${kind})`, () => {
    const store = narrationOnlyStore(kind, tempRoot());
    const result = findCharacterAppearancesFromStore(store, "博士");
    assert.equal(result.totalChapters, 0);
  });
}
