"""Tests for the combat-skill (skill_table.json) reader."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

from prts_mcp.data.search import build_search
from prts_mcp.data.skill import (
    build_operator_skills,
    build_skill_search,
    clear_skill_caches,
    format_placeholder_value,
    render_operator_skills,
    render_skill_description,
    render_skill_search,
)

from tests.fixtures import REQUIRED_OPERATOR_FILES, write_minimal_gamedata


def _load_parity_fixture(name: str) -> dict:
    path = Path(__file__).parents[2] / "tests" / "parity-fixtures" / name
    return json.loads(path.read_text(encoding="utf-8"))


def setup_function() -> None:
    clear_skill_caches()


def teardown_function() -> None:
    clear_skill_caches()


def test_placeholder_formats_closed_set() -> None:
    # Closed format set observed across all 1795 skill_table entries in the
    # 2.8.0 scan: "", "0", "0.0", "0%", "0.0%". Unknown formats must keep the
    # literal token (fail-open against upstream format drift).
    assert format_placeholder_value(10.0, "") == "10"
    assert format_placeholder_value(2.6, "") == "2.6"
    assert format_placeholder_value(0.05, "0%") == "5%"
    assert format_placeholder_value(1.15, "0.0%") == "115.0%"
    assert format_placeholder_value(0.275, "0.0%") == "27.5%"
    assert format_placeholder_value(6.0, "0") == "6"
    assert format_placeholder_value(2.25, "0.0") == "2.3"
    assert format_placeholder_value(1.0, "F1") is None
    assert format_placeholder_value(-0.125, "0%") == "-13%"  # half away from zero


def test_render_description_substitution_matrix() -> None:
    blackboard = [
        {"key": "times", "value": 10.0, "valueStr": None},
        {"key": "atk_scale", "value": 2.6, "valueStr": None},
        {"key": "tag", "value": None, "valueStr": "法术"},
    ]
    rendered = render_skill_description(
        "造成<@ba.vup>{atk_scale:0%}</>伤害{times}次，类型{tag}，"
        "未知{ABILITY_RANGE_FORWARD_EXTEND}",
        blackboard,
    )
    assert rendered == (
        "造成260%伤害10次，类型法术，未知{ABILITY_RANGE_FORWARD_EXTEND}"
    )


def test_operator_skills_golden_and_parity(tmp_path: Path) -> None:
    write_minimal_gamedata(tmp_path)
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)

        data = build_operator_skills("阿米娅")
        assert isinstance(data, dict)
        assert data == _load_parity_fixture("operator_skills.json")

        # Mastery labeling, SP suffix, ammo/charge rendering, passive omission.
        markdown = render_operator_skills(data)
        assert markdown.startswith("# 阿米娅 - 战斗技能")
        assert "## 战术咏唱（手动，自动回复）" in markdown
        assert "- **Lv1**：攻击速度+30，持续30秒（SP 40，持续 30 秒）" in markdown
        assert "- **Lv2**：攻击速度+35，持续30秒（SP 35，初始 5，持续 30 秒）" in markdown
        assert "弹药 6 发" in markdown and "可充能 3 次" in markdown
        assert "## 奇美拉（被动）" in markdown
        assert "SP" not in markdown.split("## 奇美拉")[1].split("##")[0]

        missing = build_operator_skills("不存在")
        assert missing == "未找到干员 '不存在'。请使用游戏内中文名称（如'阿米娅'）。"


def test_skill_search_golden_empty_and_dispatch(tmp_path: Path) -> None:
    write_minimal_gamedata(tmp_path)
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)

        routed = build_search("skills", "晕眩")
        assert routed == _load_parity_fixture("search_skills.json")
        assert render_skill_search(routed) == (
            "# 搜索 \"晕眩\" 的结果（共 2 条）\n"
            "- **阿米娅**｜精神爆发：伤害类型变为法术，连击6次，倍率115.0%\n"
            "- **阿米娅**｜奇美拉：被动效果：每击使敌人晕眩2秒"
        )

        empty = build_skill_search("不存在")
        assert empty == _load_parity_fixture("search_skills_empty.json")
        assert render_skill_search(empty) == "未找到匹配 '不存在' 的干员战斗技能。"

        unsupported = build_search("no_such_scope", "x")
        assert unsupported == (
            "不支持的搜索域：'no_such_scope'。"
            "可选：operators、enemies、stages、items、building_skills、skills。"
        )


def _write_skill(excel: Path, data: object) -> None:
    excel.mkdir(parents=True, exist_ok=True)
    # Sentinel tables for config's _files_complete gate.
    for sentinel in REQUIRED_OPERATOR_FILES:
        (excel / sentinel).write_text("{}", encoding="utf-8")
    (excel / "skill_table.json").write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8"
    )


def test_missing_skill_table_degrades(tmp_path: Path) -> None:
    # Operator data resolvable but no skill_table.json (older user-supplied
    # data root) — the dedicated tool explains the gap, the search scope
    # reports no matches instead of a data error (building_data precedent).
    excel = tmp_path / "zh_CN" / "gamedata" / "excel"
    excel.mkdir(parents=True, exist_ok=True)
    (excel / "character_table.json").write_text(
        json.dumps(
            {"char_002_amiya": {"name": "阿米娅", "skills": [{"skillId": "skchr_amiya_1"}]}},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    for sentinel in REQUIRED_OPERATOR_FILES[1:]:
        (excel / sentinel).write_text("{}", encoding="utf-8")

    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)

        message = build_operator_skills("阿米娅")
        assert isinstance(message, str)
        assert "战斗技能数据文件不存在" in message

        empty = build_skill_search("晕眩")
        assert empty == {
            "scope": "skills",
            "pattern": "晕眩",
            "total": 0,
            "results": [],
        }


def test_wrong_shape_skill_table_degrades(tmp_path: Path) -> None:
    write_minimal_gamedata(tmp_path)
    excel = tmp_path / "zh_CN" / "gamedata" / "excel"
    # Valid JSON, wrong shape: must degrade to a message, not crash.
    (excel / "skill_table.json").write_text("[]", encoding="utf-8")
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)

        message = build_operator_skills("阿米娅")
        assert message == "skill_table.json 顶层不是 JSON 对象。"

        search = build_skill_search("晕眩")
        assert isinstance(search, str)
        assert "skill_table.json 顶层不是 JSON 对象" in search
