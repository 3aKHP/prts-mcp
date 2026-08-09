import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { DirectoryStore, ZipStore, type JsonStore } from "../src/data/stores.ts";
import {
  listStoriesFromStore,
  listStoryEventsFromStore,
  readActivityFromStore,
  readStory,
  readStoryFromStore,
} from "../src/data/story.ts";
import { registerStoryTools } from "../src/tools/storyTools.ts";

const STORY_REVIEW_PATH = "zh_CN/gamedata/excel/story_review_table.json";
const FIRST_STORY_KEY = "activities/act_test/level_act_test_01_beg";
const SECOND_STORY_KEY = "activities/act_test/level_act_test_02_end";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-story-test-"));
}

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
            storyTxt: SECOND_STORY_KEY,
            storyCode: "TEST-2",
            storyName: "终章",
            avgTag: "END",
            storySort: 2,
          },
          {
            storyTxt: FIRST_STORY_KEY,
            storyCode: "TEST-1",
            storyName: "开端",
            avgTag: "BEG",
            storySort: 1,
          },
        ],
      },
      main_test: {
        name: "测试主线",
        entryType: "MAINLINE",
        infoUnlockDatas: [],
      },
    },
    [storyPath(FIRST_STORY_KEY)]: {
      storyCode: "TEST-1",
      storyName: "开端",
      avgTag: "BEG",
      eventName: "测试活动",
      storyInfo: "测试简介",
      storyList: [
        { prop: "name", attributes: { name: "阿米娅", content: "你好，{@nickname}。" } },
        { prop: "sticker", attributes: { content: "<b>场景描述</b>" } },
        { prop: "decision", attributes: { options: ["选项一"] } },
        { prop: "decision", attributes: { options: "我相信它们。相信你，凯尔希。" } },
      ],
    },
    [storyPath(SECOND_STORY_KEY)]: {
      storyCode: "TEST-2",
      storyName: "终章",
      avgTag: "END",
      eventName: "测试活动",
      storyInfo: "",
      storyList: [
        { prop: "name", attributes: { name: "博士", content: "结束。" } },
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

type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

class CapturingServer {
  handlers = new Map<string, ToolHandler>();

  registerTool(name: string, _config: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

function assertStoryStore(store: JsonStore): void {
  const events = listStoryEventsFromStore(store, "activities");
  assert.deepEqual(
    events.map((ev) => [ev.eventId, ev.name, ev.entryType, ev.storyCount]),
    [["act_test", "测试活动", "ACTIVITY", 2]],
  );
  const mainlineEvents = listStoryEventsFromStore(store, "main");
  assert.deepEqual(mainlineEvents.map((ev) => [ev.eventId, ev.entryType]), [["main_test", "MAINLINE"]]);

  assert.deepEqual(listStoriesFromStore(store, "act_test"), [
    {
      storyKey: FIRST_STORY_KEY,
      storyCode: "TEST-1",
      storyName: "开端",
      avgTag: "BEG",
      sortOrder: 1,
    },
    {
      storyKey: SECOND_STORY_KEY,
      storyCode: "TEST-2",
      storyName: "终章",
      avgTag: "END",
      sortOrder: 2,
    },
  ]);

  const chapter = readStoryFromStore(store, FIRST_STORY_KEY);
  assert.equal(chapter.storyName, "开端");
  assert.deepEqual(chapter.lines.map((line) => line.text), [
    "你好，博士。",
    "场景描述",
    "选项一",
    "我相信它们。相信你，凯尔希。",
  ]);

  const dialogsOnly = readStoryFromStore(store, FIRST_STORY_KEY, false);
  assert.deepEqual(dialogsOnly.lines.map((line) => line.type), ["dialog", "choice", "choice"]);

  const activity = readActivityFromStore(store, "act_test", true, 1, 1);
  assert.equal(activity.eventName, "测试活动");
  assert.equal(activity.totalChapters, 2);
  assert.equal(activity.hasMore, true);
  assert.equal(activity.pageOutOfRange, false);
  assert.deepEqual(activity.chapters.map((chapter) => chapter.storyKey), [FIRST_STORY_KEY]);

  const outOfRange = readActivityFromStore(store, "act_test", true, 99, 1);
  assert.equal(outOfRange.totalChapters, 2);
  assert.deepEqual(outOfRange.chapters, []);
  assert.equal(outOfRange.pageOutOfRange, true);
}

test("story tools read from DirectoryStore", () => {
  const root = tempRoot();
  writeStoryDir(root);
  assertStoryStore(new DirectoryStore(root));
});

test("story tools read from ZipStore", () => {
  const root = tempRoot();
  const zipPath = join(root, "zh_CN.zip");
  writeStoryZip(zipPath);
  assertStoryStore(new ZipStore(zipPath));
});

test("public zip path API still reads zip", () => {
  const root = tempRoot();
  const zipPath = join(root, "zh_CN.zip");
  writeStoryZip(zipPath);

  const chapter = readStory(zipPath, FIRST_STORY_KEY);

  assert.equal(chapter.storyCode, "TEST-1");
  assert.equal(chapter.lines[0].text, "你好，博士。");
});

test("public zip path API closes transient store", () => {
  const root = tempRoot();
  const zipPath = join(root, "zh_CN.zip");
  writeStoryZip(zipPath);
  const originalClose = ZipStore.prototype.close;
  const closedPaths: string[] = [];

  ZipStore.prototype.close = function closeForTest(this: ZipStore): void {
    closedPaths.push(this.zipPath);
    originalClose.call(this);
  };
  try {
    const chapter = readStory(zipPath, FIRST_STORY_KEY);

    assert.equal(chapter.storyCode, "TEST-1");
    assert.deepEqual(closedPaths, [zipPath]);
  } finally {
    ZipStore.prototype.close = originalClose;
  }
});

test("read_activity reports an out-of-range page", async () => {
  const root = tempRoot();
  const zipPath = join(root, "zh_CN.zip");
  writeStoryZip(zipPath);
  const previousStoryjsonPath = process.env["STORYJSON_PATH"];
  process.env["STORYJSON_PATH"] = zipPath;

  try {
    const server = new CapturingServer();
    registerStoryTools(server as never);
    const handler = server.handlers.get("read_activity");
    assert.ok(handler);

    const result = await handler({ event_id: "act_test", page: 99, page_size: 1 }) as {
      content: Array<{ type: string; text?: string }>;
    };
    assert.equal(
      result.content[0]?.text,
      "页码超出范围：act_test 共 2 章，按 page_size=1 分页共 2 页，请求的 page=99 不存在。",
    );
  } finally {
    if (previousStoryjsonPath === undefined) delete process.env["STORYJSON_PATH"];
    else process.env["STORYJSON_PATH"] = previousStoryjsonPath;
  }
});

test("missing story raises", () => {
  const root = tempRoot();
  writeStoryDir(root);
  const store = new DirectoryStore(root);

  assert.throws(() => readStoryFromStore(store, "activities/act_test/missing"), /Story not found/);
});
