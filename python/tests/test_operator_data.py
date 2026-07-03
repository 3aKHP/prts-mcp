"""Tests for operator data loading against changing local game data."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

from prts_mcp.data import operator
from prts_mcp.data.operator import (
    build_operator_basic_info,
    clear_operator_caches,
    get_operator_archives,
    get_operator_basic_info,
    get_operator_voicelines,
)

from tests.fixtures import write_minimal_gamedata


def _load_parity_fixture(name: str) -> dict:
    path = Path(__file__).parents[2] / "tests" / "parity-fixtures" / name
    return json.loads(path.read_text(encoding="utf-8"))


def setup_function() -> None:
    clear_operator_caches()


def teardown_function() -> None:
    clear_operator_caches()


class TestOperatorDataRefresh:
    def test_same_process_sees_data_written_after_initial_miss(self, tmp_path):
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
            os.environ.pop("STORYJSON_PATH", None)

            missing = get_operator_basic_info("阿米娅")
            assert "干员数据暂不可用" in missing

            write_minimal_gamedata(tmp_path)

            basic = get_operator_basic_info("阿米娅")
            assert "# 阿米娅 - 干员基本信息" in basic
            assert "Amiya" in basic
            assert "术师" in basic

    def test_core_operator_tools_read_same_fixture(self, tmp_path):
        write_minimal_gamedata(tmp_path)
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
            os.environ.pop("STORYJSON_PATH", None)

            assert get_operator_archives("阿米娅") == (
                "# 阿米娅 - 干员档案\n\n"
                "### 档案资料一\n"
                "阿米娅的档案文本。"
            )
            assert get_operator_voicelines("阿米娅") == (
                "# 阿米娅 - 语音记录\n\n"
                "**任命助理**: 博士，今天也请多指教。"
            )
            assert get_operator_basic_info("阿米娅") == (
                "# 阿米娅 - 干员基本信息\n\n"
                "- **编号**：R001\n"
                "- **英文名**：Amiya\n"
                "- **稀有度**：5★\n"
                "- **职业**：术师（corecaster）\n"
                "- **站位**：远程\n"
                "- **所属**：rhodes\n"
                "- **招募标签**：输出、支援\n"
                "- **攻击属性**：法术伤害\n"
                "\n"
                "**图鉴**：罗德岛的公开领袖。\n"
                "\n"
                "> 阿米娅的信物。\n"
                "\n"
                "**获取方式**：主线获得\n"
                "\n"
                "## 天赋\n"
                "- **情绪吸收**：攻击回复技力"
            )
            assert build_operator_basic_info("阿米娅") == _load_parity_fixture(
                "operator_basic_info.json"
            )

    def test_table_caches_can_be_cleared_explicitly(self, tmp_path):
        write_minimal_gamedata(tmp_path)
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
            assert "Amiya" in get_operator_basic_info("阿米娅")

            clear_operator_caches()

            assert operator._load_character_table.cache_info().currsize == 0


class TestNameToId:
    def test_trap_entry_with_same_name_does_not_override_operator(self, tmp_path):
        """Regression: trap_* and token_* entries must not shadow char_* entries."""
        import json
        excel = tmp_path / "zh_CN" / "gamedata" / "excel"
        excel.mkdir(parents=True)
        (excel / "character_table.json").write_text(
            json.dumps(
                {
                    "char_002_amiya": {"name": "阿米娅", "rarity": "TIER_5", "profession": "CASTER"},
                    "trap_999_amiya_fake": {"name": "阿米娅", "rarity": "TIER_1", "profession": "TRAP"},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (excel / "handbook_info_table.json").write_text(
            json.dumps({"handbookDict": {"char_002_amiya": {"storyTextAudio": []}}}, ensure_ascii=False),
            encoding="utf-8",
        )
        (excel / "charword_table.json").write_text(
            json.dumps({"charWords": {}}, ensure_ascii=False),
            encoding="utf-8",
        )
        (excel / "story_review_table.json").write_text("{}", encoding="utf-8")

        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
            os.environ.pop("STORYJSON_PATH", None)
            clear_operator_caches()

            info = get_operator_basic_info("阿米娅")
            assert "5★" in info, f"Expected 5★ from char_*, got: {info}"
            assert "TRAP" not in info, f"TRAP entry leaked into result: {info}"
