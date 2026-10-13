#!/usr/bin/env node
/**
 * Build the deterministic minimal GameData fixture and record the P0 data
 * manifest (contracts/data-manifest.json).
 *
 * The stage/zone/item tables mirror the shapes used by the frozen TS tests
 * (ts/tests/stage.test.ts writeFixtures) so the oracle's list_stages path is
 * exercised with realistic entries while staying small and byte-stable.
 * The four REQUIRED_OPERATOR_FILES are "{}" sentinels — filesComplete() only
 * checks existence; no operator tool reads them in the P1 scope.
 *
 * Usage: node tools/make-fixtures.mjs [--skip-release-probe]
 *   --skip-release-probe  do not query the GitHub API (offline mode); the
 *                         manifest then records the probe as not-run.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE = join(ROOT, ".reference", "ts-v2.8.1");
const FIXTURE_ROOT = join(ROOT, ".runtime", "fixtures", "minimal-gamedata-v1");
const MANIFEST_PATH = join(ROOT, "contracts", "data-manifest.json");
const UPSTREAM_REPO = "3aKHP/arknights-data-pipeline";
const SKIP_RELEASE_PROBE = process.argv.includes("--skip-release-probe");

const AdmZip = (await import(
  join(REFERENCE, "ts", "node_modules", "adm-zip", "adm-zip.js")
)).default;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeFixture(relPath, data) {
  const target = join(FIXTURE_ROOT, relPath);
  mkdirSync(dirname(target), { recursive: true });
  const text = typeof data === "string" ? data : JSON.stringify(data);
  writeFileSync(target, text, "utf-8");
}

// --- stage_table / zone_table / item_table: lifted from the frozen TS test
// fixture (ts/tests/stage.test.ts @ e0ba360) so the differential corpus matches
// what the oracle's own tests consider representative shapes. ---------------

const STAGE_TABLE = {
  stages: {
    "main_00-01": {
      stageId: "main_00-01",
      code: "0-1",
      name: "坍塌",
      stageType: "MAIN",
      difficulty: "NORMAL",
      zoneId: "main_0",
      levelId: "Obt/Main/level_main_00-01",
      apCost: 6,
      dangerLevel: "LV.1",
      description: "三点方向出现了敌人的先锋部队。",
      stageDropInfo: {
        displayRewards: [{ type: "TKT_RECRUIT", id: "7001", dropType: "ONCE" }],
      },
      unlockCondition: [],
      hardStagedId: "main_00-01#f#",
      bossMark: false,
    },
    "main_00-01#f#": {
      stageId: "main_00-01#f#",
      code: "TR-1",
      name: "坍塌·突袭",
      stageType: "MAIN",
      difficulty: "FOUR_STAR",
      zoneId: "main_0",
      levelId: "Obt/Main/level_main_00-01",
      apCost: 9,
      dangerLevel: "LV.2",
      description: "<@lv.fs>突袭条件</>：敌方生命值提升。",
      stageDropInfo: null,
      unlockCondition: [{ stageId: "main_00-01", completeState: "STAR_3" }],
      hardStagedId: null,
      bossMark: true,
    },
    "act31side_01": {
      stageId: "act31side_01",
      code: "AS-1",
      name: "测试活动关",
      stageType: "ACTIVITY",
      difficulty: "NORMAL",
      zoneId: "act31side_zone1",
      levelId: null,
      apCost: 12,
      dangerLevel: "NORMAL",
      description: "",
      unlockCondition: [{ stageId: "act31side_02", completeState: "PASS" }],
      hardStagedId: null,
      bossMark: false,
    },
    "daily_01": {
      stageId: "daily_01",
      code: "CE-5",
      name: "货物运送",
      stageType: "DAILY",
      difficulty: "NORMAL",
      zoneId: "daily_zone1",
      levelId: "Activities/Daily/level_daily_01",
      apCost: 30,
      dangerLevel: "ELITE",
      description: "高资源产出的每日关卡。",
      stageDropInfo: {
        displayRewards: [
          { type: "GOLD", dropType: "ONCE" },
          { type: "CARD_EXP", dropType: "ONCE" },
        ],
      },
      unlockCondition: [],
      hardStagedId: null,
      bossMark: false,
    },
  },
};

const ZONE_TABLE = {
  zones: {
    main_0: {
      zoneID: "main_0",
      zoneNameFirst: "序章",
      zoneNameSecond: "黑暗时代·上",
    },
    act31side_zone1: {
      zoneID: "act31side_zone1",
      zoneNameFirst: "火山旅梦",
      zoneNameSecond: null,
    },
    daily_zone1: {
      zoneID: "daily_zone1",
      zoneNameFirst: null,
      zoneNameSecond: null,
    },
  },
};

const ITEM_TABLE = {
  items: {
    "7001": {
      itemId: "7001",
      name: "招聘许可",
      hideInItemGet: false,
      classifyType: "NORMAL",
      itemType: "TKT_RECRUIT",
    },
  },
};

// --- build --------------------------------------------------------------------

rmSync(FIXTURE_ROOT, { recursive: true, force: true });
const EXCEL = "zh_CN/gamedata/excel";for (const sentinel of [
  "character_table.json",
  "handbook_info_table.json",
  "charword_table.json",
  "story_review_table.json",
]) {
  writeFixture(join(EXCEL, sentinel), {});
}
writeFixture(join(EXCEL, "stage_table.json"), STAGE_TABLE);
writeFixture(join(EXCEL, "zone_table.json"), ZONE_TABLE);
writeFixture(join(EXCEL, "item_table.json"), ITEM_TABLE);

// Empty dataset for missing-data / service-still-starts differential cases.
const EMPTY_ROOT = join(ROOT, ".runtime", "fixtures", "empty-gamedata-v1");
rmSync(EMPTY_ROOT, { recursive: true, force: true });
mkdirSync(EMPTY_ROOT, { recursive: true });
writeFileSync(join(EMPTY_ROOT, ".keep"), "", "utf-8");

// --- minimal-gamedata-v2: the P3 GameData differential fixture. Combines the
// frozen TS test fixtures (tests/fixtures/operatorData.ts @ e0ba360, the
// enemy/item/stageEnemy writeFixtures) into one volume whose excel AND levels
// sides live under a single GAMEDATA_PATH root, so both implementations
// resolve the same dataset. Covers: talent candidate tiers, decimal
// interpolation, blackboard placeholder formats, passive sentinels, building
// slot best-phase picks, duplicate name folding (operator trap exclusion,
// enemy last-wins, item first-wins), hidden entries, level overrides and the
// AKDP {} placeholder quirk.

const V2_ROOT = join(ROOT, ".runtime", "fixtures", "minimal-gamedata-v2");
rmSync(V2_ROOT, { recursive: true, force: true });

function writeV2(relPath, data) {
  const target = join(V2_ROOT, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data), "utf-8");
}

const V2_EXCEL = "zh_CN/gamedata/excel";
const V2_LEVELS = "zh_CN/gamedata/levels";

// character_table: Amiya verbatim from operatorData.ts (talent tiers,
// keyframes incl. the E1 attackTime 2.0 decimal interpolation case, favor and
// potential frames); 银灰 carries the 4-candidate 领袖 talent from
// operator-talent-cases.json; 夜刀 the single-candidate case; the trap entry
// shares Amiya's name to pin the char_-prefix priority.
writeV2(join(V2_EXCEL, "character_table.json"), {
  char_002_amiya: {
    name: "阿米娅",
    appellation: "Amiya",
    displayNumber: "R001",
    description: "<@ba.kw>法术伤害</>",
    rarity: "TIER_5",
    profession: "CASTER",
    subProfessionId: "corecaster",
    position: "RANGED",
    nationId: "rhodes",
    groupId: "",
    teamId: "",
    tagList: ["输出", "支援"],
    itemUsage: "罗德岛的公开领袖。",
    itemDesc: "阿米娅的信物。",
    itemObtainApproach: "主线获得",
    talents: [
      {
        candidates: [
          { name: "？？？", description: "" },
          { name: "情绪吸收", description: "攻击回复技力", unlockCondition: { phase: "PHASE_1", level: 1 }, requiredPotentialRank: 0 },
          { name: "情绪吸收", description: "攻击回复技力<@ba.talpu>（+2）</>", unlockCondition: { phase: "PHASE_2", level: 1 }, requiredPotentialRank: 4 },
        ],
      },
    ],
    skills: [
      { skillId: "skchr_amiya_1" },
      { skillId: "skchr_amiya_2" },
      { skillId: "skchr_amiya_3" },
    ],
    phases: [
      {
        maxLevel: 50,
        attributesKeyFrames: [
          { level: 1, data: { maxHp: 699, atk: 276, def: 48, magicResistance: 10.0, cost: 18, blockCnt: 1, attackSpeed: 100.0, baseAttackTime: 1.6, respawnTime: 70 } },
          { level: 50, data: { maxHp: 958, atk: 390, def: 81, magicResistance: 10.0, cost: 18, blockCnt: 1, attackSpeed: 100.0, baseAttackTime: 1.6, respawnTime: 70 } },
        ],
      },
      {
        maxLevel: 70,
        attributesKeyFrames: [
          { level: 1, data: { maxHp: 958, atk: 390, def: 81, magicResistance: 15.0, cost: 19, blockCnt: 1, attackSpeed: 100.0, baseAttackTime: 1.6, respawnTime: 70 } },
          { level: 70, data: { maxHp: 1198, atk: 514, def: 110, magicResistance: 15.0, cost: 20, blockCnt: 1, attackSpeed: 100.0, baseAttackTime: 2.0, respawnTime: 70 } },
        ],
      },
      {
        maxLevel: 80,
        attributesKeyFrames: [
          { level: 1, data: { maxHp: 1198, atk: 514, def: 110, magicResistance: 20.0, cost: 20, blockCnt: 1, attackSpeed: 100.0, baseAttackTime: 1.6, respawnTime: 70 } },
          { level: 80, data: { maxHp: 1480, atk: 612, def: 121, magicResistance: 20.0, cost: 20, blockCnt: 1, attackSpeed: 100.0, baseAttackTime: 1.6, respawnTime: 70 } },
        ],
      },
    ],
    favorKeyFrames: [
      { level: 0, data: { maxHp: 0, atk: 0, def: 0 } },
      { level: 50, data: { maxHp: 200, atk: 70 } },
    ],
    potentialRanks: [
      { type: "BUFF", description: "部署费用-2" },
      { type: "BUFF", description: "攻击力+25" },
    ],
  },
  char_291_aglbln: {
    name: "银灰",
    appellation: "SilverAsh",
    displayNumber: "HK01",
    description: "能够自如运用剑技的感染者。",
    rarity: "TIER_6",
    profession: "WARRIOR",
    subProfessionId: "lord",
    position: "MELEE",
    nationId: "kazimierz",
    groupId: "karlan",
    teamId: "",
    tagList: ["输出", "支援"],
    talents: [
      {
        candidates: [
          { name: "领袖", description: "攻击力+5%", unlockCondition: { phase: "PHASE_1", level: 1 }, requiredPotentialRank: 0 },
          { name: "领袖", description: "攻击力+7%", unlockCondition: { phase: "PHASE_1", level: 1 }, requiredPotentialRank: 4 },
          { name: "领袖", description: "攻击力+10%", unlockCondition: { phase: "PHASE_2", level: 1 }, requiredPotentialRank: 0 },
          { name: "领袖", description: "攻击力+12%", unlockCondition: { phase: "PHASE_2", level: 1 }, requiredPotentialRank: 4 },
        ],
      },
    ],
    skills: [
      { skillId: "skchr_aglbln_2" },
      null,
    ],
    phases: [
      {
        maxLevel: 50,
        attributesKeyFrames: [
          { level: 1, data: { maxHp: 903, atk: 245, def: 137, magicResistance: 0, cost: 12, blockCnt: 2, attackSpeed: 100.0, baseAttackTime: 1.3, respawnTime: 70 } },
          { level: 50, data: { maxHp: 1235, atk: 352, def: 200, magicResistance: 0, cost: 12, blockCnt: 2, attackSpeed: 100.0, baseAttackTime: 1.3, respawnTime: 70 } },
        ],
      },
    ],
    favorKeyFrames: [{ level: 50, data: { atk: 60 } }],
    potentialRanks: [{ type: "BUFF", description: "攻击力+30" }],
  },
  char_502_nblade: {
    name: "夜刀",
    appellation: "Yato",
    displayNumber: "A41",
    rarity: "TIER_3",
    profession: "PIONEER",
    subProfessionId: "charger",
    position: "MELEE",
    talents: [
      {
        candidates: [
          { name: "快速重新部署", description: "再部署时间-30秒", unlockCondition: { phase: "PHASE_0", level: 30 }, requiredPotentialRank: 0 },
        ],
      },
    ],
    skills: [],
    phases: [
      {
        maxLevel: 40,
        attributesKeyFrames: [
          { level: 1, data: { maxHp: 684, atk: 178, def: 141, cost: 9, blockCnt: 1, attackSpeed: 100.0, baseAttackTime: 1.05, respawnTime: 18 } },
          { level: 40, data: { maxHp: 972, atk: 261, def: 205, cost: 9, blockCnt: 1, attackSpeed: 100.0, baseAttackTime: 1.05, respawnTime: 18 } },
        ],
      },
    ],
  },
  trap_012_lynx: { name: "阿米娅", appellation: "Lynx" },
});

writeV2(join(V2_EXCEL, "handbook_info_table.json"), {
  handbookDict: {
    char_002_amiya: {
      storyTextAudio: [
        { storyTitle: "档案资料一", stories: [{ storyText: "阿米娅的档案文本。" }] },
        { storyTitle: "档案资料二", stories: [{ storyText: "" }, { storyText: "第二段有效文本{{Trim|边缘}}" }] },
      ],
    },
    char_291_aglbln: {
      storyTextAudio: [
        { storyTitle: "档案资料一", stories: [{ storyText: "雪境的往事。" }] },
      ],
    },
  },
});

writeV2(join(V2_EXCEL, "charword_table.json"), {
  charWords: {
    amiya_001: { charId: "char_002_amiya", voiceTitle: "任命助理", voiceText: "博士，今天也请多指教。" },
    amiya_002: { charId: "char_002_amiya", voiceTitle: "信赖提升后交谈", voiceText: "博士，[[罗德岛|这片土地]]需要我们。" },
    aglbln_001: { charId: "char_291_aglbln", voiceTitle: "闲置", voiceText: "无聊。" },
  },
});

writeV2(join(V2_EXCEL, "story_review_table.json"), {});

writeV2(join(V2_EXCEL, "skill_table.json"), {
  skchr_amiya_1: {
    skillId: "skchr_amiya_1",
    iconId: null,
    hidden: false,
    levels: [
      [30, 40, 0], [35, 40, 0], [40, 40, 0], [45, 35, 5], [50, 35, 5],
      [55, 35, 5], [60, 32, 10], [70, 32, 10], [80, 32, 10], [90, 30, 15],
    ].map(([attackSpeed, spCost, initSp]) => ({
      name: "战术咏唱",
      description: "攻击速度<@ba.vup>+{attack_speed}</>，持续{duration}秒",
      skillType: "MANUAL",
      durationType: "NONE",
      duration: 30.0,
      spData: { spType: "INCREASE_WITH_TIME", spCost, initSp, maxChargeTime: 1, levelUpCost: null, increment: 1.0 },
      blackboard: [
        { key: "attack_speed", value: attackSpeed, valueStr: null },
        { key: "duration", value: 30.0, valueStr: null },
      ],
    })),
  },
  skchr_amiya_2: {
    skillId: "skchr_amiya_2",
    iconId: null,
    hidden: false,
    levels: [
      {
        name: "精神爆发",
        description: "攻击力<@ba.vup>+{atk:0%}</>，移动速度<@ba.vdown>-{-move_speed:0%}</>，有{prob:0.0%}概率使目标<$ba.stun>晕眩</>{ABILITY_RANGE_FORWARD_EXTEND}",
        skillType: "AUTO",
        durationType: "AMMO",
        duration: 6.0,
        spData: { spType: "INCREASE_WHEN_ATTACK", spCost: 12, initSp: 0, maxChargeTime: 3, levelUpCost: null, increment: 1.0 },
        blackboard: [
          { key: "atk", value: 0.1, valueStr: null },
          { key: "prob", value: 0.275, valueStr: null },
          { key: "move_speed", value: -0.35, valueStr: null },
        ],
      },
      {
        name: "精神爆发",
        description: "伤害类型变为{damage_type}，连击{times:0}次，倍率{atk_scale:0.0%}，另有{extra_hits}次追击",
        skillType: "AUTO",
        durationType: "AMMO",
        duration: 8.0,
        spData: { spType: "INCREASE_WHEN_ATTACK", spCost: 10, initSp: 0, maxChargeTime: 3, levelUpCost: null, increment: 1.0 },
        blackboard: [
          { key: "damage_type", value: null, valueStr: "法术" },
          { key: "times", value: 6.0, valueStr: null },
          { key: "atk_scale", value: 1.15, valueStr: null },
          { key: "extra_hits", value: 0, valueStr: null },
        ],
      },
    ],
  },
  skchr_amiya_3: {
    skillId: "skchr_amiya_3",
    iconId: null,
    hidden: false,
    levels: [
      {
        name: "奇美拉",
        description: "被动效果：每击使敌人防御力-{-def}，并使其晕眩{stun}秒",
        skillType: "PASSIVE",
        durationType: "NONE",
        duration: -1,
        spData: { spType: 8, spCost: null, initSp: null, maxChargeTime: null, levelUpCost: null, increment: null },
        blackboard: [
          { key: "def", value: -330.0, valueStr: null },
          { key: "stun", value: 2.0, valueStr: null },
        ],
      },
    ],
  },
});

writeV2(join(V2_EXCEL, "building_data.json"), {
  chars: {
    char_002_amiya: {
      buffChar: [
        { buffData: [{ buffId: "control_tra_spd[000]", cond: { phase: "PHASE_0", level: 1 } }] },
        {
          buffData: [
            { buffId: "dorm_rec_all[000]", cond: { phase: "PHASE_0", level: 1 } },
            { buffId: "dorm_rec_all[010]", cond: { phase: "PHASE_2", level: 1 } },
          ],
        },
      ],
    },
    char_291_aglbln: {
      buffChar: [
        { buffData: [{ buffId: "manu_prod_spd[000]", cond: { phase: "PHASE_1", level: 1 } }] },
      ],
    },
  },
  buffs: {
    "control_tra_spd[000]": { buffId: "control_tra_spd[000]", buffName: "合作协议", roomType: "CONTROL", description: "进驻控制中枢时，所有贸易站订单效率<@cc.vup>+7%</>（同种效果取最高）" },
    "dorm_rec_all[000]": { buffId: "dorm_rec_all[000]", buffName: "热情", roomType: "DORMITORY", description: "进驻宿舍时，恢复<@cc.vup>+0.1</>" },
    "dorm_rec_all[010]": { buffId: "dorm_rec_all[010]", buffName: "热情", roomType: "DORMITORY", description: "进驻宿舍时，恢复<@cc.vup>+0.25</>" },
    "manu_prod_spd[000]": { buffId: "manu_prod_spd[000]", buffName: "雪境守望", roomType: "MANUFACTURE", description: "进驻制造站时，生产力<@cc.vup>+15%</>" },
  },
});

// item_table: item.test.ts entries plus the P0 TKT_RECRUIT drop target.
writeV2(join(V2_EXCEL, "item_table.json"), {
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
});

// stage/zone tables: P0's shapes plus a six-star link and a null-apCost stage
// for get_stage_info branches.
writeV2(join(V2_EXCEL, "stage_table.json"), {
  stages: {
    ...STAGE_TABLE.stages,
    act42side_10: {
      stageId: "act42side_10",
      code: "AS-10",
      name: "空对象占位关",
      stageType: "ACTIVITY",
      difficulty: "NORMAL",
      zoneId: "act31side_zone1",
      levelId: "Obt/Main/level_act42side_10",
      apCost: 12,
      dangerLevel: "NORMAL",
      description: "关卡文件内数组字段为 {} 占位。",
      stageDropInfo: null,
      unlockCondition: [],
      hardStagedId: null,
      sixStarStageId: null,
      bossMark: false,
    },
    "main_00-02": {
      stageId: "main_00-02",
      code: "0-2",
      name: "死线",
      stageType: "MAIN",
      difficulty: "NORMAL",
      zoneId: "main_0",
      levelId: null,
      apCost: null,
      dangerLevel: null,
      description: "",
      stageDropInfo: null,
      unlockCondition: [],
      hardStagedId: null,
      sixStarStageId: "main_00-01#f#",
      bossMark: false,
    },
  },
});
writeV2(join(V2_EXCEL, "zone_table.json"), ZONE_TABLE);

writeV2(join(V2_EXCEL, "enemy_handbook_table.json"), {
  enemyData: {
    enemy_1505_frstar: {
      enemyId: "enemy_1505_frstar",
      enemyIndex: "FN",
      name: "霜星",
      enemyLevel: "BOSS",
      sortId: 100,
      description: "整合运动法术部队干部。",
      attackType: "远程 法术",
      ability: "冰爆控场",
      damageType: ["MAGIC"],
      enemyTags: ["隐匿"],
      hideInHandbook: false,
    },
    enemy_1004_mslime: {
      enemyId: "enemy_1004_mslime",
      enemyIndex: "B0",
      name: "源石虫",
      enemyLevel: "NORMAL",
      sortId: 1,
      description: "野生的被感染生物。",
      damageType: ["PHYSIC", "MAGIC"],
      hideInHandbook: false,
    },
    enemy_hidden: {
      enemyId: "enemy_hidden",
      name: "隐藏敌人",
      enemyLevel: "ELITE",
      sortId: 50,
      description: "应被过滤。",
      hideInHandbook: true,
    },
    enemy_1007_slime: {
      enemyId: "enemy_1007_slime",
      enemyIndex: "B1",
      name: "源石虫",
      enemyLevel: "NORMAL",
      sortId: 2,
      description: "野生的被感染生物（重复名条目，覆盖前者）。",
      hideInHandbook: false,
    },
    enemy_1002_nsabr: { enemyId: "enemy_1002_nsabr", name: "士兵", sortId: 3, enemyLevel: "NORMAL" },
    enemy_unused: { enemyId: "enemy_unused", name: "未出场敌人", sortId: 4, enemyLevel: "NORMAL" },
    enemy_custom: { enemyId: "enemy_custom", name: "特殊敌人", sortId: 5, enemyLevel: "NORMAL" },
  },
});

writeV2(join(V2_LEVELS, "enemydata", "enemy_database.json"), {
  enemies: [
    {
      Key: "enemy_1505_frstar",
      Value: [
        {
          level: 0,
          enemyData: {
            attributes: {
              maxHp: { m_defined: true, m_value: 25000 },
              atk: { m_defined: true, m_value: 420 },
              def: { m_defined: true, m_value: 250 },
              magicResistance: { m_defined: true, m_value: 50.0 },
              moveSpeed: { m_defined: true, m_value: 0.5 },
              baseAttackTime: { m_defined: true, m_value: 3.7 },
              stunImmune: { m_defined: true, m_value: true },
              frozenImmune: { m_defined: true, m_value: true },
            },
            skills: [
              {
                prefabKey: "ArcticBlast",
                cooldown: 8.5,
                blackboard: [
                  { key: "duration", value: 8.0 },
                  { key: "atk_scale", value: 1.5 },
                ],
              },
            ],
          },
        },
      ],
    },
    {
      Key: "enemy_1007_slime",
      Value: [
        {
          level: 0,
          enemyData: {
            attributes: {
              maxHp: { m_defined: true, m_value: 550 },
              atk: { m_defined: true, m_value: 130 },
              def: { m_defined: true, m_value: 0 },
              magicResistance: { m_defined: true, m_value: 0 },
              moveSpeed: { m_defined: true, m_value: 1.0 },
              baseAttackTime: { m_defined: true, m_value: 1.7 },
            },
          },
        },
      ],
    },
    {
      Key: "enemy_1002_nsabr",
      Value: [
        {
          level: "bad",
          enemyData: {
            attributes: {
              maxHp: { m_defined: true, m_value: 1650 },
              atk: { m_defined: true, m_value: 200 },
              def: { m_defined: true, m_value: 0 },
              magicResistance: { m_defined: true, m_value: 0 },
            },
          },
        },
      ],
    },
  ],
});


// --- minimal story zip (P4): the frozen TS story fixtures combined into
// zh_CN.zip — story.test.ts's act_test/main_test chapters, the
// storySupplement.ts roguelike catalog, a chardict with 阿米娅 memoir events,
// summary sources with both override tiers, a pagination-heavy act_big, and
// a NONE non-memoir event that must stay out of the index.

const FIRST_KEY = "activities/act_test/level_act_test_01_beg";
const SECOND_KEY = "activities/act_test/level_act_test_02_end";
const ROGUE_ENDING_KEY = "Obt/Roguelike/RO6/level_rogue6_ending_1";
const ROGUE_MONTH_KEY = "Obt/Rogue/rogue_6/MonthRecord/month_record_rogue_6_4_1";

function bigChapter(n) {
  return {
    storyCode: `BIG-${String(n).padStart(2, "0")}`,
    storyName: `大活动第${n}章`,
    avgTag: null,
    eventName: "大型活动",
    storyInfo: "",
    storyList: [
      { prop: "name", attributes: { name: "阿米娅", content: `第三章第${n}段对话。` } },
      { prop: "name", attributes: { name: "博士", content: "回应一。" } },
      { prop: "name", attributes: { name: "凯尔希", content: "医学报告。" } },
      { prop: "name", attributes: { name: "阿米娅", content: "再次发言。" } },
      { prop: "subtitle", attributes: { text: `场景转换${n}。` } },
    ],
  };
}

const STORY_ZIP_ROOT = join(V2_ROOT, "storyjson");
const storyEntries = [];
const addStory = (path, data) => storyEntries.push([path, JSON.stringify(data)]);

addStory("zh_CN/gamedata/excel/story_review_table.json", {
  act_test: {
    name: "测试活动",
    entryType: "ACTIVITY",
    infoUnlockDatas: [
      { storyTxt: SECOND_KEY, storyCode: "TEST-2", storyName: "终章", avgTag: "END", storySort: 2 },
      { storyTxt: FIRST_KEY, storyCode: "TEST-1", storyName: "开端", avgTag: "BEG", storySort: 1 },
    ],
  },
  main_test: { name: "测试主线", entryType: "MAINLINE", infoUnlockDatas: [] },
  act_big: {
    name: "大型活动",
    entryType: "ACTIVITY",
    infoUnlockDatas: Array.from({ length: 7 }, (_, i) => ({
      storyTxt: `activities/act_big/level_big_${String(i + 1).padStart(2, "0")}`,
      storyCode: `BIG-${String(i + 1).padStart(2, "0")}`,
      storyName: `大活动第${i + 1}章`,
      avgTag: null,
      storySort: i + 1,
    })),
  },
  none_plain: {
    name: "无类型杂项",
    entryType: "NONE",
    infoUnlockDatas: [
      { storyTxt: "misc/none_plain_1", storyCode: "MISC-1", storyName: "杂项一", avgTag: null, storySort: 1 },
    ],
  },
  story_amiya_set_1: {
    name: "阿米娅的糖",
    entryType: "NONE",
    infoUnlockDatas: [
      { storyTxt: "memoir/amy_set_1_1", storyCode: "MS1-1", storyName: "糖之一", avgTag: null, storySort: 1 },
    ],
  },
  story_amiya_set_2: {
    name: "阿米娅的梦",
    entryType: "NONE",
    infoUnlockDatas: [
      { storyTxt: "memoir/amy_set_2_1", storyCode: "MS2-1", storyName: "梦之一", avgTag: null, storySort: 1 },
      { storyTxt: "memoir/amy_set_2_2", storyCode: "MS2-2", storyName: "梦之二", avgTag: null, storySort: 2 },
    ],
  },
});

addStory(`zh_CN/gamedata/story/${FIRST_KEY}.json`, {
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
});
addStory(`zh_CN/gamedata/story/${SECOND_KEY}.json`, {
  storyCode: "TEST-2",
  storyName: "终章",
  avgTag: "END",
  eventName: "测试活动",
  storyInfo: "",
  storyList: [{ prop: "name", attributes: { name: "博士", content: "结束。" } }],
});
for (let i = 1; i <= 7; i++) {
  addStory(`zh_CN/gamedata/story/activities/act_big/level_big_${String(i).padStart(2, "0")}.json`, bigChapter(i));
}
addStory("zh_CN/gamedata/story/misc/none_plain_1.json", {
  storyCode: "MISC-1",
  storyName: "杂项一",
  avgTag: null,
  eventName: "无类型杂项",
  storyInfo: "",
  storyList: [{ prop: "name", attributes: { name: "杂项角色", content: "不应进入索引。" } }],
});
addStory("zh_CN/gamedata/story/memoir/amy_set_1_1.json", {
  storyCode: "MS1-1",
  storyName: "糖之一",
  avgTag: null,
  eventName: "阿米娅的糖",
  storyInfo: "密录官方一句话。",
  storyList: [{ prop: "name", attributes: { name: "阿米娅", content: "糖很好吃。" } }],
});
addStory("zh_CN/gamedata/story/memoir/amy_set_2_1.json", {
  storyCode: "MS2-1",
  storyName: "梦之一",
  avgTag: null,
  eventName: "阿米娅的梦",
  storyInfo: "",
  storyList: [{ prop: "name", attributes: { name: "阿米娅", content: "梦里出现了罗德岛。" } }],
});
addStory("zh_CN/gamedata/story/memoir/amy_set_2_2.json", {
  storyCode: "MS2-2",
  storyName: "梦之二",
  avgTag: null,
  eventName: "阿米娅的梦",
  storyInfo: "",
  storyList: [{ prop: "name", attributes: { name: "阿米娅", content: "梦醒了。" } }],
});
// The supplement fixture's two rogue chapters (storySupplement.ts).
addStory(`zh_CN/gamedata/story/${ROGUE_ENDING_KEY}.json`, {
  storyCode: "RO6-E1",
  storyName: "强制重启",
  avgTag: "结局",
  eventName: "沉沦者的黑流树海",
  storyInfo: "官方梗概：强制重启。",
  storyList: [{ prop: "name", attributes: { name: "卡德霍", content: "落幕。" } }],
});
addStory(`zh_CN/gamedata/story/${ROGUE_MONTH_KEY}.json`, {
  storyCode: "RO6-M4-1",
  storyName: "南方往事·1",
  avgTag: "月度记录·南方往事",
  eventName: "沉沦者的黑流树海",
  storyInfo: "",
  storyList: [
    { prop: "name", attributes: { name: "", content: "独特旁白词项xyz。" } },
    { prop: "name", attributes: { name: "帕尤卡卡", content: "蛋糕烤好了。" } },
  ],
});
addStory("zh_CN/story_supplement.json", {
  version: 1,
  generated_from: { tables: ["gamedata/excel/roguelike_topic_table.json"], source_version: "v-test" },
  events: [
    {
      event_id: "rogue_6",
      name: "沉沦者的黑流树海",
      entry_type: "ROGUELIKE",
      sort: 6,
      chapters: [
        { key: ROGUE_ENDING_KEY, name: "强制重启", code: "RO6-E1", avg_tag: "结局", sort: 110, group: "ending", source: "topic:endbook.avgId" },
        { key: ROGUE_MONTH_KEY, name: "南方往事·1", code: "RO6-M4-1", avg_tag: "月度记录·南方往事", sort: 10401, group: "month", source: "topic:chat.chatStoryId" },
      ],
    },
    // Review-collision case: act_test already exists → supplement ignored.
    { event_id: "act_test", name: "不应覆盖", entry_type: "ROGUELIKE", chapters: [] },
  ],
});
addStory("zh_CN/storyinfo.json", {
  [SECOND_KEY]: "官方级：终章一句话。",
});
addStory("zh_CN/summaries.json", {
  [FIRST_KEY]: "LLM 长摘要：开端发生了什么。",
  [ROGUE_MONTH_KEY]: "LLM：南方往事月度记录。",
});
addStory("zh_CN/event_summaries.json", {
  act_test: "活动级长摘要：测试活动全貌。",
});
addStory("zh_CN/chardict.json", {
  amiya: { name: "阿米娅", id: "char_002_amiya" },
  kalts: { name: "凯尔希", id: "char_003_kalts" },
});

mkdirSync(STORY_ZIP_ROOT, { recursive: true });
buildZip(join(STORY_ZIP_ROOT, "zh_CN.zip"), storyEntries);

const V2_LEVEL_ROOT = join(V2_LEVELS, "obt", "main");
writeV2(join(V2_LEVEL_ROOT, "level_main_00-01.json"), {
  enemyDbRefs: [
    { id: "enemy_1007_slime", level: 0, overwrittenData: null },
    {
      id: "enemy_1002_nsabr",
      level: "bad",
      overwrittenData: {
        attributes: {
          def: { m_defined: true, m_value: 30 },
          atk: { m_defined: false, m_value: 0 },
        },
      },
    },
    { id: "enemy_unused", level: 0, overwrittenData: null },
    {
      id: "enemy_custom",
      level: 0,
      overwrittenData: {
        name: { m_defined: true, m_value: "关卡特化敌人" },
        attributes: {
          maxHp: { m_defined: true, m_value: 1234 },
          atk: { m_defined: true, m_value: 321 },
          def: { m_defined: true, m_value: 45 },
          magicResistance: { m_defined: true, m_value: 10 },
        },
      },
    },
  ],
  waves: [
    {
      fragments: [
        {
          actions: [
            { actionType: "SPAWN", key: "enemy_1007_slime", count: 6 },
            { actionType: "SPAWN", key: "enemy_1002_nsabr", count: 1 },
            { actionType: "SPAWN", key: "enemy_custom", count: 1 },
          ],
        },
      ],
    },
  ],
});
writeV2(join(V2_LEVEL_ROOT, "level_act42side_10.json"), {
  enemyDbRefs: [],
  waves: [
    { fragments: {} },
    { fragments: [{ actions: {} }] },
  ],
});

// --- activated-minimal-v1: a generation volume written by the REAL frozen TS
// sync code (dist syncReleaseArchivePair, offline, local zips + fresh
// release_meta), so differential cases prove both implementations resolve the
// same pair-pointer layout (P2). The generation UUIDs are random; the served
// content equals minimal-gamedata-v1, so list_stages output stays stable.

const ACTIVATED_ROOT = join(ROOT, ".runtime", "fixtures", "activated-minimal-v1");
const ACTIVATED_TAG = "26-10-10-00-00-00_cafe01";
rmSync(ACTIVATED_ROOT, { recursive: true, force: true });


function buildZip(zipPath, entries) {
  const zip = new AdmZip();
  for (const [name, content] of entries) {
    zip.addFile(name, Buffer.from(content, "utf-8"));
  }
  mkdirSync(dirname(zipPath), { recursive: true });
  zip.writeZip(zipPath);
}

const excelZipPath = join(ACTIVATED_ROOT, "gamedata", "archives", "zh_CN-excel.zip");
const levelsZipPath = join(ACTIVATED_ROOT, "gamedata-levels", "archives", "zh_CN-levels.zip");
const fixtureFile = (name) => readFileSync(join(FIXTURE_ROOT, EXCEL, name), "utf-8");
buildZip(
  excelZipPath,
  [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
    "enemy_handbook_table.json",
    "building_data.json",
    "skin_table.json",
    "skill_table.json",
  ].map((name) => [`zh_CN/gamedata/excel/${name}`, "{}"])
    .concat([
      ["zh_CN/gamedata/excel/stage_table.json", fixtureFile("stage_table.json")],
      ["zh_CN/gamedata/excel/zone_table.json", fixtureFile("zone_table.json")],
      ["zh_CN/gamedata/excel/item_table.json", fixtureFile("item_table.json")],
    ]),
);
buildZip(levelsZipPath, [
  ["zh_CN/gamedata/levels/enemydata/enemy_database.json", "{}"],
]);
for (const [zipDir, asset] of [
  [dirname(excelZipPath), "zh_CN-excel.zip"],
  [dirname(levelsZipPath), "zh_CN-levels.zip"],
]) {
  writeFileSync(
    join(zipDir, "release_meta.json"),
    JSON.stringify({
      repo: UPSTREAM_REPO,
      branch: "releases",
      commit_sha: ACTIVATED_TAG,
      fetched_at: "2099-01-01T00:00:00.000Z",
      files: [asset],
    }, null, 2),
    "utf-8",
  );
}

const peerRun = spawnSync(
  process.execPath,
  [join(ROOT, "tools", "ts-interop-peer.mjs"), "write-pair", ACTIVATED_ROOT],
  { encoding: "utf-8", env: { PATH: process.env.PATH, HOME: process.env.HOME } },
);
if (peerRun.status !== 0) {
  throw new Error(`write-pair peer failed: ${peerRun.stderr}`);
}
const pairActivation = JSON.parse(
  peerRun.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop(),
);
if (pairActivation.statuses.some((s) => s !== "updated")) {
  throw new Error(`unexpected activation statuses: ${peerRun.stdout}`);
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out.sort();
}

const fixtureFiles = walkFiles(FIXTURE_ROOT).map((p) => ({
  path: relative(FIXTURE_ROOT, p),
  bytes: statSync(p).size,
  sha256: sha256(p),
}));

const v2Files = walkFiles(V2_ROOT).map((p) => ({
  path: relative(V2_ROOT, p),
  bytes: statSync(p).size,
  sha256: sha256(p),
}));

// --- bundled sample data (repo `data/gamedata`, fixed tag) --------------------

const bundledDir = join(REFERENCE, "data", "gamedata");
const bundledFiles = existsSync(bundledDir)
  ? walkFiles(bundledDir)
      .filter((p) => p.endsWith(".json"))
      .map((p) => ({
        path: relative(bundledDir, p),
        bytes: statSync(p).size,
        sha256: sha256(p),
      }))
  : [];

// --- upstream release probe (records the data-package version axis; no
// archives are downloaded here — full-data snapshots land in later phases) ----

let releaseProbe;
if (SKIP_RELEASE_PROBE) {
  releaseProbe = { status: "not-run", reason: "--skip-release-probe" };
} else {
  try {
    const raw = execFileSync(
      "curl",
      [
        "-sS", "--max-time", "20",
        "-H", "Accept: application/vnd.github+json",
        `https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=10`,
      ],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
    );
    const releases = JSON.parse(raw);
    releaseProbe = {
      status: "ok",
      probed_at: new Date().toISOString().slice(0, 10),
      releases: releases.map((r) => ({
        tag_name: r.tag_name,
        published_at: r.published_at,
        assets: (r.assets ?? []).map((a) => ({
          name: a.name,
          size: a.size,
          browser_download_url: a.browser_download_url,
        })),
      })),
    };
  } catch (err) {
    releaseProbe = { status: "not-run", reason: String(err).slice(0, 300) };
  }
}

const manifest = {
  schema_version: "prts-rust-plan/data-manifest/v1",
  recorded_at: new Date().toISOString(),
  baseline_commit: "e0ba36096cdd46640166b0a5db02902fa9a6a24c",
  datasets: {
    "minimal-gamedata-v1": {
      purpose: "P0/P1 differential fixture for list_stages and protocol cases",
      source: "derived from ts/tests/stage.test.ts writeFixtures @ baseline commit",
      root: ".runtime/fixtures/minimal-gamedata-v1",
      excel_dir: "zh_CN/gamedata/excel",
      files: fixtureFiles,
    },
    "minimal-gamedata-v2": {
      purpose: "P3 differential fixture: full GameData tool surface (operator/enemy/stage/item/search)",
      source: "derived from tests/fixtures/operatorData.ts + enemy/item/stageEnemy test fixtures @ baseline commit",
      root: ".runtime/fixtures/minimal-gamedata-v2",
      excel_dir: "zh_CN/gamedata/excel",
      levels_dir: "zh_CN/gamedata/levels",
      files: v2Files,
    },
    "bundled-sample-gamedata": {
      purpose: "repo-bundled partial excel sample shipped with the fixed tag; reference only",
      source: "git archive e0ba360:data/gamedata",
      root: ".reference/ts-v2.8.1/data/gamedata",
      files: bundledFiles,
    },
    "activated-minimal-v1": {
      purpose: "P2 differential fixture: TS-sync-written generation volume with pair pointer",
      source: "ts dist syncReleaseArchivePair (offline) over minimal-gamedata-v1 content",
      root: ".runtime/fixtures/activated-minimal-v1",
      gamedata_root: "gamedata",
      pair_commit_sha: ACTIVATED_TAG,
      activation: pairActivation,
      files: [
        "gamedata/archives/zh_CN-excel.zip",
        "gamedata/archives/release_meta.json",
        "gamedata-levels/archives/zh_CN-levels.zip",
        "gamedata-levels/archives/release_meta.json",
        ".gamedata_pair.json",
      ].map((rel) => ({
        path: rel,
        bytes: statSync(join(ACTIVATED_ROOT, rel)).size,
        sha256: sha256(join(ACTIVATED_ROOT, rel)),
      })),
      // Generation dir names carry random UUIDs; the CONTENT under them is
      // hashed with the generation segment masked so runs stay comparable.
      generation_content: walkFiles(ACTIVATED_ROOT)
        .filter((p) => p.includes(`${join("", ".releases")}${p.includes("/") ? "/" : "/"}`) || p.includes("/.releases/") || p.split("/").includes(".releases"))
        .map((p) => ({
          path: relative(ACTIVATED_ROOT, p).replace(/\.releases\/[^/]+\//, ".releases/<gen>/"),
          bytes: statSync(p).size,
          sha256: sha256(p),
        })),
    },
  },
  upstream_release_probe: {
    repo: UPSTREAM_REPO,
    note: "version axis of data packages, independent of server release dates; no archives downloaded in P0",
    ...releaseProbe,
  },
  wiki_response_fixtures: {
    status: "not-started",
    note: "P5 scope; P0 records the slot only",
  },
  image_assets: {
    status: "not-started",
    note: "P6 scope; P0 records the slot only",
  },
};

mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
if (!process.argv.includes("--runtime-only")) writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

console.log(`fixture: ${fixtureFiles.length} files under ${relative(ROOT, FIXTURE_ROOT)}`);
console.log(`bundled sample: ${bundledFiles.length} files recorded`);
console.log(`release probe: ${releaseProbe.status}`);
console.log(`manifest: ${relative(ROOT, MANIFEST_PATH)}`);
