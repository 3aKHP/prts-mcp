import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";
import {
  GAMEDATA_EXCEL,
  GAMEDATA_LEVELS,
  STORY_ZH_CN,
  validateStoryjsonZip,
} from "../src/data/datasets.ts";

const STORY_KEY = "activities/act_test/level_act_test_01_beg";
const STORY_REVIEW_PATH = "zh_CN/gamedata/excel/story_review_table.json";

function tempZipPath(): string {
  const root = mkdtempSync(join(tmpdir(), "prts-datasets-test-"));
  return join(root, "zh_CN.zip");
}

function writeZip(path: string, files: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const zip = new AdmZip();
  for (const [innerPath, data] of Object.entries(files)) {
    zip.addFile(innerPath, Buffer.from(JSON.stringify(data), "utf-8"));
  }
  zip.writeZip(path);
}

test("dataset specs expose expected release asset requirements", () => {
  assert.equal(GAMEDATA_EXCEL.datasetId, "gamedata.excel");
  assert.equal(GAMEDATA_EXCEL.assetName, "zh_CN-excel.zip");
  assert.ok(GAMEDATA_EXCEL.requiredFiles.includes("zh_CN/gamedata/excel/character_table.json"));
  assert.ok(GAMEDATA_EXCEL.requiredFiles.includes("zh_CN/gamedata/excel/enemy_handbook_table.json"));
  assert.ok(GAMEDATA_EXCEL.requiredFiles.includes("zh_CN/gamedata/excel/item_table.json"));
  assert.ok(GAMEDATA_EXCEL.requiredFiles.includes("zh_CN/gamedata/excel/stage_table.json"));
  assert.ok(GAMEDATA_EXCEL.requiredFiles.includes("zh_CN/gamedata/excel/building_data.json"));
  assert.ok(GAMEDATA_EXCEL.requiredFiles.includes("zh_CN/gamedata/excel/skin_table.json"));
  assert.ok(GAMEDATA_EXCEL.requiredFiles.includes("zh_CN/gamedata/excel/skill_table.json"));

  assert.equal(GAMEDATA_LEVELS.datasetId, "gamedata.levels");
  assert.equal(GAMEDATA_LEVELS.assetName, "zh_CN-levels.zip");
  assert.deepEqual(GAMEDATA_LEVELS.requiredFiles, [
    "zh_CN/gamedata/levels/enemydata/enemy_database.json",
  ]);

  assert.equal(STORY_ZH_CN.datasetId, "story.zh_CN");
  assert.equal(STORY_ZH_CN.assetName, "zh_CN.zip");
  assert.deepEqual(STORY_ZH_CN.requiredFiles, [
    "zh_CN/gamedata/excel/story_review_table.json",
    "zh_CN/storyinfo.json",
  ]);
});

test("storyjson zip validation requires referenced story files", () => {
  const zipPath = tempZipPath();
  writeZip(zipPath, {
    "zh_CN/storyinfo.json": {},
    [STORY_REVIEW_PATH]: {
      act_test: {
        infoUnlockDatas: [{ storyTxt: STORY_KEY }],
      },
    },
  });

  assert.deepEqual(validateStoryjsonZip(zipPath), [
    `zh_CN/gamedata/story/${STORY_KEY}.json`,
  ]);
});

test("storyjson zip validation accepts metadata and referenced stories", () => {
  const zipPath = tempZipPath();
  writeZip(zipPath, {
    "zh_CN/storyinfo.json": {},
    [STORY_REVIEW_PATH]: {
      act_test: {
        infoUnlockDatas: [{ storyTxt: STORY_KEY }],
      },
    },
    [`zh_CN/gamedata/story/${STORY_KEY}.json`]: {},
  });

  assert.deepEqual(validateStoryjsonZip(zipPath), []);
});

test("storyjson zip validation checks supplement chapter references", () => {
  const zipPath = tempZipPath();
  writeZip(zipPath, {
    "zh_CN/storyinfo.json": {},
    [STORY_REVIEW_PATH]: { act_test: { infoUnlockDatas: [] } },
    "zh_CN/story_supplement.json": {
      version: 1,
      events: [{
        event_id: "rogue_6", name: "黑流树海", entry_type: "ROGUELIKE",
        chapters: [{ key: "Obt/Roguelike/RO6/level_rogue6_entry", name: "开幕", sort: 1 }],
      }],
    },
  });
  assert.deepEqual(validateStoryjsonZip(zipPath), [
    "zh_CN/gamedata/story/Obt/Roguelike/RO6/level_rogue6_entry.json",
  ]);
});

test("storyjson zip validation accepts a complete supplement", () => {
  const zipPath = tempZipPath();
  writeZip(zipPath, {
    "zh_CN/storyinfo.json": {},
    [STORY_REVIEW_PATH]: { act_test: { infoUnlockDatas: [] } },
    "zh_CN/story_supplement.json": {
      version: 1,
      events: [{
        event_id: "rogue_6", name: "黑流树海", entry_type: "ROGUELIKE",
        chapters: [{ key: "Obt/Roguelike/RO6/level_rogue6_entry", name: "开幕", sort: 1 }],
      }],
    },
    "zh_CN/gamedata/story/Obt/Roguelike/RO6/level_rogue6_entry.json": {},
  });
  assert.deepEqual(validateStoryjsonZip(zipPath), []);
});

test("storyjson zip validation rejects a malformed supplement", () => {
  const zipPath = tempZipPath();
  const zip = new AdmZip();
  zip.addFile("zh_CN/storyinfo.json", Buffer.from("{}", "utf-8"));
  zip.addFile(STORY_REVIEW_PATH, Buffer.from(JSON.stringify({ act_test: { infoUnlockDatas: [] } }), "utf-8"));
  zip.addFile("zh_CN/story_supplement.json", Buffer.from("{not json", "utf-8"));
  zip.writeZip(zipPath);
  const errors = validateStoryjsonZip(zipPath);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("story_supplement.json is unreadable"));
});
