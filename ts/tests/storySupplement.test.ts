/** Consumer-side tests for the roguelike story supplement catalog.
 *
 * Mirrors python/tests/test_story_supplement.py: the supplement
 * (zh_CN/story_supplement.json) is projected into the review table's shape
 * by loadEventTable so listing/search/character tools treat rogue chapters
 * like regular ones — without changing any existing output when the file
 * is absent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import AdmZip from "adm-zip";

import { DirectoryStore, ZipStore, type JsonStore } from "../src/data/stores.ts";
import {
  listStoriesFromStore,
  listStoryEventsFromStore,
  readActivityFromStore,
} from "../src/data/storyReader.ts";
import { findSpeakersInFromStore } from "../src/data/storyCharacter.ts";
import { searchStoriesFromStore } from "../src/data/storySearch.ts";

const STORY_REVIEW_PATH = "zh_CN/gamedata/excel/story_review_table.json";
const STORY_SUPPLEMENT_PATH = "zh_CN/story_supplement.json";
const ROGUE_KEY = "Obt/Rogue/rogue_6/MonthRecord/month_record_rogue_6_4_1";
const ROGUE_ENDING_KEY = "Obt/Roguelike/RO6/level_rogue6_ending_1";

function storyFiles(withSupplement: boolean): Record<string, unknown> {
  const files: Record<string, unknown> = {
    [STORY_REVIEW_PATH]: {
      act_test: {
        name: "测试活动",
        entryType: "ACTIVITY",
        infoUnlockDatas: [
          {
            storyTxt: "activities/act_test/level_act_test_01_beg",
            storyCode: "TEST-1",
            storyName: "开端",
            avgTag: "BEG",
            storySort: 1,
          },
        ],
      },
    },
    "zh_CN/gamedata/story/activities/act_test/level_act_test_01_beg.json": {
      storyCode: "TEST-1",
      storyName: "开端",
      eventName: "测试活动",
      storyList: [{ prop: "name", attributes: { name: "阿米娅", content: "你好。" } }],
    },
  };
  if (withSupplement) {
    files[STORY_SUPPLEMENT_PATH] = {
      version: 1,
      generated_from: { tables: [], source_version: "v-test" },
      events: [
        {
          event_id: "rogue_6",
          name: "沉沦者的黑流树海",
          entry_type: "ROGUELIKE",
          sort: 6,
          chapters: [
            {
              key: ROGUE_ENDING_KEY, name: "强制重启", code: "RO6-E1",
              avg_tag: "结局", sort: 110, group: "ending",
              source: "topic:endbook.avgId",
            },
            {
              key: ROGUE_KEY, name: "南方往事·1", code: "RO6-M4-1",
              avg_tag: "月度记录·南方往事", sort: 10401, group: "month",
              source: "topic:chat.chatStoryId",
            },
          ],
        },
      ],
    };
    files[`zh_CN/gamedata/story/${ROGUE_KEY}.json`] = {
      storyCode: "RO6-M4-1",
      storyName: "南方往事·1",
      eventName: "沉沦者的黑流树海",
      storyList: [
        { prop: "name", attributes: { name: "", content: "独特旁白词项xyz。" } },
        { prop: "name", attributes: { name: "帕尤卡卡", content: "蛋糕烤好了。" } },
      ],
    };
    files[`zh_CN/gamedata/story/${ROGUE_ENDING_KEY}.json`] = {
      storyCode: "RO6-E1",
      storyName: "强制重启",
      eventName: "沉沦者的黑流树海",
      storyInfo: "官方梗概。",
      storyList: [
        { prop: "name", attributes: { name: "卡德霍", content: "落幕。" } },
      ],
    };
  }
  return files;
}

function makeStore(root: string, kind: "directory" | "zip", withSupplement = true): JsonStore {
  const files = storyFiles(withSupplement);
  if (kind === "directory") {
    for (const [rel, data] of Object.entries(files)) {
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(data), "utf-8");
    }
    return new DirectoryStore(root);
  }
  const zip = new AdmZip();
  for (const [rel, data] of Object.entries(files)) {
    zip.addFile(rel, Buffer.from(JSON.stringify(data), "utf-8"));
  }
  const zipPath = join(root, "zh_CN.zip");
  zip.writeZip(zipPath);
  return new ZipStore(zipPath);
}

for (const kind of ["directory", "zip"] as const) {
  test(`supplement events listed (${kind})`, () => {
    const store = makeStore(mkdtempSync(join(tmpdir(), "prts-supp-")), kind);
    const events = listStoryEventsFromStore(store);
    const byId = new Map(events.map((ev) => [ev.eventId, ev]));
    const rogue = byId.get("rogue_6");
    assert.equal(rogue?.name, "沉沦者的黑流树海");
    assert.equal(rogue?.entryType, "ROGUELIKE");
    assert.equal(rogue?.storyCount, 2);
    assert.ok(byId.has("act_test")); // review content unaffected
  });

  test(`supplement category filter (${kind})`, () => {
    const store = makeStore(mkdtempSync(join(tmpdir(), "prts-supp-")), kind);
    assert.deepEqual(
      listStoryEventsFromStore(store, "roguelike").map((ev) => ev.eventId),
      ["rogue_6"],
    );
    assert.deepEqual(
      listStoryEventsFromStore(store, "activities").map((ev) => ev.eventId),
      ["act_test"],
    );
    assert.deepEqual(listStoryEventsFromStore(store, "memoirs"), []);
  });

  test(`supplement chapters ordered and projected (${kind})`, () => {
    const store = makeStore(mkdtempSync(join(tmpdir(), "prts-supp-")), kind);
    assert.deepEqual(
      listStoriesFromStore(store, "rogue_6").map((c) => [
        c.storyKey, c.storyCode, c.storyName, c.avgTag,
      ]),
      [
        [ROGUE_ENDING_KEY, "RO6-E1", "强制重启", "结局"],
        [ROGUE_KEY, "RO6-M4-1", "南方往事·1", "月度记录·南方往事"],
      ],
    );
  });

  test(`supplement read_activity (${kind})`, () => {
    const store = makeStore(mkdtempSync(join(tmpdir(), "prts-supp-")), kind);
    const activity = readActivityFromStore(store, "rogue_6");
    const texts = activity.chapters.flatMap((ch) => ch.lines.map((l) => l.text));
    assert.ok(texts.some((t) => t.includes("独特旁白词项xyz")));
    assert.ok(texts.some((t) => t.includes("落幕。")));
  });

  test(`supplement searchable (${kind})`, () => {
    const store = makeStore(mkdtempSync(join(tmpdir(), "prts-supp-")), kind);
    assert.ok(searchStoriesFromStore(store, "独特旁白词项xyz", undefined, undefined, 1, 5).includes("rogue_6"));
    assert.ok(searchStoriesFromStore(store, "你好", undefined, undefined, 1, 5).includes("你好"));
  });

  test(`supplement speakers via character index (${kind})`, () => {
    const store = makeStore(mkdtempSync(join(tmpdir(), "prts-supp-")), kind);
    const names = new Set(findSpeakersInFromStore(store, "rogue_6").map((s) => s.name));
    assert.ok(names.has("帕尤卡卡"));
    assert.ok(names.has("卡德霍"));
  });

  test(`no supplement keeps old behavior (${kind})`, () => {
    const store = makeStore(mkdtempSync(join(tmpdir(), "prts-supp-")), kind, false);
    assert.deepEqual(
      listStoryEventsFromStore(store).map((ev) => ev.eventId),
      ["act_test"],
    );
    assert.throws(() => listStoriesFromStore(store, "rogue_6"));
    assert.ok(!searchStoriesFromStore(store, "独特旁白词项xyz", undefined, undefined, 1, 5).includes("rogue_6"));
  });
}

test("invalid supplement degrades to review (directory)", () => {
  const root = mkdtempSync(join(tmpdir(), "prts-supp-"));
  const store = makeStore(root, "directory");
  writeFileSync(join(root, STORY_SUPPLEMENT_PATH), "{not json", "utf-8");
  assert.deepEqual(
    listStoryEventsFromStore(store).map((ev) => ev.eventId),
    ["act_test"],
  );
});

test("malformed supplement fields degrade (directory)", () => {
  // mirrors the Python test: wrong-typed fields degrade to defaults
  const root = mkdtempSync(join(tmpdir(), "prts-supp-"));
  const store = makeStore(root, "directory");
  const bad = {
    version: 1,
    events: [
      { event_id: 123, chapters: [] }, // non-string id: skipped
      { event_id: "rogue_9", chapters: 5 }, // non-list: event with 0 chapters
      {
        event_id: "rogue_7", name: null, entry_type: 7,
        chapters: [
          { key: ROGUE_KEY, name: null, code: null, avg_tag: 3, sort: null },
        ],
      },
    ],
  };
  writeFileSync(join(root, STORY_SUPPLEMENT_PATH), JSON.stringify(bad), "utf-8");

  const events = listStoryEventsFromStore(store);
  const byId = new Map(events.map((ev) => [ev.eventId, ev]));
  assert.equal(byId.get("rogue_9")?.storyCount, 0);
  assert.ok(byId.has("rogue_7"));
  assert.equal(byId.get("rogue_7")?.entryType, "ROGUELIKE");
  assert.ok(events.every((ev) => typeof ev.eventId === "string"));

  const chapters = listStoriesFromStore(store, "rogue_7"); // sort:null must not throw
  assert.deepEqual(
    chapters.map((c) => [c.storyCode, c.storyName, c.avgTag, c.sortOrder]),
    [["", "", null, 0]],
  );
  assert.ok(searchStoriesFromStore(store, "你好", undefined, undefined, 1, 5).includes("你好"));
});

test("directory store invalidates index when only the supplement changes", () => {
  // behavioral counterpart of the Python descriptor test: the catalog file
  // alone changing must rebuild the search index
  const root = mkdtempSync(join(tmpdir(), "prts-supp-"));
  const store = makeStore(root, "directory");
  const hit = searchStoriesFromStore(store, "独特旁白词项xyz", undefined, undefined, 1, 5);
  assert.ok(hit.includes("rogue_6"));

  const suppPath = join(root, STORY_SUPPLEMENT_PATH);
  const supp = JSON.parse(readFileSync(suppPath, "utf-8"));
  supp.events[0].chapters = supp.events[0].chapters.filter(
    (c: { key: string }) => c.key !== ROGUE_KEY,
  );
  writeFileSync(suppPath, JSON.stringify(supp, null, 2), "utf-8");

  const miss = searchStoriesFromStore(store, "独特旁白词项xyz", undefined, undefined, 1, 5);
  assert.ok(!miss.includes("rogue_6"));
});
