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

            assert "阿米娅的档案文本" in get_operator_archives("阿米娅")
            assert "博士，今天也请多指教" in get_operator_voicelines("阿米娅")
            assert "情绪吸收" in get_operator_basic_info("阿米娅")

    def test_table_caches_can_be_cleared_explicitly(self, tmp_path):
        write_minimal_gamedata(tmp_path)
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=False):
            assert "Amiya" in get_operator_basic_info("阿米娅")

            clear_operator_caches()

            assert operator._load_character_table.cache_info().currsize == 0
