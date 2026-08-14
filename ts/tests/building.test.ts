import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_OPERATOR_FILES } from "./fixtures/operatorData.ts";

function tempGamedataRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-building-test-"));
}

async function loadBuildingModule(): Promise<typeof import("../src/data/building.js")> {
  return import(`../src/data/building.ts?cacheBust=${Date.now()}-${Math.random()}`);
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
