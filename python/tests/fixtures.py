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
                                {"name": "情绪吸收", "description": "攻击回复技力"},
                            ]
                        }
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
