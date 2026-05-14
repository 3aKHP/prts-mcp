"""Tests for search tools — operator search and story search."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from prts_mcp.data.search import search_operator_data
from prts_mcp.data.stores import DirectoryStore, ZipStore
from prts_mcp.data.story import search_stories_from_store


# ---------------------------------------------------------------------------
# Story test data (mirrors test_story_reader_store.py pattern)
# ---------------------------------------------------------------------------

STORY_REVIEW_PATH = "zh_CN/gamedata/excel/story_review_table.json"
FIRST_STORY_KEY = "activities/act_test/level_act_test_01_beg"
SECOND_STORY_KEY = "activities/act_test/level_act_test_02_end"


def _story_path(story_key: str) -> str:
    return f"zh_CN/gamedata/story/{story_key}.json"


def _story_files() -> dict[str, object]:
    return {
        STORY_REVIEW_PATH: {
            "act_test": {
                "name": "测试活动",
                "entryType": "ACTIVITY",
                "infoUnlockDatas": [
                    {
                        "storyTxt": FIRST_STORY_KEY,
                        "storyCode": "TEST-1",
                        "storyName": "开端",
                        "avgTag": "BEG",
                        "storySort": 1,
                    },
                    {
                        "storyTxt": SECOND_STORY_KEY,
                        "storyCode": "TEST-2",
                        "storyName": "终章",
                        "avgTag": "END",
                        "storySort": 2,
                    },
                ],
            },
        },
        _story_path(FIRST_STORY_KEY): {
            "storyCode": "TEST-1",
            "storyName": "开端",
            "avgTag": "BEG",
            "eventName": "测试活动",
            "storyInfo": "测试简介",
            "storyList": [
                {"prop": "name", "attributes": {"name": "阿米娅", "content": "你好，博士。"}},
                {"prop": "sticker", "attributes": {"content": "罗德岛走廊"}},
                {"prop": "name", "attributes": {"name": "博士", "content": "我们出发吧。"}},
            ],
        },
        _story_path(SECOND_STORY_KEY): {
            "storyCode": "TEST-2",
            "storyName": "终章",
            "avgTag": "END",
            "eventName": "测试活动",
            "storyInfo": "",
            "storyList": [
                {"prop": "name", "attributes": {"name": "博士", "content": "任务完成。"}},
            ],
        },
    }


def _write_story_dir(root: Path) -> None:
    for path, data in _story_files().items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _write_story_zip(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for inner_path, data in _story_files().items():
            zf.writestr(inner_path, json.dumps(data, ensure_ascii=False))


def _story_store(kind: str, tmp_path: Path) -> DirectoryStore | ZipStore:
    if kind == "directory":
        _write_story_dir(tmp_path)
        return DirectoryStore(tmp_path)
    else:
        zip_path = tmp_path / "zh_CN.zip"
        _write_story_zip(zip_path)
        return ZipStore(zip_path)


# ---------------------------------------------------------------------------
# Operator search tests
# ---------------------------------------------------------------------------


class TestSearchOperatorData:
    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        from tests.fixtures import write_minimal_gamedata
        from prts_mcp.data.operator import clear_operator_caches

        clear_operator_caches()
        write_minimal_gamedata(tmp_path)
        monkeypatch.setenv("GAMEDATA_PATH", str(tmp_path))
        yield
        monkeypatch.delenv("GAMEDATA_PATH", raising=False)
        clear_operator_caches()

    def test_search_by_name(self) -> None:
        result = search_operator_data("阿米娅")
        assert "[operators/basic/阿米娅]" in result
        assert "匹配：干员名称" in result

    def test_search_by_description(self) -> None:
        result = search_operator_data("法术伤害")
        assert "[operators/basic/阿米娅]" in result
        assert "匹配：攻击属性" in result

    def test_search_by_archive(self) -> None:
        result = search_operator_data("档案文本")
        assert "[operators/archives/阿米娅]" in result
        assert "匹配：档案资料一" in result

    def test_search_by_voiceline(self) -> None:
        result = search_operator_data("博士")
        assert "[operators/voicelines/阿米娅]" in result
        assert "匹配：任命助理" in result

    def test_no_match(self) -> None:
        result = search_operator_data("ZZZZZZZ")
        assert "未找到匹配" in result

    def test_invalid_regex(self) -> None:
        result = search_operator_data("[")
        assert "正则表达式无效" in result

    def test_missing_data(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from prts_mcp.data.operator import clear_operator_caches
        monkeypatch.setenv("GAMEDATA_PATH", "/nonexistent/path")
        clear_operator_caches()
        result = search_operator_data("阿米娅")
        assert "暂不可用" in result

    def test_max_results(self) -> None:
        result = search_operator_data(".", max_results=2)
        assert "共 2 条" in result


# ---------------------------------------------------------------------------
# Story search tests
# ---------------------------------------------------------------------------


class TestSearchStories:
    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_search_text(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = search_stories_from_store(store, "你好")
        assert ">>> 阿米娅：你好，博士。" in result
        assert "[stories/act_test/TEST-1 L1]" in result

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_search_narration(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = search_stories_from_store(store, "罗德岛")
        assert ">>> *罗德岛走廊*" in result

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_filter_character(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = search_stories_from_store(store, ".", character="博士")
        assert "共 2 条" in result
        # Every >>> line should mention 博士
        for line in result.split("\n"):
            if line.startswith(">>> "):
                assert "博士" in line
                assert "阿米娅" not in line

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_filter_line_type(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = search_stories_from_store(store, ".", line_type="narration")
        assert ">>> *罗德岛走廊*" in result
        # No dialog lines should be marked as match
        for line in result.split("\n"):
            if line.startswith(">>> "):
                assert line.startswith(">>> *")  # narration only

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_filter_event(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = search_stories_from_store(store, ".", event_id="nonexistent")
        assert "未找到匹配的活动" in result

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_context_zero(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = search_stories_from_store(store, "你好", context_lines=0)
        # Only matched line, no indented context lines in the block
        block = result.split("---\n\n", 1)[1]
        assert "    " not in block

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_no_match(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = search_stories_from_store(store, "ZZZZZZ")
        assert "未找到匹配" in result

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_invalid_regex(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = search_stories_from_store(store, "[")
        assert "正则表达式无效" in result

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_invalid_line_type(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = search_stories_from_store(store, ".", line_type="invalid")
        assert "无效的 line_type" in result
