"""Shared lightweight test data builders."""
from __future__ import annotations

import json
from pathlib import Path

# Mirrors config._REQUIRED_OPERATOR_FILES (the _files_complete gate) and
# ts/tests/fixtures/operatorData.ts REQUIRED_OPERATOR_FILES.
REQUIRED_OPERATOR_FILES = (
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
)


def write_minimal_gamedata(root: Path) -> Path:
    """Write the smallest operator dataset needed by tool behavior tests."""
    excel = root / "zh_CN" / "gamedata" / "excel"
    excel.mkdir(parents=True, exist_ok=True)

    (excel / "character_table.json").write_text(
        json.dumps(
            {
                "char_002_amiya": {
                    "name": "阿米娅",
                    "appellation": "Amiya",
                    "displayNumber": "R001",
                    "description": "<@ba.kw>法术伤害</>",
                    "rarity": "TIER_5",
                    "profession": "CASTER",
                    "subProfessionId": "corecaster",
                    "position": "RANGED",
                    "nationId": "rhodes",
                    "groupId": "",
                    "teamId": "",
                    "tagList": ["输出", "支援"],
                    "itemUsage": "罗德岛的公开领袖。",
                    "itemDesc": "阿米娅的信物。",
                    "itemObtainApproach": "主线获得",
                    "talents": [
                        {
                            "candidates": [
                                {"name": "？？？", "description": ""},
                                {
                                    "name": "情绪吸收",
                                    "description": "攻击回复技力",
                                    "unlockCondition": {"phase": "PHASE_1", "level": 1},
                                    "requiredPotentialRank": 0,
                                },
                                {
                                    "name": "情绪吸收",
                                    "description": "攻击回复技力<@ba.talpu>（+2）</>",
                                    "unlockCondition": {"phase": "PHASE_2", "level": 1},
                                    "requiredPotentialRank": 4,
                                },
                            ]
                        }
                    ],
                    "skills": [
                        {"skillId": "skchr_amiya_1"},
                        {"skillId": "skchr_amiya_2"},
                        {"skillId": "skchr_amiya_3"},
                    ],
                    # Keyframes mirror the real Amiya values (PRTS Wiki
                    # publishes exactly these levels: E0 Lv1/Lv50, E1 Lv70,
                    # E2 Lv80); E1 attack time deviates to exercise decimal
                    # interpolation.
                    "phases": [
                        {
                            "maxLevel": 50,
                            "attributesKeyFrames": [
                                {"level": 1, "data": {"maxHp": 699, "atk": 276, "def": 48, "magicResistance": 10.0, "cost": 18, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}},
                                {"level": 50, "data": {"maxHp": 958, "atk": 390, "def": 81, "magicResistance": 10.0, "cost": 18, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}},
                            ],
                        },
                        {
                            "maxLevel": 70,
                            "attributesKeyFrames": [
                                {"level": 1, "data": {"maxHp": 958, "atk": 390, "def": 81, "magicResistance": 15.0, "cost": 19, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}},
                                {"level": 70, "data": {"maxHp": 1198, "atk": 514, "def": 110, "magicResistance": 15.0, "cost": 20, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 2.0, "respawnTime": 70}},
                            ],
                        },
                        {
                            "maxLevel": 80,
                            "attributesKeyFrames": [
                                {"level": 1, "data": {"maxHp": 1198, "atk": 514, "def": 110, "magicResistance": 20.0, "cost": 20, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}},
                                {"level": 80, "data": {"maxHp": 1480, "atk": 612, "def": 121, "magicResistance": 20.0, "cost": 20, "blockCnt": 1, "attackSpeed": 100.0, "baseAttackTime": 1.6, "respawnTime": 70}},
                            ],
                        },
                    ],
                    "favorKeyFrames": [
                        {"level": 0, "data": {"maxHp": 0, "atk": 0, "def": 0}},
                        {"level": 50, "data": {"maxHp": 200, "atk": 70}},
                    ],
                    "potentialRanks": [
                        {"type": "BUFF", "description": "部署费用-2"},
                        {"type": "BUFF", "description": "攻击力+25"},
                    ],
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (excel / "handbook_info_table.json").write_text(
        json.dumps(
            {
                "handbookDict": {
                    "char_002_amiya": {
                        "storyTextAudio": [
                            {
                                "storyTitle": "档案资料一",
                                "stories": [{"storyText": "阿米娅的档案文本。"}],
                            }
                        ]
                    }
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (excel / "charword_table.json").write_text(
        json.dumps(
            {
                "charWords": {
                    "amiya_001": {
                        "charId": "char_002_amiya",
                        "voiceTitle": "任命助理",
                        "voiceText": "博士，今天也请多指教。",
                    }
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (excel / "story_review_table.json").write_text("{}", encoding="utf-8")
    # Ten levels for skchr_amiya_1 so the mastery labels (专一/专二/专三)
    # are exercised, mirroring the real Amiya S1 progression.
    _skill1_progression = [
        (30, 40, 0), (35, 40, 0), (40, 40, 0), (45, 35, 5), (50, 35, 5),
        (55, 35, 5), (60, 32, 10), (70, 32, 10), (80, 32, 10), (90, 30, 15),
    ]
    _skill1_levels = [
        {
            "name": "战术咏唱",
            "description": "攻击速度<@ba.vup>+{attack_speed}</>，持续{duration}秒",
            "skillType": "MANUAL",
            "durationType": "NONE",
            "duration": 30.0,
            "spData": {
                "spType": "INCREASE_WITH_TIME",
                "spCost": sp_cost,
                "initSp": init_sp,
                "maxChargeTime": 1,
                "levelUpCost": None,
                "increment": 1.0,
            },
            "blackboard": [
                {"key": "attack_speed", "value": float(attack_speed), "valueStr": None},
                {"key": "duration", "value": 30.0, "valueStr": None},
            ],
        }
        for attack_speed, sp_cost, init_sp in _skill1_progression
    ]
    (excel / "skill_table.json").write_text(
        json.dumps(
            {
                "skchr_amiya_1": {
                    "skillId": "skchr_amiya_1",
                    "iconId": None,
                    "hidden": False,
                    "levels": _skill1_levels,
                },
                "skchr_amiya_2": {
                    "skillId": "skchr_amiya_2",
                    "iconId": None,
                    "hidden": False,
                    "levels": [
                        {
                            "name": "精神爆发",
                            "description": (
                                "攻击力<@ba.vup>+{atk:0%}</>，"
                                "移动速度<@ba.vdown>-{-move_speed:0%}</>，"
                                "有{prob:0.0%}概率使目标<$ba.stun>晕眩</>"
                                "{ABILITY_RANGE_FORWARD_EXTEND}"
                            ),
                            "skillType": "AUTO",
                            "durationType": "AMMO",
                            "duration": 6.0,
                            "spData": {
                                "spType": "INCREASE_WHEN_ATTACK",
                                "spCost": 12,
                                "initSp": 0,
                                "maxChargeTime": 3,
                                "levelUpCost": None,
                                "increment": 1.0,
                            },
                            "blackboard": [
                                {"key": "atk", "value": 0.1, "valueStr": None},
                                {"key": "prob", "value": 0.275, "valueStr": None},
                                {"key": "move_speed", "value": -0.35, "valueStr": None},
                            ],
                        },
                        {
                            "name": "精神爆发",
                            "description": (
                                "伤害类型变为{damage_type}，"
                                "连击{times:0}次，倍率{atk_scale:0.0%}，"
                                "另有{extra_hits}次追击"
                            ),
                            "skillType": "AUTO",
                            "durationType": "AMMO",
                            "duration": 8.0,
                            "spData": {
                                "spType": "INCREASE_WHEN_ATTACK",
                                "spCost": 10,
                                "initSp": 0,
                                "maxChargeTime": 3,
                                "levelUpCost": None,
                                "increment": 1.0,
                            },
                            "blackboard": [
                                {"key": "damage_type", "value": None, "valueStr": "法术"},
                                {"key": "times", "value": 6.0, "valueStr": None},
                                {"key": "atk_scale", "value": 1.15, "valueStr": None},
                                # Zero is falsy but numeric — must render "0".
                                {"key": "extra_hits", "value": 0, "valueStr": None},
                            ],
                        },
                    ],
                },
                "skchr_amiya_3": {
                    "skillId": "skchr_amiya_3",
                    "iconId": None,
                    "hidden": False,
                    "levels": [
                        {
                            # Real passives: spType is the integer sentinel 8
                            # and duration carries the -1 "no duration" marker.
                            "name": "奇美拉",
                            "description": (
                                "被动效果：每击使敌人防御力-{-def}，"
                                "并使其晕眩{stun}秒"
                            ),
                            "skillType": "PASSIVE",
                            "durationType": "NONE",
                            "duration": -1,
                            "spData": {
                                "spType": 8,
                                "spCost": None,
                                "initSp": None,
                                "maxChargeTime": None,
                                "levelUpCost": None,
                                "increment": None,
                            },
                            "blackboard": [
                                {"key": "def", "value": -330.0, "valueStr": None},
                                {"key": "stun", "value": 2.0, "valueStr": None},
                            ],
                        }
                    ],
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (excel / "item_table.json").write_text(
        json.dumps({"items": {}}, ensure_ascii=False), encoding="utf-8"
    )
    (excel / "building_data.json").write_text(
        json.dumps(
            {
                "chars": {
                    "char_002_amiya": {
                        "buffChar": [
                            {
                                "buffData": [
                                    {
                                        "buffId": "control_tra_spd[000]",
                                        "cond": {"phase": "PHASE_0", "level": 1},
                                    }
                                ]
                            },
                            {
                                "buffData": [
                                    {
                                        "buffId": "dorm_rec_all[000]",
                                        "cond": {"phase": "PHASE_0", "level": 1},
                                    },
                                    {
                                        "buffId": "dorm_rec_all[010]",
                                        "cond": {"phase": "PHASE_2", "level": 1},
                                    },
                                ]
                            },
                        ]
                    }
                },
                "buffs": {
                    "control_tra_spd[000]": {
                        "buffId": "control_tra_spd[000]",
                        "buffName": "合作协议",
                        "roomType": "CONTROL",
                        "description": (
                            "进驻控制中枢时，所有贸易站订单效率"
                            "<@cc.vup>+7%</>（同种效果取最高）"
                        ),
                    },
                    "dorm_rec_all[000]": {
                        "buffId": "dorm_rec_all[000]",
                        "buffName": "热情",
                        "roomType": "DORMITORY",
                        "description": "进驻宿舍时，恢复<@cc.vup>+0.1</>",
                    },
                    "dorm_rec_all[010]": {
                        "buffId": "dorm_rec_all[010]",
                        "buffName": "热情",
                        "roomType": "DORMITORY",
                        "description": "进驻宿舍时，恢复<@cc.vup>+0.25</>",
                    },
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return excel


# ---------------------------------------------------------------------------
# Roguelike story supplement fixture (shared by story test modules; mirror:
# ts/tests/fixtures/storySupplement.ts)
# ---------------------------------------------------------------------------

STORY_SUPPLEMENT_PATH = "zh_CN/story_supplement.json"
ROGUE_ENDING_KEY = "Obt/Roguelike/RO6/level_rogue6_ending_1"
ROGUE_MONTH_KEY = "Obt/Rogue/rogue_6/MonthRecord/month_record_rogue_6_4_1"


def story_supplement_files() -> dict[str, object]:
    """The supplement catalog plus its two chapter JSONs."""
    return {
        STORY_SUPPLEMENT_PATH: {
            "version": 1,
            "generated_from": {
                "tables": ["gamedata/excel/roguelike_topic_table.json"],
                "source_version": "v-test",
            },
            "events": [
                {
                    "event_id": "rogue_6",
                    "name": "沉沦者的黑流树海",
                    "entry_type": "ROGUELIKE",
                    "sort": 6,
                    "chapters": [
                        {"key": ROGUE_ENDING_KEY, "name": "强制重启", "code": "RO6-E1",
                         "avg_tag": "结局", "sort": 110, "group": "ending",
                         "source": "topic:endbook.avgId"},
                        {"key": ROGUE_MONTH_KEY, "name": "南方往事·1", "code": "RO6-M4-1",
                         "avg_tag": "月度记录·南方往事", "sort": 10401, "group": "month",
                         "source": "topic:chat.chatStoryId"},
                    ],
                },
            ],
        },
        f"zh_CN/gamedata/story/{ROGUE_ENDING_KEY}.json": {
            "storyCode": "RO6-E1",
            "storyName": "强制重启",
            "avgTag": "结局",
            "eventName": "沉沦者的黑流树海",
            "storyInfo": "官方梗概：强制重启。",
            "storyList": [
                {"prop": "name", "attributes": {"name": "卡德霍", "content": "落幕。"}},
            ],
        },
        f"zh_CN/gamedata/story/{ROGUE_MONTH_KEY}.json": {
            "storyCode": "RO6-M4-1",
            "storyName": "南方往事·1",
            "avgTag": "月度记录·南方往事",
            "eventName": "沉沦者的黑流树海",
            "storyInfo": "",
            "storyList": [
                {"prop": "name", "attributes": {"name": "", "content": "独特旁白词项xyz。"}},
                {"prop": "name", "attributes": {"name": "帕尤卡卡", "content": "蛋糕烤好了。"}},
            ],
        },
    }
