import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REQUIRED_OPERATOR_FILES = [
  "character_table.json",
  "handbook_info_table.json",
  "charword_table.json",
  "story_review_table.json",
  "item_table.json",
] as const;

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data), "utf-8");
}

export function writeMinimalGamedata(root: string): void {
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  writeJson(join(excel, "character_table.json"), {
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
            {
              name: "情绪吸收",
              description: "攻击回复技力",
              unlockCondition: { phase: "PHASE_1", level: 1 },
              requiredPotentialRank: 0,
            },
            {
              name: "情绪吸收",
              description: "攻击回复技力<@ba.talpu>（+2）</>",
              unlockCondition: { phase: "PHASE_2", level: 1 },
              requiredPotentialRank: 4,
            },
          ],
        },
      ],
      skills: [
        { skillId: "skchr_amiya_1" },
        { skillId: "skchr_amiya_2" },
        { skillId: "skchr_amiya_3" },
      ],
      // Keyframes mirror the real Amiya values (PRTS Wiki publishes
      // exactly these levels: E0 Lv1/Lv50, E1 Lv70, E2 Lv80); E1 attack
      // time deviates to exercise decimal interpolation.
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
  });
  writeJson(join(excel, "handbook_info_table.json"), {
    handbookDict: {
      char_002_amiya: {
        storyTextAudio: [
          {
            storyTitle: "档案资料一",
            stories: [{ storyText: "阿米娅的档案文本。" }],
          },
        ],
      },
    },
  });
  writeJson(join(excel, "charword_table.json"), {
    charWords: {
      amiya_001: {
        charId: "char_002_amiya",
        voiceTitle: "任命助理",
        voiceText: "博士，今天也请多指教。",
      },
    },
  });
  writeJson(join(excel, "story_review_table.json"), {});
  writeJson(join(excel, "item_table.json"), { items: {} });
  writeJson(join(excel, "skill_table.json"), {
    "skchr_amiya_1": {
      skillId: "skchr_amiya_1",
      iconId: null,
      hidden: false,
      levels: [
        {
          name: "战术咏唱",
          description: "攻击速度<@ba.vup>+{attack_speed}</>，持续{duration}秒",
          skillType: "MANUAL",
          durationType: "NONE",
          duration: 30.0,
          spData: {
            spType: "INCREASE_WITH_TIME",
            spCost: 40,
            initSp: 0,
            maxChargeTime: 1,
            levelUpCost: null,
            increment: 1.0,
          },
          blackboard: [
            { key: "attack_speed", value: 30.0, valueStr: null },
            { key: "duration", value: 30.0, valueStr: null },
          ],
        },
        {
          name: "战术咏唱",
          description: "攻击速度<@ba.vup>+{attack_speed}</>，持续{duration}秒",
          skillType: "MANUAL",
          durationType: "NONE",
          duration: 30.0,
          spData: {
            spType: "INCREASE_WITH_TIME",
            spCost: 35,
            initSp: 5,
            maxChargeTime: 1,
            levelUpCost: null,
            increment: 1.0,
          },
          blackboard: [
            { key: "attack_speed", value: 35.0, valueStr: null },
            { key: "duration", value: 30.0, valueStr: null },
          ],
        },
      ],
    },
    "skchr_amiya_2": {
      skillId: "skchr_amiya_2",
      iconId: null,
      hidden: false,
      levels: [
        {
          name: "精神爆发",
          description:
            "攻击力<@ba.vup>+{atk:0%}</>，有{prob:0.0%}概率使目标<$ba.stun>晕眩</>{ABILITY_RANGE_FORWARD_EXTEND}",
          skillType: "AUTO",
          durationType: "AMMO",
          duration: 6.0,
          spData: {
            spType: "INCREASE_WHEN_ATTACK",
            spCost: 12,
            initSp: 0,
            maxChargeTime: 3,
            levelUpCost: null,
            increment: 1.0,
          },
          blackboard: [
            { key: "atk", value: 0.1, valueStr: null },
            { key: "prob", value: 0.275, valueStr: null },
          ],
        },
        {
          name: "精神爆发",
          description: "伤害类型变为{damage_type}，连击{times:0}次，倍率{atk_scale:0.0%}",
          skillType: "AUTO",
          durationType: "AMMO",
          duration: 8.0,
          spData: {
            spType: "INCREASE_WHEN_ATTACK",
            spCost: 10,
            initSp: 0,
            maxChargeTime: 3,
            levelUpCost: null,
            increment: 1.0,
          },
          blackboard: [
            { key: "damage_type", value: null, valueStr: "法术" },
            { key: "times", value: 6.0, valueStr: null },
            { key: "atk_scale", value: 1.15, valueStr: null },
          ],
        },
      ],
    },
    "skchr_amiya_3": {
      skillId: "skchr_amiya_3",
      iconId: null,
      hidden: false,
      levels: [
        {
          name: "奇美拉",
          description: "被动效果：每击使敌人晕眩{stun}秒",
          skillType: "PASSIVE",
          durationType: "NONE",
          duration: 0.0,
          spData: null,
          blackboard: [{ key: "stun", value: 2.0, valueStr: null }],
        },
      ],
    },
  });
  writeJson(join(excel, "building_data.json"), {
    chars: {
      char_002_amiya: {
        buffChar: [
          {
            buffData: [
              {
                buffId: "control_tra_spd[000]",
                cond: { phase: "PHASE_0", level: 1 },
              },
            ],
          },
          {
            buffData: [
              {
                buffId: "dorm_rec_all[000]",
                cond: { phase: "PHASE_0", level: 1 },
              },
              {
                buffId: "dorm_rec_all[010]",
                cond: { phase: "PHASE_2", level: 1 },
              },
            ],
          },
        ],
      },
    },
    buffs: {
      "control_tra_spd[000]": {
        buffId: "control_tra_spd[000]",
        buffName: "合作协议",
        roomType: "CONTROL",
        description: "进驻控制中枢时，所有贸易站订单效率<@cc.vup>+7%</>（同种效果取最高）",
      },
      "dorm_rec_all[000]": {
        buffId: "dorm_rec_all[000]",
        buffName: "热情",
        roomType: "DORMITORY",
        description: "进驻宿舍时，恢复<@cc.vup>+0.1</>",
      },
      "dorm_rec_all[010]": {
        buffId: "dorm_rec_all[010]",
        buffName: "热情",
        roomType: "DORMITORY",
        description: "进驻宿舍时，恢复<@cc.vup>+0.25</>",
      },
    },
  });
}
