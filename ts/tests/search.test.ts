/**
 * Tests for search tools — operator search and story search.
 * Mirrors python/tests/test_search.py.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";

import { DirectoryStore, ZipStore, type JsonStore } from "../src/data/stores.ts";
import { searchOperatorData } from "../src/data/search.ts";
import { searchStoriesFromStore } from "../src/data/story.ts";
import { writeMinimalGamedata } from "./fixtures/operatorData.ts";

// ---------------------------------------------------------------------------
// Helpers for dynamic imports (operator module caches are module-scoped)
// ---------------------------------------------------------------------------

async function loadSearchModule(): Promise<typeof import("../src/data/search.ts")> {
  return import(`../src/data/search.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

// ---------------------------------------------------------------------------
// Story test data (mirrors Python test_search.py)
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
        { prop: "name", attributes: { name: "博士", content: "任务完成。" } },
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
  return mkdtempSync(join(tmpdir(), "prts-search-test-"));
}

// ---------------------------------------------------------------------------
// Operator search tests
// ---------------------------------------------------------------------------

test("search_operator_data matches by name", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);

  const search = await loadSearchModule();
  const result = search.searchOperatorData("阿米娅");
  assert.match(result, /\[operators\/basic\/阿米娅\]/);
  assert.match(result, /匹配：干员名称/);
});

test("search_operator_data matches by description", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);

  const search = await loadSearchModule();
  const result = search.searchOperatorData("法术伤害");
  assert.match(result, /\[operators\/basic\/阿米娅\]/);
  assert.match(result, /匹配：攻击属性/);
});

test("search_operator_data matches by archive", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);

  const search = await loadSearchModule();
  const result = search.searchOperatorData("档案文本");
  assert.match(result, /\[operators\/archives\/阿米娅\]/);
  assert.match(result, /匹配：档案资料一/);
});

test("search_operator_data matches by voiceline", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);

  const search = await loadSearchModule();
  const result = search.searchOperatorData("博士");
  assert.match(result, /\[operators\/voicelines\/阿米娅\]/);
  assert.match(result, /匹配：任命助理/);
});

test("search_operator_data no match", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);

  const search = await loadSearchModule();
  const result = search.searchOperatorData("ZZZZZZZ");
  assert.match(result, /未找到匹配/);
});

test("search_operator_data invalid regex", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);

  const search = await loadSearchModule();
  const result = search.searchOperatorData("[");
  assert.match(result, /正则表达式无效/);
});

test("search_operator_data missing_data", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = "/nonexistent/path";
  delete process.env["STORYJSON_PATH"];

  const search = await loadSearchModule();
  const result = search.searchOperatorData("阿米娅");
  assert.match(result, /暂不可用/);
});

test("search_operator_data max_results", async () => {
  const root = tempRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);

  const search = await loadSearchModule();
  const result = search.searchOperatorData(".", 2);
  assert.match(result, /共 2 条/);
});

// ---------------------------------------------------------------------------
// Story search tests
// ---------------------------------------------------------------------------

for (const kind of ["directory", "zip"] as const) {
  test(`search_stories search text (${kind})`, () => {
    const root = tempRoot();
    const store = storyStore(kind, root);
    const result = searchStoriesFromStore(store, "你好");
    assert.match(result, />>> 阿米娅：你好，博士。/);
    assert.match(result, /\[stories\/act_test\/TEST-1 L1\]/);
  });

  test(`search_stories search narration (${kind})`, () => {
    const root = tempRoot();
    const store = storyStore(kind, root);
    const result = searchStoriesFromStore(store, "罗德岛");
    assert.match(result, /> \*罗德岛走廊\*/);
  });

  test(`search_stories filter character (${kind})`, () => {
    const root = tempRoot();
    const store = storyStore(kind, root);
    const result = searchStoriesFromStore(store, ".", "博士");
    assert.match(result, /共 2 条/);
    for (const line of result.split("\n")) {
      if (line.startsWith(">>> ")) {
        assert.match(line, /博士/);
        assert.doesNotMatch(line, /阿米娅/);
      }
    }
  });

  test(`search_stories filter line_type (${kind})`, () => {
    const root = tempRoot();
    const store = storyStore(kind, root);
    const result = searchStoriesFromStore(store, ".", undefined, "narration");
    // Only narration line should be marked as match
    for (const line of result.split("\n")) {
      if (line.startsWith(">>> ")) {
        assert.match(line, /\*罗德岛走廊\*/);
      }
    }
  });

  test(`search_stories filter event (${kind})`, () => {
    const root = tempRoot();
    const store = storyStore(kind, root);
    const result = searchStoriesFromStore(store, ".", undefined, undefined, 1, 30, "nonexistent");
    assert.match(result, /未找到匹配的活动/);
  });

  test(`search_stories context zero (${kind})`, () => {
    const root = tempRoot();
    const store = storyStore(kind, root);
    const result = searchStoriesFromStore(store, "你好", undefined, undefined, 0);
    const block = result.split("---\n\n")[1];
    assert.doesNotMatch(block, /^    /m);
  });

  test(`search_stories no match (${kind})`, () => {
    const root = tempRoot();
    const store = storyStore(kind, root);
    const result = searchStoriesFromStore(store, "ZZZZZZ");
    assert.match(result, /未找到匹配/);
  });

  test(`search_stories invalid regex (${kind})`, () => {
    const root = tempRoot();
    const store = storyStore(kind, root);
    const result = searchStoriesFromStore(store, "[");
    assert.match(result, /正则表达式无效/);
  });

  test(`search_stories invalid line_type (${kind})`, () => {
    const root = tempRoot();
    const store = storyStore(kind, root);
    const result = searchStoriesFromStore(store, ".", undefined, "invalid");
    assert.match(result, /无效的 line_type/);
  });
}

// ---------------------------------------------------------------------------
// list_search_scopes test (sanity check on server registration)
// ---------------------------------------------------------------------------

test("list_search_scopes is registered as a tool", () => {
  // Tool surface test already validates server.tool() calls, so here we
  // just verify the search modules export the expected functions.
  assert.equal(typeof searchOperatorData, "function");
  assert.equal(typeof searchStoriesFromStore, "function");
});
