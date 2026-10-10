"""Tests for the operator stat-panel reader (keyframe interpolation)."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

from prts_mcp.data.operator import clear_operator_caches
from prts_mcp.data.operator_stats import (
    PANEL_FIELDS,
    build_operator_stats,
    interpolate_attributes,
    render_operator_stats,
)

from tests.fixtures import write_minimal_gamedata

# Real Amiya values as published on PRTS Wiki (fetched 2026-10-09): the wiki
# lists exactly the keyframe levels — E0 Lv1, E0 Lv50 (max), E1 Lv70 (max),
# E2 Lv80 (max) — plus the max-trust bonus. These anchor the keyframe model
# against an independent source; mid-level panels follow the community-
# verified linear interpolation with half-away-from-zero rounding.
_WIKI_AMIYA = {
    ("e0", 1): (699, 276, 48, 10),
    ("e0", 50): (958, 390, 81, 10),
    ("e1", 70): (1198, 514, 110, 15),
    ("e2", 80): (1480, 612, 121, 20),
}
_WIKI_AMIYA_TRUST = (200, 70)  # maxHp, atk


def _load_parity_fixture(name: str) -> dict:
    path = Path(__file__).parents[2] / "tests" / "parity-fixtures" / name
    return json.loads(path.read_text(encoding="utf-8"))


def setup_function() -> None:
    clear_operator_caches()


def teardown_function() -> None:
    clear_operator_caches()


def test_interpolation_math_is_hand_verified() -> None:
    frames = {"maxHp": 0, "atk": 100}
    # Midpoint 0.5 must round AWAY from zero (Python's round() would give 0).
    panel = interpolate_attributes({"maxHp": 0}, {"maxHp": 1}, 1, 0, 2)
    assert panel["maxHp"] == 1

    # Amiya E2 Lv40: 1198 + (1480-1198) * 39/79 = 1337.215... -> 1337;
    # atk 514 + 98*39/79 = 562.38 -> 562; def 110 + 11*39/79 = 115.43 -> 115.
    # Fields absent from both frames project as None.
    panel = interpolate_attributes(
        {"maxHp": 1198, "atk": 514, "def": 110},
        {"maxHp": 1480, "atk": 612, "def": 121},
        40, 1, 80,
    )
    assert (panel["maxHp"], panel["atk"], panel["def"]) == (1337, 562, 115)
    assert panel["cost"] is None

    # Non-integral frames keep 2 decimals: 1.6 + 0.4*35/69 = 1.8029 -> 1.8.
    panel = interpolate_attributes({"baseAttackTime": 1.6}, {"baseAttackTime": 2.0}, 36, 1, 70)
    assert panel["baseAttackTime"] == 1.8

    # Degenerate span (single-level frames) takes the upper frame's value.
    panel = interpolate_attributes({"maxHp": 5}, {"maxHp": 99}, 1, 1, 1)
    assert panel["maxHp"] == 99


def test_operator_stats_golden_and_parity(tmp_path: Path) -> None:
    write_minimal_gamedata(tmp_path)
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)

        overview = build_operator_stats("阿米娅")
        assert isinstance(overview, dict)
        assert overview == _load_parity_fixture("operator_stats.json")
        markdown = render_operator_stats(overview)
        assert markdown.startswith("# 阿米娅 - 面板数值")
        assert "## 精英2（Lv1-80）" in markdown
        assert "- 生命上限：Lv1 1198 / Lv满 1480" in markdown
        assert "## 满信赖加成" in markdown and "生命上限+200，攻击+70" in markdown
        assert "## 潜能加成" in markdown and "- 部署费用-2" in markdown

        detail = build_operator_stats("阿米娅", phase=2, level=40)
        assert isinstance(detail, dict)
        assert detail == _load_parity_fixture("operator_stats_level.json")
        assert detail["attributes"]["maxHp"] == 1337
        markdown = render_operator_stats(detail)
        assert "**精英2 Lv40**（上限 Lv80）" in markdown
        assert "- 生命上限：1337" in markdown


def test_operator_stats_validates_phase_level(tmp_path: Path) -> None:
    write_minimal_gamedata(tmp_path)
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)

        assert build_operator_stats("不存在") == (
            "未找到干员 '不存在'。请使用游戏内中文名称（如'阿米娅'）。"
        )
        assert "必须同时提供" in build_operator_stats("阿米娅", phase=2)
        assert "必须同时提供" in build_operator_stats("阿米娅", level=40)
        assert build_operator_stats("阿米娅", phase=3, level=1) == (
            "phase 必须在 0..2 之间（该干员共 3 个精英阶段）。"
        )
        assert build_operator_stats("阿米娅", phase=2, level=81) == (
            "level 必须在 1..80 之间（精英2 的等级上限为 80）。"
        )
        assert build_operator_stats("阿米娅", phase=0, level=1)["attributes"]["maxHp"] == 699


def test_operator_stats_degrades_on_malformed_keyframes(tmp_path: Path) -> None:
    # Hand-made roots may carry phases without keyframes: both the detail
    # path and the overview render must degrade, never raise.
    write_minimal_gamedata(tmp_path)
    excel = tmp_path / "zh_CN" / "gamedata" / "excel"
    table = json.loads((excel / "character_table.json").read_text(encoding="utf-8"))
    table["char_002_amiya"]["phases"][2]["attributesKeyFrames"] = []
    (excel / "character_table.json").write_text(
        json.dumps(table, ensure_ascii=False), encoding="utf-8"
    )
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)

        message = build_operator_stats("阿米娅", phase=2, level=40)
        assert message == "干员 '阿米娅' 的精英2面板关键帧缺失，数据可能损坏。"

        overview = build_operator_stats("阿米娅")
        assert isinstance(overview, dict)
        empty_frames = overview["phases"][2]["keyframes"]["lv1"]
        # Full key set present with None values (renderer must not KeyError).
        assert set(empty_frames) == {key for key, _ in PANEL_FIELDS}
        assert all(value is None for value in empty_frames.values())
        markdown = render_operator_stats(overview)
        assert "Lv1 None / Lv满 None" in markdown


def test_real_data_matches_published_panels() -> None:
    root = Path(__file__).parents[2] / "data" / "gamedata"
    if not (root / "zh_CN" / "gamedata" / "excel" / "character_table.json").exists():
        import pytest

        pytest.skip("No bundled operator data")

    clear_operator_caches()
    # Patch GAMEDATA_PATH like every sibling test: Config.load() otherwise
    # resolves a user-dir default in CI and the guard above would probe a
    # different path than the code under test reads.
    with patch.dict(os.environ, {"GAMEDATA_PATH": str(root)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)
        try:
            # Keyframe anchors: every level PRTS Wiki publishes must match
            # exactly.
            cases = {(0, 1): _WIKI_AMIYA[("e0", 1)], (0, 50): _WIKI_AMIYA[("e0", 50)],
                     (1, 70): _WIKI_AMIYA[("e1", 70)], (2, 80): _WIKI_AMIYA[("e2", 80)]}
            for (phase, level), (hp, atk, df, res) in cases.items():
                detail = build_operator_stats("阿米娅", phase=phase, level=level)
                assert isinstance(detail, dict), detail
                attrs = detail["attributes"]
                assert attrs["maxHp"] == hp and attrs["atk"] == atk, (phase, level)
                assert attrs["def"] == df and attrs["magicResistance"] == res

            # Max-trust bonus matches the wiki (+200 HP, +70 ATK).
            overview = build_operator_stats("阿米娅")
            assert isinstance(overview, dict)
            assert overview["favor_bonus"]["maxHp"] == _WIKI_AMIYA_TRUST[0]
            assert overview["favor_bonus"]["atk"] == _WIKI_AMIYA_TRUST[1]

            # Mid-level sanity: interpolated E2 Lv40 stays inside the frame
            # span and matches the hand-computed linear value.
            detail = build_operator_stats("阿米娅", phase=2, level=40)
            assert isinstance(detail, dict)
            assert detail["attributes"]["maxHp"] == 1337
        finally:
            clear_operator_caches()
