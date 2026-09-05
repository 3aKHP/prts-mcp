import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { ZipStore } from "../src/data/stores.ts";
import { buildStoriesListingFromStore } from "../src/data/storyReader.ts";
import { getStorySummaryFromStore } from "../src/data/storySummary.ts";
import {
  buildCharacterAppearances,
  buildOperatorMemoirs,
  buildSpeakersInEvent,
  buildStoriesListing,
  buildStoryEventsListing,
  renderCharacterAppearances,
  renderOperatorMemoirs,
  renderSpeakersInEvent,
  renderStoriesListing,
  renderStoryEventsListing,
} from "../src/data/story.ts";

const STORY_REVIEW_PATH = "zh_CN/gamedata/excel/story_review_table.json";
const CHARDICT_PATH = "zh_CN/chardict.json";
const STORYINFO_PATH = "zh_CN/storyinfo.json";
const EVENT_SUMMARIES_PATH = "zh_CN/event_summaries.json";

const FIRST_STORY_KEY = "activities/act_test/level_act_test_01_beg";
const SECOND_STORY_KEY = "activities/act_test/level_act_test_02_end";
const NO_SUMMARY_STORY_KEY = "activities/act_no_summary/level_act_no_summary_01";
const NO_SUMMARY_SECOND_STORY_KEY = "activities/act_no_summary/level_act_no_summary_02";
const NARRATION_STORY_KEY = "activities/act_narration/level_act_narration_01";
const MEMOIR_STORY_KEY = "memory/amiya/level_amiya_01";

for (const llm of [" LLM summary. ", " ", "", null, 42]) {
  test(`listing and summary share fallbacks: ${JSON.stringify(llm)}`, () => {
    const zip = new AdmZip();
    const files = {
      [STORY_REVIEW_PATH]: { act: { infoUnlockDatas: [{ storyTxt: "chapter" }] } },
      "zh_CN/summaries.json": { chapter: llm },
      [STORYINFO_PATH]: { chapter: " Official summary. " },
      [EVENT_SUMMARIES_PATH]: { act: "Event summary." },
    };
    for (const [name, value] of Object.entries(files)) zip.addFile(name, Buffer.from(JSON.stringify(value)));
    const path = join(mkdtempSync(join(tmpdir(), "summary-fallback-")), "story.zip");
    zip.writeZip(path);
    const store = new ZipStore(path);
    try {
      const result = buildStoriesListingFromStore(store, "act", true);
      const expected = typeof llm === "string" && llm.trim() ? llm.trim() : "Official summary.";
      assert.equal(result.chapters[0]?.summary, expected);
      assert.equal(getStorySummaryFromStore(store, "chapter"), expected);
      assert.equal(result.event_summary, "Event summary.");
    } finally {
      store.close();
    }
  });
}

function storyPath(storyKey: string): string {
  return `zh_CN/gamedata/story/${storyKey}.json`;
}

test("summary sources fail independently and fall back to chapter", () => {
  const zip = new AdmZip();
  const files = {
    [STORY_REVIEW_PATH]: { act: { infoUnlockDatas: [{ storyTxt: "chapter" }] } },
    "zh_CN/summaries.json": [],
    [storyPath("chapter")]: { storyInfo: " Embedded summary. " },
    [EVENT_SUMMARIES_PATH]: { act: "Event summary." },
  };
  for (const [name, value] of Object.entries(files)) zip.addFile(name, Buffer.from(JSON.stringify(value)));
  zip.addFile(STORYINFO_PATH, Buffer.from("{broken"));
  const path = join(mkdtempSync(join(tmpdir(), "summary-embedded-")), "story.zip");
  zip.writeZip(path);
  const store = new ZipStore(path);
  try {
    const listing = buildStoriesListingFromStore(store, "act", true);
    assert.equal(listing.chapters[0]?.summary, "Embedded summary.");
    assert.equal(getStorySummaryFromStore(store, "chapter"), "Embedded summary.");
    assert.equal(listing.event_summary, "Event summary.");
  } finally {
    store.close();
  }
});

function loadParityFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", name), "utf-8"),
  );
}

function storyFiles(): Record<string, unknown> {
  return {
    [STORY_REVIEW_PATH]: {
      act_test: {
        name: "测试活动",
        entryType: "ACTIVITY",
        infoUnlockDatas: [
          { storyTxt: FIRST_STORY_KEY, storyCode: "TEST-1", storyName: "开端", avgTag: "BEG", storySort: 1 },
          { storyTxt: SECOND_STORY_KEY, storyCode: "TEST-2", storyName: "终章", avgTag: "END", storySort: 2 },
        ],
      },
      act_no_summary: {
        name: "无长摘要活动",
        entryType: "ACTIVITY",
        infoUnlockDatas: [
          { storyTxt: NO_SUMMARY_STORY_KEY, storyCode: "NS-1", storyName: "短章", avgTag: null, storySort: 1 },
          { storyTxt: NO_SUMMARY_SECOND_STORY_KEY, storyCode: "NS-2", storyName: "无摘要章", avgTag: null, storySort: 2 },
        ],
      },
      act_narration: {
        name: "纯旁白活动",
        entryType: "ACTIVITY",
        infoUnlockDatas: [
          { storyTxt: NARRATION_STORY_KEY, storyCode: "NAR-1", storyName: "旁白章", avgTag: null, storySort: 1 },
        ],
      },
      act_empty: {
        name: "空活动",
        entryType: "ACTIVITY",
        infoUnlockDatas: [],
      },
      story_amiya_set_1: {
        name: "阿米娅密录",
        entryType: "NONE",
        infoUnlockDatas: [
          { storyTxt: MEMOIR_STORY_KEY, storyCode: "AM-1", storyName: "出发", avgTag: null, storySort: 1 },
        ],
      },
    },
    [STORYINFO_PATH]: {
      [FIRST_STORY_KEY]: "第一章梗概",
      [SECOND_STORY_KEY]: "第二章梗概",
      [NO_SUMMARY_STORY_KEY]: "无长摘要的一句话梗概",
    },
    [EVENT_SUMMARIES_PATH]: {
      act_test: "活动总览",
    },
    [CHARDICT_PATH]: {
      amiya: { name: "阿米娅", id: "char_002_amiya" },
    },
    [storyPath(FIRST_STORY_KEY)]: {
      storyCode: "TEST-1",
      storyName: "开端",
      avgTag: "BEG",
      eventName: "测试活动",
      storyInfo: "第一章梗概",
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
      storyInfo: "第二章梗概",
      storyList: [
        { prop: "name", attributes: { name: "博士", content: "任务完成。阿米娅干得不错。" } },
      ],
    },
    [storyPath(NO_SUMMARY_STORY_KEY)]: {
      storyCode: "NS-1",
      storyName: "短章",
      avgTag: null,
      eventName: "无长摘要活动",
      storyInfo: "无长摘要的一句话梗概",
      storyList: [
        { prop: "name", attributes: { name: "阿米娅", content: "短章台词。" } },
      ],
    },
    [storyPath(NO_SUMMARY_SECOND_STORY_KEY)]: {
      storyCode: "NS-2",
      storyName: "无摘要章",
      avgTag: null,
      eventName: "无长摘要活动",
      storyInfo: "",
      storyList: [
        { prop: "name", attributes: { name: "阿米娅", content: "没有一句话梗概。" } },
      ],
    },
    [storyPath(NARRATION_STORY_KEY)]: {
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

function writeStoryZip(): string {
  const zipPath = join(mkdtempSync(join(tmpdir(), "prts-story-output-test-")), "zh_CN.zip");
  const zip = new AdmZip();
  for (const [innerPath, data] of Object.entries(storyFiles())) {
    zip.addFile(innerPath, Buffer.from(JSON.stringify(data), "utf-8"));
  }
  zip.writeZip(zipPath);
  return zipPath;
}

test("story structural payloads match shared parity fixtures", () => {
  const zipPath = writeStoryZip();

  let data = buildStoryEventsListing(zipPath, "activities");
  assert.deepStrictEqual(data, loadParityFixture("story_events_activities.json"));
  assert.equal(
    renderStoryEventsListing(data),
    "- [ACTIVITY] act_test：测试活动（2 章）\n" +
      "- [ACTIVITY] act_no_summary：无长摘要活动（2 章）\n" +
      "- [ACTIVITY] act_narration：纯旁白活动（1 章）\n" +
      "- [ACTIVITY] act_empty：空活动（0 章）",
  );

  data = buildStoryEventsListing(zipPath, "main");
  assert.deepStrictEqual(data, loadParityFixture("story_events_empty.json"));
  assert.equal(renderStoryEventsListing(data), "未找到符合条件的活动（category='main'）。");

  const stories = buildStoriesListing(zipPath, "act_test", false);
  assert.deepStrictEqual(stories, loadParityFixture("list_stories.json"));
  assert.equal(
    renderStoriesListing(stories),
    `- TEST-1 [BEG] 开端（key: ${FIRST_STORY_KEY}）\n` +
      `- TEST-2 [END] 终章（key: ${SECOND_STORY_KEY}）`,
  );

  const storiesWithSummaries = buildStoriesListing(zipPath, "act_test", true);
  assert.deepStrictEqual(storiesWithSummaries, loadParityFixture("list_stories_with_summaries.json"));
  assert.equal(
    renderStoriesListing(storiesWithSummaries),
    "活动总览\n\n" +
      `- TEST-1 [BEG] 开端（key: ${FIRST_STORY_KEY}）\n` +
      "  第一章梗概\n" +
      `- TEST-2 [END] 终章（key: ${SECOND_STORY_KEY}）\n` +
      "  第二章梗概",
  );

  const noSummary = buildStoriesListing(zipPath, "act_no_summary", true);
  assert.deepStrictEqual(noSummary, loadParityFixture("list_stories_no_summary.json"));
  assert.equal(
    renderStoriesListing(noSummary),
    `- NS-1 短章（key: ${NO_SUMMARY_STORY_KEY}）\n` +
      "  无长摘要的一句话梗概\n" +
      `- NS-2 无摘要章（key: ${NO_SUMMARY_SECOND_STORY_KEY}）`,
  );

  const emptyStories = buildStoriesListing(zipPath, "act_empty");
  assert.deepStrictEqual(emptyStories, loadParityFixture("list_stories_empty_event.json"));
  assert.equal(renderStoriesListing(emptyStories), "活动 'act_empty' 暂无剧情章节。");

  const memoirs = buildOperatorMemoirs(zipPath, "阿米娅");
  assert.deepStrictEqual(memoirs, loadParityFixture("operator_memoirs.json"));
  assert.equal(
    renderOperatorMemoirs(memoirs),
    "# 阿米娅（code: amiya，id: char_002_amiya）\n" +
      "共 1 章密录\n\n" +
      `- AM-1 出发（key: ${MEMOIR_STORY_KEY}）`,
  );

  const appearances = buildCharacterAppearances(zipPath, "博士");
  assert.deepStrictEqual(appearances, loadParityFixture("character_appearances.json"));
  assert.equal(
    renderCharacterAppearances(appearances),
    "# 「博士」的出场（共 2 章）\n" +
      `- [speaks+mentioned] act_test / TEST-1 开端（key: ${FIRST_STORY_KEY}）\n` +
      `- [speaks] act_test / TEST-2 终章（key: ${SECOND_STORY_KEY}）`,
  );

  const emptyAppearances = buildCharacterAppearances(zipPath, "不存在", "act_test");
  assert.deepStrictEqual(emptyAppearances, loadParityFixture("character_appearances_empty.json"));
  assert.equal(
    renderCharacterAppearances(emptyAppearances),
    "未找到「不存在」的出场记录。（限定活动：'act_test'）",
  );

  const speakers = buildSpeakersInEvent(zipPath, "act_test");
  assert.deepStrictEqual(speakers, loadParityFixture("speakers_in_event.json"));
  assert.equal(
    renderSpeakersInEvent(speakers),
    "# act_test 的发言角色（共 2 位）\n- 博士（2 句）\n- 阿米娅（1 句）",
  );

  const emptySpeakers = buildSpeakersInEvent(zipPath, "act_narration");
  assert.deepStrictEqual(emptySpeakers, loadParityFixture("speakers_in_event_empty.json"));
  assert.equal(renderSpeakersInEvent(emptySpeakers), "活动 'act_narration' 暂无对话发言者数据。");
});
