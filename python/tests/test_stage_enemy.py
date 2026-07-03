from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from prts_mcp.data.stage_enemy import (
    build_enemy_appearances,
    build_stage_enemies,
    clear_stage_enemy_caches,
    get_enemy_appearances,
    get_enemy_stage_info,
    get_stage_enemies,
    render_enemy_appearances,
    render_stage_enemies,
)


def _load_parity_fixture(name: str) -> dict:
    path = Path(__file__).parents[2] / "tests" / "parity-fixtures" / name
    return json.loads(path.read_text(encoding="utf-8"))


def _write_fixture(root: Path) -> None:
    excel = root / "gamedata" / "zh_CN" / "gamedata" / "excel"
    levels = root / "gamedata-levels" / "zh_CN" / "gamedata" / "levels"
    db_root = levels / "enemydata"
    level_root = levels / "obt" / "main"
    excel.mkdir(parents=True)
    db_root.mkdir(parents=True)
    level_root.mkdir(parents=True)

    for fname in (
        "character_table.json",
        "handbook_info_table.json",
        "charword_table.json",
        "story_review_table.json",
        "item_table.json",
    ):
        (excel / fname).write_text("{}", encoding="utf-8")

    (excel / "stage_table.json").write_text(
        json.dumps(
            {
                "stages": {
                    "main_00-01": {
                        "stageId": "main_00-01",
                        "code": "0-1",
                        "name": "坍塌",
                        "levelId": "Obt/Main/level_main_00-01",
                    },
                    "empty_stage": {
                        "stageId": "empty_stage",
                        "code": "EMPTY",
                        "name": "空关",
                        "levelId": None,
                    },
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (excel / "enemy_handbook_table.json").write_text(
        json.dumps(
            {
                "enemyData": {
                    "enemy_1007_slime": {"enemyId": "enemy_1007_slime", "name": "源石虫"},
                    "enemy_1002_nsabr": {"enemyId": "enemy_1002_nsabr", "name": "士兵"},
                    "enemy_unused": {"enemyId": "enemy_unused", "name": "未出场敌人"},
                    "enemy_custom": {"enemyId": "enemy_custom", "name": "特殊敌人"},
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (db_root / "enemy_database.json").write_text(
        json.dumps(
            {
                "enemies": [
                    {
                        "Key": "enemy_1007_slime",
                        "Value": [
                            {
                                "level": 0,
                                "enemyData": {
                                    "attributes": {
                                        "maxHp": {"m_defined": True, "m_value": 550},
                                        "atk": {"m_defined": True, "m_value": 130},
                                        "def": {"m_defined": True, "m_value": 0},
                                        "magicResistance": {"m_defined": True, "m_value": 0},
                                        "moveSpeed": {"m_defined": True, "m_value": 1.0},
                                        "baseAttackTime": {"m_defined": True, "m_value": 1.7},
                                    }
                                },
                            }
                        ],
                    },
                    {
                        "Key": "enemy_1002_nsabr",
                        "Value": [
                            {
                                "level": 0,
                                "enemyData": {
                                    "attributes": {
                                        "maxHp": {"m_defined": True, "m_value": 1650},
                                        "atk": {"m_defined": True, "m_value": 200},
                                        "def": {"m_defined": True, "m_value": 0},
                                        "magicResistance": {"m_defined": True, "m_value": 0},
                                    }
                                },
                            }
                        ],
                    },
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (level_root / "level_main_00-01.json").write_text(
        json.dumps(
            {
                "enemyDbRefs": [
                    {"id": "enemy_1007_slime", "level": 0, "overwrittenData": None},
                    {
                        "id": "enemy_1002_nsabr",
                        "level": 0,
                        "overwrittenData": {
                            "attributes": {
                                "def": {"m_defined": True, "m_value": 30},
                                "atk": {"m_defined": False, "m_value": 0},
                            }
                        },
                    },
                    {"id": "enemy_unused", "level": 0, "overwrittenData": None},
                    {
                        "id": "enemy_custom",
                        "level": 0,
                        "overwrittenData": {
                            "name": {"m_defined": True, "m_value": "关卡特化敌人"},
                            "attributes": {
                                "maxHp": {"m_defined": True, "m_value": 1234},
                                "atk": {"m_defined": True, "m_value": 321},
                                "def": {"m_defined": True, "m_value": 45},
                                "magicResistance": {"m_defined": True, "m_value": 10},
                            },
                        },
                    },
                ],
                "waves": [
                    {
                        "fragments": [
                            {
                                "actions": [
                                    {"actionType": "SPAWN", "key": "enemy_1007_slime", "count": 6},
                                    {"actionType": "SPAWN", "key": "enemy_1002_nsabr", "count": 1},
                                    {"actionType": "SPAWN", "key": "enemy_custom", "count": 1},
                                ]
                            }
                        ]
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


@pytest.fixture
def gamedata(tmp_path: Path):
    _write_fixture(tmp_path)
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path / "gamedata")}, clear=False):
        clear_stage_enemy_caches()
        yield tmp_path
    clear_stage_enemy_caches()


def test_get_stage_enemies_golden(gamedata: Path) -> None:
    # Golden: exact full markdown for main_00-01 against the fixture.
    # Hardcoded (not tautology) — catches build-layer field omissions,
    # enemy ordering (most_common), and the overwritten-flag/section logic.
    assert get_stage_enemies("main_00-01") == (
        "# 坍塌 0-1（main_00-01） — 敌人列表\n"
        "\n"
        "## 源石虫（enemy_1007_slime）\n"
        "- **出场数量**：6\n"
        "- **敌人等级**：0\n"
        "- **战斗属性**：HP 550；ATK 130；DEF 0；RES 0；移速 1.0；攻击间隔 1.7s\n"
        "\n"
        "## 士兵（enemy_1002_nsabr）\n"
        "- **出场数量**：1\n"
        "- **敌人等级**：0\n"
        "- **关卡覆盖**：是\n"
        "- **战斗属性**：HP 1,650；ATK 200；DEF 30；RES 0\n"
        "\n"
        "## 关卡特化敌人（enemy_custom）\n"
        "- **出场数量**：1\n"
        "- **敌人等级**：0\n"
        "- **关卡覆盖**：是\n"
        "- **战斗属性**：HP 1,234；ATK 321；DEF 45；RES 10"
    )
    data = build_stage_enemies("main_00-01")
    assert data == _load_parity_fixture("stage_enemies.json")
    assert render_stage_enemies(data) == get_stage_enemies("main_00-01")


def test_get_enemy_appearances_golden(gamedata: Path) -> None:
    # Golden: exact full markdown. Hardcoded (not tautology) — catches
    # build-layer field omissions and header/pagination regressions.
    assert get_enemy_appearances("源石虫") == (
        "# 源石虫（enemy_1007_slime）— 出场关卡（共 1 个）\n"
        "- **坍塌** 0-1（main_00-01）：6 个\n"
        "\n"
        "（显示第 1–1 条，共 1 条。使用 offset=50 查看下一页）"
    )
    data = build_enemy_appearances("源石虫")
    assert data == _load_parity_fixture("enemy_appearances.json")
    assert render_enemy_appearances(data) == get_enemy_appearances("源石虫")


def test_get_enemy_appearances_empty_is_structured(gamedata: Path) -> None:
    data = build_enemy_appearances("未出场敌人")
    assert data == _load_parity_fixture("enemy_appearances_empty.json")
    assert render_enemy_appearances(data) == (
        "未找到 未出场敌人（enemy_unused）的实际出场关卡。"
    )


def test_get_enemy_stage_info(gamedata: Path) -> None:
    out = get_enemy_stage_info("士兵", "main_00-01")
    assert "士兵" in out
    assert "出场数量**：1" in out
    assert "关卡覆盖" in out
    assert "DEF 30" in out


def test_empty_or_unknown_stage(gamedata: Path) -> None:
    assert "没有 levelId" in get_stage_enemies("empty_stage")
    assert "未找到关卡" in get_stage_enemies("missing")


def test_missing_levels_data_message(tmp_path: Path) -> None:
    excel = tmp_path / "gamedata" / "zh_CN" / "gamedata" / "excel"
    excel.mkdir(parents=True)
    for fname in (
        "character_table.json",
        "handbook_info_table.json",
        "charword_table.json",
        "story_review_table.json",
    ):
        (excel / fname).write_text("{}", encoding="utf-8")
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path / "gamedata")}, clear=False):
        clear_stage_enemy_caches()
        out = get_stage_enemies("main_00-01")
    assert "关卡战斗数据暂不可用" in out
