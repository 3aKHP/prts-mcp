import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";
import {
  GAMEDATA_EXCEL,
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
