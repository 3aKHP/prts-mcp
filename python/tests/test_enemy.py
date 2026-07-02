"""Tests for enemy data module — focus on format parity with TS implementation."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from prts_mcp.data.enemy import (
    build_enemy_search,
    build_enemy_info,
    build_enemies_listing,
    clear_enemy_caches,
    list_enemies,
    get_enemy_info,
    render_enemy_info,
    render_enemy_search,
    search_enemies,
)
from prts_mcp.output import render_result


def _write_handbook(excel: Path) -> None:
    (excel / "enemy_handbook_table.json").write_text(
        json.dumps({
            "enemyData": {
                "enemy_1505_frstar": {
                    "enemyId": "enemy_1505_frstar",
                    "enemyIndex": "FN",
                    "name": "霜星",
                    "enemyLevel": "BOSS",
                    "sortId": 100,
                    "description": "整合运动法术部队干部。",
                    "damageType": ["MAGIC"],
                    "hideInHandbook": False,
                },
                "enemy_1004_mslime": {
                    "enemyId": "enemy_1004_mslime",
                    "enemyIndex": "B1",
                    "name": "源石虫",
                    "enemyLevel": "NORMAL",
                    "sortId": 1,
                    "description": "野生的被感染生物。",
                    "damageType": ["PHYSIC", "MAGIC"],
                    "hideInHandbook": False,
                },
                "enemy_hidden": {
                    "enemyId": "enemy_hidden",
                    "name": "隐藏敌人",
                    "enemyLevel": "ELITE",
                    "sortId": 50,
                    "description": "应被过滤。",
                    "hideInHandbook": True,
                },
            }
        }, ensure_ascii=False),
        encoding="utf-8",
    )


def _write_database(db_root: Path) -> None:
    db_root.mkdir(parents=True, exist_ok=True)
    (db_root / "enemy_database.json").write_text(
        json.dumps({
            "enemies": [
                {
                    "Key": "enemy_1505_frstar",
                    "Value": [{
                        "level": 0,
                        "enemyData": {
                            "attributes": {
                                "maxHp": {"m_defined": True, "m_value": 25000},
                                "atk": {"m_defined": True, "m_value": 420},
                                "def": {"m_defined": True, "m_value": 250},
                                "magicResistance": {"m_defined": True, "m_value": 50.0},
                                "moveSpeed": {"m_defined": True, "m_value": 0.5},
                                "baseAttackTime": {"m_defined": True, "m_value": 3.7},
                                "stunImmune": {"m_defined": True, "m_value": True},
                                "frozenImmune": {"m_defined": True, "m_value": True},
                            },
                            "skills": [
                                {
                                    "prefabKey": "ArcticBlast",
                                    "cooldown": 8.5,
                                    "blackboard": [
                                        {"key": "duration", "value": 8.0},
                                        {"key": "atk_scale", "value": 1.5},
                                    ],
                                },
                            ],
                        },
                    }],
                },
            ],
        }, ensure_ascii=False),
        encoding="utf-8",
    )


@pytest.fixture
def gamedata(tmp_path: Path):
    excel = tmp_path / "zh_CN" / "gamedata" / "excel"
    excel.mkdir(parents=True)
    db_root = tmp_path / "zh_CN" / "gamedata" / "levels" / "enemydata"

    # Write minimum operator files so config validates
    for f in ("character_table.json", "handbook_info_table.json",
             "charword_table.json", "story_review_table.json"):
        (excel / f).write_text("{}", encoding="utf-8")

    _write_handbook(excel)
    _write_database(db_root)

    with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
        os.environ.pop("STORYJSON_PATH", None)
        clear_enemy_caches()
        yield tmp_path

    clear_enemy_caches()


@pytest.fixture
def split_levels_gamedata(tmp_path: Path):
    gamedata_root = tmp_path / "gamedata"
    excel = gamedata_root / "zh_CN" / "gamedata" / "excel"
    excel.mkdir(parents=True)

    for f in ("character_table.json", "handbook_info_table.json",
             "charword_table.json", "story_review_table.json"):
        (excel / f).write_text("{}", encoding="utf-8")

    _write_handbook(excel)
    _write_database(tmp_path / "gamedata-levels" / "zh_CN" / "gamedata" / "levels" / "enemydata")

    with patch.dict(os.environ, {"GAMEDATA_PATH": str(gamedata_root)}, clear=False):
        clear_enemy_caches()
        yield tmp_path

    clear_enemy_caches()


class TestListEnemies:
    def test_default_filters_hidden(self, gamedata):
        out = list_enemies(limit=10)
        assert "霜星" in out
        assert "源石虫" in out
        assert "隐藏敌人" not in out

    def test_golden_default_listing(self, gamedata):
        # Golden: exact full markdown for the default listing against the
        # fixture. Stronger than substring asserts — catches build-layer
        # field omissions, ordering, and label regressions. Not a tautology
        # (the expected string is hardcoded, not derived from build/render).
        assert list_enemies() == (
            "# 敌人图鉴（共 2 个）\n"
            "- **源石虫** [普通] (B1) — 野生的被感染生物。\n"
            "- **霜星** [领袖] (FN) — 整合运动法术部队干部。"
        )

    def test_golden_boss_filter(self, gamedata):
        assert list_enemies(threat_level="boss") == (
            "# 敌人图鉴（共 1 个）\n"
            "- **霜星** [领袖] (FN) — 整合运动法术部队干部。"
        )

    def test_offset_out_of_range_is_structured_not_error(self, gamedata):
        # Empty-result contract (P2b plan §3.4): offset past the end is a
        # legitimate-but-empty structured payload, not a content-only error.
        # Content stays byte-for-byte (the original header + out-of-range msg).
        data = build_enemies_listing(offset=999)
        assert isinstance(data, dict)
        assert data["enemies"] == []
        assert data["empty_reason"] == "offset_out_of_range"
        assert list_enemies(offset=999) == (
            f"# 敌人图鉴（共 {data['total']} 个）\n\n"
            f"offset=999 超出范围（总计 {data['total']} 条）。"
        )
        r = render_result(data, list_enemies(offset=999), channel="structured")
        assert r.structuredContent == data

    def test_both_channel_attaches_structured_content(self, gamedata):
        # Verify the tool wiring actually populates structuredContent in the
        # both channel (the build dict rides the structured axis).
        data = build_enemies_listing()
        assert isinstance(data, dict)
        r = render_result(data, list_enemies(), channel="both")
        assert r.structuredContent == data
        assert r.content[0].text == list_enemies()

    def test_threat_level_filter(self, gamedata):
        out = list_enemies(threat_level="boss", limit=10)
        assert "霜星" in out
        assert "源石虫" not in out

    def test_threat_level_invalid_returns_error(self, gamedata):
        out = list_enemies(threat_level="INVALID")
        assert "无效的 threat_level" in out

    def test_offset_beyond_total(self, gamedata):
        out = list_enemies(offset=999)
        assert "超出范围" in out

    def test_invalid_limit(self, gamedata):
        out = list_enemies(limit=0)
        assert "无效的 limit" in out

    def test_invalid_offset(self, gamedata):
        out = list_enemies(offset=-1)
        assert "无效的 offset" in out

    def test_full_returns_all_no_pagination_hint(self, gamedata):
        out = list_enemies(full=True)
        assert "霜星" in out
        assert "源石虫" in out
        assert "使用 offset" not in out

    def test_description_newline_stripped(self, gamedata, tmp_path):
        # Override one entry with a description containing newline.
        excel = tmp_path / "zh_CN" / "gamedata" / "excel"
        (excel / "enemy_handbook_table.json").write_text(
            json.dumps({"enemyData": {"e1": {
                "name": "测试", "enemyLevel": "NORMAL", "sortId": 1,
                "enemyIndex": "T1",
                "description": "第一行\n第二行",
            }}}, ensure_ascii=False),
            encoding="utf-8",
        )
        clear_enemy_caches()
        out = list_enemies(limit=5)
        # Description line must not contain a literal newline mid-bullet.
        for line in out.split("\n"):
            if line.startswith("- **测试**"):
                assert "\n" not in line
                break


class TestGetEnemyInfo:
    def test_merges_handbook_and_database(self, gamedata):
        out = get_enemy_info("霜星")
        # Handbook fields
        assert "**ID**：enemy_1505_frstar" in out
        assert "**威胁等级**：领袖" in out
        # Combat stats from database
        assert "**最大生命**：25,000" in out
        assert "**攻击力**：420" in out
        assert "**法术抗性**：50" in out
        # Immunities
        assert "**免疫**：眩晕、冻结" in out
        # Skills
        assert "ArcticBlast" in out
        assert "duration=8.0" in out

    def test_reads_database_from_sibling_levels_path(self, split_levels_gamedata):
        out = get_enemy_info("霜星")
        assert "**最大生命**：25,000" in out
        assert "**免疫**：眩晕、冻结" in out

    def test_handbook_only_when_no_db_entry(self, gamedata):
        # 源石虫 has no entry in our minimal database fixture
        out = get_enemy_info("源石虫")
        assert "源石虫" in out
        assert "**最大生命**" not in out

    def test_unknown_name(self, gamedata):
        assert "未找到敌人" in get_enemy_info("不存在的敌人")

    def test_damage_type_uses_ideographic_separator(self, gamedata):
        out = get_enemy_info("源石虫")
        # Two damage types — must use 、 not ", "
        assert "**伤害类型**：物理、法术" in out

    def test_golden_full_output(self, gamedata):
        # Golden: the exact full markdown for 霜星 against the test fixture.
        # Stronger than a round-trip — catches build-layer field omissions
        # (round-trip only proves render(build()) self-consistency). This is
        # the pattern the remaining P2b detail tools copy.
        assert get_enemy_info("霜星") == (
            "# 霜星 - 敌人图鉴\n\n"
            "- **ID**：enemy_1505_frstar\n"
            "- **编号**：FN\n"
            "- **威胁等级**：领袖\n"
            "- **描述**：整合运动法术部队干部。\n"
            "- **伤害类型**：法术\n"
            "## 战斗属性\n"
            "- **最大生命**：25,000\n"
            "- **攻击力**：420\n"
            "- **防御力**：250\n"
            "- **法术抗性**：50.0\n"
            "- **移动速度**：0.5\n"
            "- **攻击间隔**：3.7s\n"
            "- **免疫**：眩晕、冻结\n"
            "\n"
            "## 技能\n"
            "- **ArcticBlast**（冷却 8.5s）: duration=8.0，atk_scale=1.5"
        )

    def test_build_render_round_trip_is_exact(self, gamedata):
        # The build/render split must be byte-for-byte equivalent to the
        # public get_enemy_info — including the single-newline boundary
        # between the handbook block and the 战斗属性 section (a regression
        # here catches a spurious blank line from "\n".join + leading "\n").
        for name in ("霜星", "源石虫"):
            data = build_enemy_info(name)
            assert isinstance(data, dict), f"{name}: expected dict, got error"
            assert render_enemy_info(data) == get_enemy_info(name), f"{name}: round-trip mismatch"

    def test_handbook_to_stats_boundary_is_single_newline(self, gamedata):
        out = get_enemy_info("霜星")
        #霜星 has combat stats; the section heading must follow the last
        # handbook line with exactly one newline (no blank line).
        assert "## 战斗属性" in out
        idx = out.index("## 战斗属性")
        # The character immediately before the heading is a single newline.
        assert out[idx - 1] == "\n"
        assert out[idx - 2] != "\n", "spurious blank line before 战斗属性"


class TestSearchEnemies:
    def test_match_by_description(self, gamedata):
        out = search_enemies("整合运动")
        assert "霜星" in out

    def test_structured_golden(self, gamedata):
        data = build_enemy_search("整合运动")
        assert isinstance(data, dict)
        assert data["scope"] == "enemies"
        assert data["pattern"] == "整合运动"
        assert data["total"] == 1
        assert data["results"][0] == {
            "enemy_id": "enemy_1505_frstar",
            "name": "霜星",
            "enemy_index": "FN",
            "level_raw": "BOSS",
            "level_label": "领袖",
            "description": "整合运动法术部队干部。",
            "attack_type": "",
            "ability": "",
            "damage_types_raw": ["MAGIC"],
            "damage_types_label": "法术",
            "enemy_tags": [],
        }
        expected = (
            "# 搜索结果：整合运动（共 1 个）\n\n"
            "# 霜星 - 敌人图鉴\n\n"
            "- **编号**：FN\n"
            "- **威胁等级**：领袖\n"
            "- **描述**：整合运动法术部队干部。\n"
            "- **伤害类型**：法术"
        )
        assert render_enemy_search(data) == expected
        assert search_enemies("整合运动") == expected
        r = render_result(data, expected, channel="both")
        assert r.structuredContent == data

    def test_no_match(self, gamedata):
        out = search_enemies("绝对不存在的关键词")
        assert "未找到匹配" in out

    def test_invalid_regex(self, gamedata):
        out = search_enemies("[unclosed")
        assert "正则表达式无效" in out

    def test_filters_hidden(self, gamedata):
        out = search_enemies("隐藏")
        assert "应被过滤" not in out
