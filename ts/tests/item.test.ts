import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempGamedataRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-item-test-"));
}

async function loadItemModule(): Promise<typeof import("../src/data/item.js")> {
  return import(`../src/data/item.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

function loadParityFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", name), "utf-8"),
  );
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
  assert.deepStrictEqual(item.buildItemsListing(), loadParityFixture("list_items.json"));
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
  assert.deepStrictEqual(item.buildItemInfo("源岩"), loadParityFixture("item_info.json"));
});

test("listItems empty payload matches shared parity fixture", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  const data = item.buildItemsListing("NONEXISTENT");
  assert.deepStrictEqual(data, loadParityFixture("list_items_empty.json"));
  if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
  assert.equal(item.renderItemsListing(data), "没有匹配的物品（category=NONEXISTENT）。");
  assert.equal(item.listItems("NONEXISTENT"), "没有匹配的物品（category=NONEXISTENT）。");
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

test("getItemInfo keeps missing optional lists as null", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeFixtures(root);
  const item = await loadItemModule();
  const data = item.buildItemInfo("隐藏物品");
  if (typeof data === "string") assert.fail(`unexpected error: ${data}`);
  assert.equal(data.building_product_list, null);
  assert.equal(data.shop_relate_list, null);
  assert.equal(data.voucher_relate_list, null);
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
