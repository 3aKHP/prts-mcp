"""Tests for enemy_stats / enemy_render / level_parser pure modules (P3.A)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from prts_mcp.data.enemy_render import (
    render_handbook_card,
    render_stats_block,
)
from prts_mcp.data.enemy_stats import (
    extract_enemy_stats,
    format_stats,
    merge_defined,
    overwritten_enemy_name,
    stage_specific_enemy_data,
)
from prts_mcp.data.level_parser import (
    enemy_refs,
    level_path,
    parse_level,
    spawn_counts,
)

_FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "parity-fixtures"


_DB_ENTRY = {
    "attributes": {
        "maxHp": {"m_defined": True, "m_value": 1200},
        "atk": {"m_defined": True, "m_value": 250},
        "def": {"m_defined": True, "m_value": 80},
        "magicResistance": {"m_defined": True, "m_value": 10.0},
        "moveSpeed": {"m_defined": True, "m_value": 0.8},
        "baseAttackTime": {"m_defined": True, "m_value": 2.4},
        "attackSpeed": {"m_defined": True, "m_value": 100.0},  # default → suppressed
        "stunImmune": {"m_defined": True, "m_value": True},
        "silenceImmune": {"m_defined": True, "m_value": False},
    },
    "skills": [{
        "prefabKey": "sk1",
        "cooldown": 8,
        "initCooldown": 4,
        "spData": {"spCost": {"m_defined": True, "m_value": 20}},
        "blackboard": [{"key": "atk", "value": 30}],
    }],
}


class TestExtractEnemyStats:
    def test_exact_structured_dict(self):
        stats = extract_enemy_stats(_DB_ENTRY)
        assert stats == {
            "max_hp": "1,200",
            "atk": "250",
            "def": "80",
            "resistance": "10.0",
            "move_speed": "0.8",
            "attack_interval": "2.4s",
            "attack_speed": None,  # == 100.0 default suppressed
            "mass_level": None,
            "hp_recovery_per_sec": None,
            "immunities": ["眩晕"],
            "life_point_reduce": None,
            "skills": [{
                "prefab": "sk1",
                "timing": "冷却 8s，初始 4s，SP 20",
                "blackboard": "atk=30",
            }],
        }

    def test_payload_keys_match_parity_fixture_shape(self):
        payload = json.loads((_FIXTURES / "enemy_info_with_stats.json").read_text(encoding="utf-8"))
        assert set(extract_enemy_stats({}).keys()) == set(payload["stats"].keys())

    def test_empty_entry_yields_all_null_scalars(self):
        stats = extract_enemy_stats({})
        assert stats["max_hp"] is None
        assert stats["immunities"] == []
        assert stats["skills"] == []


class TestMergeDefined:
    def test_override_pair_applies_only_when_defined(self):
        assert merge_defined(1, {"m_defined": True, "m_value": 2}) == 2
        assert merge_defined(1, {"m_defined": False, "m_value": 2}) == 1

    def test_nested_merge_skips_undefined_children(self):
        base = {"atk": 5, "hp": 100}
        override = {"atk": {"m_defined": False, "m_value": 9}, "hp": {"m_defined": True, "m_value": 200}}
        assert merge_defined(base, override) == {"atk": 5, "hp": 200}

    def test_scalar_override_is_ignored(self):
        # Non-dict overrides return the base (merge_defined is dict-shaped only).
        assert merge_defined({"hp": 100}, {"hp": 200, "atk": {"m_defined": True, "m_value": 1}})["hp"] == 100

    def test_non_dict_override_returns_base(self):
        assert merge_defined({"a": 1}, None) == {"a": 1}


class TestStageSpecificEnemyData:
    LEVELS = {
        "e1": {0: {"attributes": {"atk": 1}}, 2: {"attributes": {"atk": 3}}},
        "e2": {5: {"attributes": {"atk": 7}}},
    }

    def test_exact_level_then_level0(self):
        assert stage_specific_enemy_data(self.LEVELS, "e1", 2) == {"attributes": {"atk": 3}}
        assert stage_specific_enemy_data(self.LEVELS, "e1", 1) == {"attributes": {"atk": 1}}

    def test_missing_enemy_falls_back_to_overwritten(self):
        ov = {"attributes": {"atk": 9}}
        assert stage_specific_enemy_data(self.LEVELS, "missing", 0, ov) == ov
        assert stage_specific_enemy_data(self.LEVELS, "missing", 0) is None
        assert stage_specific_enemy_data(None, "e1", 0) is None


class TestOverwrittenEnemyName:
    def test_name_then_prefab_then_none(self):
        assert overwritten_enemy_name({"name": "X"}) == "X"
        assert overwritten_enemy_name({"prefabKey": "Y"}) == "Y"
        assert overwritten_enemy_name({"name": {"m_defined": True, "m_value": "Z"}}) == "Z"
        assert overwritten_enemy_name(None) is None


class TestFormatStats:
    def test_compact_summary(self):
        data = {"attributes": {
            "maxHp": 1200, "atk": 250, "def": 80, "magicResistance": 10.0,
            "moveSpeed": 0.8, "baseAttackTime": 2.4,
        }}
        assert format_stats(data) == "HP 1,200；ATK 250；DEF 80；RES 10.0；移速 0.8；攻击间隔 2.4s"

    def test_none_yields_no_record(self):
        assert format_stats(None) == "无数据库记录"


class TestRenderCard:
    ENTRY = {
        "name": "Test", "enemy_id": "e1", "enemy_index": "D1", "level_label": "精英",
        "description": "d", "attack_type": "近战", "ability": "a",
        "damage_types_label": "物理", "enemy_tags": ["t1", "t2"],
    }

    def test_include_enemy_id_flag(self):
        with_id = render_handbook_card(self.ENTRY, include_enemy_id=True)
        without_id = render_handbook_card(self.ENTRY)
        assert "- **ID**：e1" in with_id
        assert "- **ID**：" not in "\n".join(without_id)
        # The ID line sits right after the heading; the rest is identical.
        assert with_id[2:] == without_id[1:]


class TestStatsBlock:
    def test_renders_fields_and_skills(self):
        stats = extract_enemy_stats(_DB_ENTRY)
        lines = render_stats_block(stats)
        assert lines[0] == "## 战斗属性"
        assert any(line.startswith("- **最大生命**：") for line in lines)


class TestLevelParser:
    def test_level_path(self):
        assert level_path("Level_ABC\\X") == "level_abc/x.json"

    def test_parse_level(self):
        assert parse_level("3") == 3
        assert parse_level(2.7) == 2
        assert parse_level(None) == 0
        assert parse_level("abc") == 0

    def test_spawn_counts(self):
        level = {"waves": [{"fragments": [{"actions": [
            {"actionType": "SPAWN", "key": "a", "count": 2},
            {"actionType": 0, "key": "a"},
            {"actionType": "SPAWN", "key": "b", "count": "bad"},
            {"actionType": "OTHER", "key": "c", "count": 9},
            {"actionType": "SPAWN", "count": 5},  # no key → skipped
        ]}]}]}
        counts = spawn_counts(level)
        assert counts["a"] == 3
        assert counts["b"] == 1
        assert "c" not in counts

    def test_enemy_refs(self):
        refs = enemy_refs({"enemyDbRefs": [{"id": "e1", "level": 2}, {"level": 3}]})
        assert set(refs) == {"e1"}
        assert refs["e1"]["level"] == 2
