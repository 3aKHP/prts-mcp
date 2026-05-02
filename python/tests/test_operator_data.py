"""Tests for operator data loading against changing local game data."""
from __future__ import annotations

import os
from unittest.mock import patch

from prts_mcp.data import operator
from prts_mcp.data.operator import (
    clear_operator_caches,
    get_operator_archives,
    get_operator_basic_info,
    get_operator_voicelines,
)

from tests.fixtures import write_minimal_gamedata


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

    def test_table_caches_can_be_cleared_explicitly(self, tmp_path):
        write_minimal_gamedata(tmp_path)
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
            assert "Amiya" in get_operator_basic_info("阿米娅")

            clear_operator_caches()

            assert operator._load_character_table.cache_info().currsize == 0
