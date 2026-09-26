import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempGamedataRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-item-test-"));
}

async function loadItemModule(): Promise<typeof import("../src/data/item.js")> {
  return import(`../src/data/item.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

const SENTINEL_FILES = [
  "character_table.json",
  "handbook_info_table.json",
  "charword_table.json",
  "story_review_table.json",
];

function writeFixtures(root: string): void {
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  for (const f of SENTINEL_FILES) {
    writeFileSync(join(excel, f), "{}", "utf-8");
  }
  writeFileSync(
    join(excel, "item_table.json"),
    JSON.stringify({
      items: {
        "30011": {
          itemId: "30011",
          name: "源岩",
          description: "常见于源石挥发殆尽后的地区。",
          rarity: "TIER_1",
          iconId: "MTL_SL_G1",
          sortId: 100040,
          usage: "可用于多种强化场合。",
          obtainApproach: null,
          hideInItemGet: false,
          classifyType: "MATERIAL",
          itemType: "MATERIAL",
          stageDropList: [
            { stageId: "main_00-01", occPer: "ALWAYS", sortId: 0 },
            { stageId: "main_00-02", occPer: "SOMETIMES", sortId: 1 },
          ],
          buildingProductList: [],
          voucherRelateList: null,
          shopRelateInfoList: null,
        },
        "7001": {
          itemId: "7001",
          name: "招聘许可",
          description: "人事部颁发的许可书。",
          rarity: "TIER_4",
          iconId: "TKT_RECRUIT",
          sortId: 40012,
          usage: "可从公开渠道招聘一位干员。",
          obtainApproach: "采购中心、任务奖励",
          hideInItemGet: false,
          classifyType: "NORMAL",
          itemType: "TKT_RECRUIT",
          stageDropList: [],
          buildingProductList: [],
          voucherRelateList: null,
          shopRelateInfoList: [{ shopId: "credit", itemId: "7001" }],
        },
        hidden: {
          itemId: "hidden",
          name: "隐藏物品",
          hideInItemGet: true,
          classifyType: "NONE",
          itemType: "PLOT_ITEM",
          sortId: 1,
        },
        "dup-source-rock": {
          itemId: "dup-source-rock",
          name: "源岩",
          description: "重复名称条目不应覆盖先出现的物品。",
          hideInItemGet: true,
          classifyType: "NONE",
          itemType: "PLOT_ITEM",
          sortId: 2,
        },
      },
    }),
    "utf-8",
  );
}

test("listItems default", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  const out = item.listItems();
  assert.match(out, /物品列表/);
  assert.match(out, /源岩/);
  assert.match(out, /招聘许可/);
  assert.doesNotMatch(out, /隐藏物品/);
  assert.match(out, /共 2 个/);
});

test("listItems sortId tie-break uses codepoint order", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  for (const f of SENTINEL_FILES) {
    writeFileSync(join(excel, f), "{}", "utf-8");
  }
  // ICU localeCompare folds case and ranks "lower_tie" first ("l" < "u"
  // alphabetically); Python sorted() compares codepoints, so uppercase ids
  // (U+0041–U+005A) precede all lowercase ones (U+0061–).
  writeFileSync(
    join(excel, "item_table.json"),
    JSON.stringify({
      items: {
        lower_tie: {
          itemId: "lower_tie",
          name: "小写物品",
          sortId: 42,
          hideInItemGet: false,
          classifyType: "MATERIAL",
          itemType: "MATERIAL",
        },
        UPPER_TIE: {
          itemId: "UPPER_TIE",
          name: "大写物品",
          sortId: 42,
          hideInItemGet: false,
          classifyType: "MATERIAL",
          itemType: "MATERIAL",
        },
      },
    }),
    "utf-8",
  );
  const item = await loadItemModule();

  const listing = item.listItems();
  const upperPos = listing.indexOf("（id: UPPER_TIE）");
  const lowerPos = listing.indexOf("（id: lower_tie）");
  assert.ok(upperPos !== -1 && lowerPos !== -1);
  assert.ok(upperPos < lowerPos, "uppercase id must sort before lowercase id on sortId tie");

  const found = item.searchItems("物品");
  const upperSearchPos = found.indexOf("（id: UPPER_TIE）");
  const lowerSearchPos = found.indexOf("（id: lower_tie）");
  assert.ok(upperSearchPos !== -1 && lowerSearchPos !== -1);
  assert.ok(upperSearchPos < lowerSearchPos, "search records keep the same tie-break order");
});

test("listItems category filter", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  const out = item.listItems("MATERIAL");
  assert.match(out, /源岩/);
  assert.doesNotMatch(out, /招聘许可/);
  assert.match(out, /共 1 个/);
});

test("getItemInfo by name", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  const out = item.getItemInfo("源岩");
  assert.match(out, /# 源岩/);
  assert.match(out, /ID\*\*：30011/);
  assert.match(out, /T1/);
  assert.match(out, /可用于多种强化场合/);
  assert.match(out, /main_00-01（固定）/);
  assert.match(out, /main_00-02（小概率）/);
});

test("getItemInfo by id", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  const out = item.getItemInfo("7001");
  assert.match(out, /招聘许可/);
  assert.match(out, /采购中心、任务奖励/);
  assert.match(out, /shopId=credit/);
});

test("getItemNameById", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  assert.equal(item.getItemNameById("30011"), "源岩");
  assert.equal(item.getItemNameById("missing"), null);
});

test("searchItems", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  const out = item.searchItems("公开渠道");
  assert.match(out, /招聘许可/);
  assert.match(out, /搜索结果/);
});

test("searchItems invalid regex", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  const out = item.searchItems("[bad");
  assert.match(out, /正则表达式无效/);
});

test("searchItems rejects identity escapes under /u", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  // "\ " is silently tolerated as an identity escape without /u; under /u
  // it is a SyntaxError and must surface as the invalid-regex tool error.
  const out = item.searchItems("\\ ");
  assert.match(out, /正则表达式无效/);
});
