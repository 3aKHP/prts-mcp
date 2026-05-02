"""Shared lightweight test data builders."""
from __future__ import annotations

import json
from pathlib import Path


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
    return excel
