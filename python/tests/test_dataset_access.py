"""Tests for the dataset access contract (registry, onError modes, stores)."""
from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from prts_mcp.data.dataset_access import (
    DatasetSpec,
    LoaderSpec,
    dataset_cache_stats,
    dataset_registry,
    define_dataset,
    excel_store,
    levels_store,
)
from prts_mcp.data.gamedata_attrs import m_value
from prts_mcp.data.messages import (
    excel_missing_message,
    levels_missing_message,
    regex_error_message,
    validate_bounds,
)


def _define(name: str, **loader_kwargs) -> object:
    return define_dataset(DatasetSpec(name=name, loaders={"value": LoaderSpec(**loader_kwargs)}))


class TestRegistry:
    def test_re_registration_replaces_and_keeps_position(self):
        first = _define("test_registry_domain", load=lambda: 1)
        assert dataset_registry()["test_registry_domain"] is first
        position = list(dataset_registry()).index("test_registry_domain")
        second = _define("test_registry_domain", load=lambda: 2)
        assert dataset_registry()["test_registry_domain"] is second
        assert list(dataset_registry()).index("test_registry_domain") == position

    def test_cache_stats_reflects_replacement(self):
        _define("test_stats_domain", load=lambda: {"a": 1})
        _define("test_stats_domain", load=lambda: {"a": 1, "b": 2})
        stats = dataset_cache_stats()["test_stats_domain"]
        assert stats["value"]["count"] == 0  # not loaded yet
        # Force a load via the registry entry, then re-read.
        dataset_registry()["test_stats_domain"].cached("value")()
        stats = dataset_cache_stats()["test_stats_domain"]
        assert stats["value"] == {"loaded": True, "count": 2}


class TestOnErrorModes:
    def test_throw_retries_after_failure(self, tmp_path: Path):
        state = {"path": tmp_path / "data.json"}

        def load():
            return state["path"].read_text(encoding="utf-8")

        access = _define("test_throw_domain", load=load)
        cached = access.cached("value")
        with pytest.raises(FileNotFoundError):
            cached()
        # Data appears mid-process → next call succeeds (frozen behavior).
        state["path"].write_text("hello", encoding="utf-8")
        assert cached() == "hello"

    def test_cache_failure_is_sticky_with_same_exception(self):
        calls = {"n": 0}

        def load():
            calls["n"] += 1
            raise RuntimeError("boom")

        access = _define("test_sticky_domain", load=load, on_error="cacheFailure")
        cached = access.cached("value")
        with pytest.raises(RuntimeError, match="boom"):
            cached()
        with pytest.raises(RuntimeError, match="boom") as excinfo:
            cached()
        assert calls["n"] == 1  # load never retried
        assert "boom" in str(excinfo.value)
        access.clear()
        with pytest.raises(RuntimeError, match="boom"):
            cached()
        assert calls["n"] == 2  # clear() resets the sticky failure

    def test_null_and_empty_modes_cache_fallback_values(self):
        def load():
            raise FileNotFoundError("missing")

        null_access = _define("test_null_domain", load=load, on_error="null")
        assert null_access.cached("value")() is None
        empty_access = _define("test_empty_domain", load=load, on_error="empty")
        assert empty_access.cached("value")() == {}


def _make_excel_fixture(tmp_path: Path) -> Path:
    excel = tmp_path / "zh_CN" / "gamedata" / "excel"
    excel.mkdir(parents=True)
    for name in (
        "character_table.json",
        "handbook_info_table.json",
        "charword_table.json",
        "story_review_table.json",
    ):
        (excel / name).write_text("{}", encoding="utf-8")
    return excel


def _make_levels_fixture(tmp_path: Path) -> Path:
    levels = tmp_path / "zh_CN" / "gamedata" / "levels"
    enemydata = levels / "enemydata"
    enemydata.mkdir(parents=True)
    (enemydata / "enemy_database.json").write_text("{}", encoding="utf-8")
    return levels


class TestStores:
    def test_excel_store_reads_env_gamedata_path(self, tmp_path: Path):
        excel = _make_excel_fixture(tmp_path)
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=True):
            store = excel_store()
        assert store.root == excel

    def test_excel_store_raises_when_unset(self, tmp_path: Path):
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=True):
            with pytest.raises(RuntimeError, match="effective_excel_path is None"):
                excel_store()

    def test_levels_store_roots_at_levels(self, tmp_path: Path):
        levels = _make_levels_fixture(tmp_path)
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=True):
            store = levels_store()
        assert store.root == levels


class TestSpecHooks:
    def test_clear_runs_on_clear_hook(self):
        cleared = {"n": 0}
        access = define_dataset(DatasetSpec(
            name="test_hook_domain",
            loaders={"value": LoaderSpec(load=lambda: 1)},
            available=lambda: False,
            missing_message=lambda: "缺数据",
            on_clear=lambda: cleared.__setitem__("n", cleared["n"] + 1),
        ))
        assert access.available() is False
        assert access.missing_message() == "缺数据"
        access.clear()
        assert cleared["n"] == 1


class TestGameDataAttrs:
    def test_m_value_unwraps_and_falls_back(self):
        assert m_value({"m_defined": True, "m_value": 42}) == 42
        assert m_value({"m_defined": False, "m_value": 42}) == 42  # value wins, matches legacy
        assert m_value(7) == 7
        assert m_value(None, default="d") == "d"
        assert m_value(None) is None


class TestMessages:
    def test_excel_missing_message_canonical_family(self, tmp_path: Path):
        excel = _make_excel_fixture(tmp_path)
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=True):
            message = excel_missing_message("物品")()
        assert message.startswith("物品数据暂不可用。")
        assert "GITHUB_TOKEN" in message
        assert "auto-sync" in message
        assert str(excel) in message

    def test_levels_missing_message_canonical_family(self, tmp_path: Path):
        _make_levels_fixture(tmp_path)
        with patch.dict(os.environ, {"GAMEDATA_PATH": str(tmp_path)}, clear=True):
            message = levels_missing_message("关卡战斗")()
        assert message.startswith("关卡战斗数据暂不可用。")
        assert "zh_CN-levels.zip" in message
        # levels_path resolves to the gamedata root when levels data is complete.
        assert str(tmp_path) in message

    def test_validate_bounds_reproduces_canonical_strings(self):
        assert validate_bounds("limit", 0, minimum=1) == "limit 必须 >= 1。"
        assert validate_bounds("limit", 201, maximum=200) == "limit 必须 <= 200。"
        assert validate_bounds("offset", -1, minimum=0) == "offset 必须 >= 0。"
        assert validate_bounds("limit", 50, minimum=1, maximum=200) is None

    def test_regex_error_message(self):
        assert regex_error_message(ValueError("bad")) == "正则表达式无效：bad"
