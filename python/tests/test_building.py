"""Tests for the base-skill (building_data.json) reader."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

from prts_mcp.data.building import (
    build_building_skill_search,
    building_skills_for,
    clear_building_caches,
    render_building_skill_search,
)
from prts_mcp.data.search import build_search

from tests.fixtures import REQUIRED_OPERATOR_FILES, write_minimal_gamedata


def _load_parity_fixture(name: str) -> dict:
    path = Path(__file__).parents[2] / "tests" / "parity-fixtures" / name
    return json.loads(path.read_text(encoding="utf-8"))


def _write_building(excel: Path, data: dict) -> None:
    excel.mkdir(parents=True, exist_ok=True)
    # Sentinel tables for config's _files_complete gate.
    for sentinel in REQUIRED_OPERATOR_FILES:
        (excel / sentinel).write_text("{}", encoding="utf-8")
    (excel / "building_data.json").write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8"
    )


def setup_function() -> None:
    clear_building_caches()


def teardown_function() -> None:
    clear_building_caches()


def test_skills_extraction_dedup_and_markup(tmp_path: Path) -> None:
    _write_building(tmp_path / "zh_CN" / "gamedata" / "excel", {
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
                "buffName": "合作协议",
                "roomType": "CONTROL",
                "description": (
                    "进驻控制中枢时，每个进驻在制造站的"
                    "<$cc.tag.knight><@cc.kw>骑士</></>干员生产力"
                    "<@cc.vup>+7%</>"
                ),
            },
            "dorm_rec_all[000]": {
                "buffName": "热情",
                "roomType": "DORMITORY",
                "description": "进驻宿舍时，恢复<@cc.vup>+0.1</>",
            },
            "dorm_rec_all[010]": {
                "buffName": "热情",
                "roomType": "DORMITORY",
                "description": "进驻宿舍时，恢复<@cc.vup>+0.25</>",
            },
        },
    })

    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        skills = building_skills_for("char_002_amiya")

    # Two slots -> two records; the dorm slot keeps only the PHASE_2 variant.
    assert skills == [
        {
            "name": "合作协议",
            "room": "控制中枢",
            "description": "进驻控制中枢时，每个进驻在制造站的骑士干员生产力+7%",
            "unlock": "精英0",
        },
        {
            "name": "热情",
            "room": "宿舍",
            "description": "进驻宿舍时，恢复+0.25",
            "unlock": "精英2",
        },
    ]


def test_unknown_char_and_room_passthrough(tmp_path: Path) -> None:
    _write_building(tmp_path / "zh_CN" / "gamedata" / "excel", {
        "chars": {
            "char_999_x": {
                "buffChar": [
                    {
                        "buffData": [
                            {
                                "buffId": "odd_room",
                                "cond": {"phase": "PHASE_1", "level": 1},
                            }
                        ]
                    }
                ]
            }
        },
        "buffs": {
            "odd_room": {
                "buffName": "新房型技能",
                "roomType": "NEW_ROOM",
                "description": "描述",
            },
        },
    })

    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        assert building_skills_for("char_002_amiya") == []
        assert building_skills_for("char_999_x") == [
            {
                "name": "新房型技能",
                "room": "NEW_ROOM",
                "description": "描述",
                "unlock": "精英1",
            },
        ]


def test_missing_table_raises_file_not_found(tmp_path: Path) -> None:
    excel = tmp_path / "zh_CN" / "gamedata" / "excel"
    excel.mkdir(parents=True)
    for sentinel in REQUIRED_OPERATOR_FILES:
        (excel / sentinel).write_text("{}", encoding="utf-8")
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        try:
            building_skills_for("char_002_amiya")
        except FileNotFoundError as exc:
            assert "基建技能数据文件不存在" in str(exc)
        else:
            raise AssertionError("expected FileNotFoundError")


def test_building_skill_search_golden_and_empty(tmp_path: Path) -> None:
    write_minimal_gamedata(tmp_path)
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)

        data = build_building_skill_search("贸易站")

        assert data == _load_parity_fixture("search_building_skills.json")
        assert render_building_skill_search(data) == (
            '# 搜索 "贸易站" 的结果（共 1 条）\n'
            "- **阿米娅**｜合作协议（控制中枢，精英0解锁）："
            "进驻控制中枢时，所有贸易站订单效率+7%（同种效果取最高）"
        )

        empty = build_building_skill_search("不存在")
        assert empty == _load_parity_fixture("search_building_skills_empty.json")
        assert render_building_skill_search(empty) == "未找到匹配 '不存在' 的干员基建技能。"


def test_unified_search_dispatches_building_skills(tmp_path: Path) -> None:
    write_minimal_gamedata(tmp_path)
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)

        routed = build_search("building_skills", "贸易站")
        assert isinstance(routed, dict)
        assert routed["scope"] == "building_skills"

        unsupported = build_search("no_such_scope", "x")
        assert unsupported == (
            "不支持的搜索域：'no_such_scope'。"
            "可选：operators、enemies、stages、items、building_skills。"
        )


def test_corrupt_building_table_degrades_basic_info(tmp_path: Path) -> None:
    write_minimal_gamedata(tmp_path)
    excel = tmp_path / "zh_CN" / "gamedata" / "excel"
    (excel / "building_data.json").write_text("{not json", encoding="utf-8")
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)
        from prts_mcp.data.operator import (
            build_operator_basic_info,
            clear_operator_caches,
        )

        clear_operator_caches()
        try:
            data = build_operator_basic_info("阿米娅")
            # Corrupt building_data.json omits the field instead of
            # crashing the whole tool (pre-2.7.0 payload shape).
            assert isinstance(data, dict)
            assert "building_skills" not in data
            assert data["name"] == "阿米娅"
        finally:
            clear_operator_caches()


def test_wrong_shape_building_table_degrades_basic_info(tmp_path: Path) -> None:
    write_minimal_gamedata(tmp_path)
    excel = tmp_path / "zh_CN" / "gamedata" / "excel"
    # Valid JSON, wrong shape: the guard must convert this to the same
    # ValueError family the callers catch (TS bare-catches everything).
    (excel / "building_data.json").write_text("[]", encoding="utf-8")
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)
        from prts_mcp.data.operator import (
            build_operator_basic_info,
            clear_operator_caches,
        )

        clear_operator_caches()
        try:
            data = build_operator_basic_info("阿米娅")
            assert isinstance(data, dict)
            assert "building_skills" not in data
        finally:
            clear_operator_caches()
