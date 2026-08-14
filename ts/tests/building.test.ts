import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_OPERATOR_FILES, writeMinimalGamedata } from "./fixtures/operatorData.ts";

function tempGamedataRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-building-test-"));
}

async function loadBuildingModule(): Promise<typeof import("../src/data/building.js")> {
  return import(`../src/data/building.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

async function loadSearchModule(): Promise<typeof import("../src/data/search.js")> {
  return import(`../src/data/search.ts?cacheBust=${Date.now()}-${Math.random()}`);
}

function loadParityFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "parity-fixtures", name), "utf-8"),
  );
}

function writeSentinels(excel: string): void {
  mkdirSync(excel, { recursive: true });
  for (const sentinel of REQUIRED_OPERATOR_FILES) {
    writeFileSync(join(excel, sentinel), "{}", "utf-8");
  }
}

test("skills extraction dedups phases and strips markup", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  const excel = join(root, "zh_CN", "gamedata", "excel");
  writeSentinels(excel);
  writeFileSync(join(excel, "building_data.json"), JSON.stringify({
    chars: {
      char_002_amiya: {
        buffChar: [
          {
            buffData: [
              { buffId: "control_tra_spd[000]", cond: { phase: "PHASE_0", level: 1 } },
            ],
          },
          {
            buffData: [
              { buffId: "dorm_rec_all[000]", cond: { phase: "PHASE_0", level: 1 } },
              { buffId: "dorm_rec_all[010]", cond: { phase: "PHASE_2", level: 1 } },
            ],
          },
        ],
      },
    },
    buffs: {
      "control_tra_spd[000]": {
        buffName: "合作协议",
        roomType: "CONTROL",
        description:
          "进驻控制中枢时，每个进驻在制造站的<$cc.tag.knight><@cc.kw>骑士</></>干员生产力<@cc.vup>+7%</>",
      },
      "dorm_rec_all[000]": {
        buffName: "热情",
        roomType: "DORMITORY",
        description: "进驻宿舍时，恢复<@cc.vup>+0.1</>",
      },
      "dorm_rec_all[010]": {
        buffName: "热情",
        roomType: "DORMITORY",
        description: "进驻宿舍时，恢复<@cc.vup>+0.25</>",
      },
    },
  }), "utf-8");
  const building = await loadBuildingModule();

  assert.deepEqual(building.buildingSkillsFor("char_002_amiya"), [
    {
      name: "合作协议",
      room: "控制中枢",
      description: "进驻控制中枢时，每个进驻在制造站的骑士干员生产力+7%",
      unlock: "精英0",
    },
    {
      name: "热情",
      room: "宿舍",
      description: "进驻宿舍时，恢复+0.25",
      unlock: "精英2",
    },
  ]);
});

test("unknown char returns empty, unknown room type passes through", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  const excel = join(root, "zh_CN", "gamedata", "excel");
  writeSentinels(excel);
  writeFileSync(join(excel, "building_data.json"), JSON.stringify({
    chars: {
      char_999_x: {
        buffChar: [
          {
            buffData: [
              { buffId: "odd_room", cond: { phase: "PHASE_1", level: 1 } },
            ],
          },
        ],
      },
    },
    buffs: {
      odd_room: { buffName: "新房型技能", roomType: "NEW_ROOM", description: "描述" },
    },
  }), "utf-8");
  const building = await loadBuildingModule();

  assert.deepEqual(building.buildingSkillsFor("char_002_amiya"), []);
  assert.deepEqual(building.buildingSkillsFor("char_999_x"), [
    { name: "新房型技能", room: "NEW_ROOM", description: "描述", unlock: "精英1" },
  ]);
});

test("missing table surfaces availability and throws on load", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  writeSentinels(join(root, "zh_CN", "gamedata", "excel"));
  const building = await loadBuildingModule();

  assert.equal(building.hasBuildingData(), false);
  assert.throws(() => building.buildingSkillsFor("char_002_amiya"), /基建技能数据文件不存在/);
});

test("building-skill search golden and empty", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);
  const building = await loadBuildingModule();

  const data = building.buildBuildingSkillSearch("贸易站");
  assert.deepEqual(data, loadParityFixture("search_building_skills.json"));
  assert.equal(
    building.renderBuildingSkillSearch(data as import("../src/data/building.js").BuildingSkillSearchPayload),
    [
      '# 搜索 "贸易站" 的结果（共 1 条）',
      "- **阿米娅**｜合作协议（控制中枢，精英0解锁）：进驻控制中枢时，所有贸易站订单效率+7%（同种效果取最高）",
    ].join("\n"),
  );

  const empty = building.buildBuildingSkillSearch("不存在");
  assert.deepEqual(empty, loadParityFixture("search_building_skills_empty.json"));
  assert.equal(
    building.renderBuildingSkillSearch(empty as import("../src/data/building.js").BuildingSkillSearchPayload),
    "未找到匹配 '不存在' 的干员基建技能。",
  );
});

test("unified search dispatches building_skills", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);
  const search = await loadSearchModule();

  const routed = search.buildSearch("building_skills", "贸易站");
  assert.equal(typeof routed, "object");
  assert.equal((routed as { scope: string }).scope, "building_skills");

  assert.equal(
    search.buildSearch("no_such_scope", "x"),
    "不支持的搜索域：'no_such_scope'。可选：operators、enemies、stages、items、building_skills。",
  );
});

test("corrupt building table degrades basic info", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);
  writeFileSync(
    join(root, "zh_CN", "gamedata", "excel", "building_data.json"),
    "{not json",
    "utf-8",
  );
  const operator = await import(`../src/data/operator.ts?cacheBust=${Date.now()}-${Math.random()}`);

  // Corrupt building_data.json omits the field instead of crashing the
  // whole tool (pre-2.7.0 payload shape).
  const data = operator.buildOperatorBasicInfo("阿米娅");
  assert.equal(typeof data, "object");
  assert.equal("building_skills" in (data as object), false);
  assert.equal((data as { name: string }).name, "阿米娅");
});

test("wrong-shape building table degrades basic info", async () => {
  const root = tempGamedataRoot();
  process.env["GAMEDATA_PATH"] = root;
  delete process.env["STORYJSON_PATH"];
  writeMinimalGamedata(root);
  // Valid JSON, wrong shape — must degrade like the corrupt case.
  writeFileSync(
    join(root, "zh_CN", "gamedata", "excel", "building_data.json"),
    "[]",
    "utf-8",
  );
  const operator = await import(`../src/data/operator.ts?cacheBust=${Date.now()}-${Math.random()}`);

  const data = operator.buildOperatorBasicInfo("阿米娅");
  assert.equal(typeof data, "object");
  assert.equal("building_skills" in (data as object), false);
});
