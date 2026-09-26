"""Tests for story character tracking — find_character_appearances and find_speakers_in.

Mirrors the synthetic-fixture pattern of test_search.py: a tiny ``act_test``
event with two chapters is written to a directory or zip store, and the
store-based variants are exercised directly. No real zh_CN.zip is required.

Fixture dialogue (the source of truth for the assertions below):
  ch1 (TEST-1 开端):
    - 阿米娅：你好，博士。        ← 阿米娅 speaks; "博士" in text
    - *罗德岛走廊*               ← narration, no names
    - 博士：我们出发吧。          ← 博士 speaks; no names in text
  ch2 (TEST-2 终章):
    - 博士：任务完成。阿米娅干得不错。  ← 博士 speaks; "阿米娅" in text
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from prts_mcp.data.stores import DirectoryStore, ZipStore
from prts_mcp.data.story_character import (
    find_character_appearances_from_store,
    find_speakers_in_from_store,
)
from prts_mcp.tools_story import register_story_tools


# ---------------------------------------------------------------------------
# Story test data (same shape as test_search.py)
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
                {"prop": "name", "attributes": {"name": "博士", "content": "任务完成。阿米娅干得不错。"}},
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
# find_character_appearances
# ---------------------------------------------------------------------------


class TestFindCharacterAppearances:
    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_doctor_speaks_both_mentioned_in_one(self, tmp_path: Path, store_kind: str) -> None:
        # 博士: speaks in both chapters; mentioned only in ch1 (阿米娅's line contains 博士).
        store = _story_store(store_kind, tmp_path)
        result = find_character_appearances_from_store(store, "博士")

        assert result.name == "博士"
        assert result.total_chapters == 2
        ch1, ch2 = result.appearances
        assert ch1.story_key == FIRST_STORY_KEY
        assert ch1.speaks is True
        assert ch1.mentioned is True   # "博士" appears in 阿米娅's ch1 text
        assert ch2.story_key == SECOND_STORY_KEY
        assert ch2.speaks is True
        assert ch2.mentioned is False  # 博士 not in ch2 text ("任务完成。阿米娅干得不错。")

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_amiya_speaks_one_mentioned_other(self, tmp_path: Path, store_kind: str) -> None:
        # 阿米娅: speaks in ch1; mentioned only in ch2 (博士's line contains 阿米娅).
        store = _story_store(store_kind, tmp_path)
        result = find_character_appearances_from_store(store, "阿米娅")

        assert result.total_chapters == 2
        ch1, ch2 = result.appearances
        assert ch1.speaks is True
        assert ch1.mentioned is False  # 阿米娅 not in ch1 text
        assert ch2.speaks is False
        assert ch2.mentioned is True   # "阿米娅" in ch2 text

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_scope_filter(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = find_character_appearances_from_store(store, "博士", scope="act_test")
        assert result.total_chapters == 2

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_scope_unknown_event_raises(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        with pytest.raises(KeyError):
            find_character_appearances_from_store(store, "博士", scope="no_such_event")

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_no_match_returns_empty(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        result = find_character_appearances_from_store(store, "不存在的角色")
        assert result.total_chapters == 0
        assert result.appearances == []

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_substring_false_positive(self, tmp_path: Path, store_kind: str) -> None:
        # Documented behavior: mentioned uses substring match on line text only
        # (role matching is exact). "阿" is not in any ch1 text, but is a
        # substring of "阿米娅" in ch2's text → only ch2 is mentioned.
        store = _story_store(store_kind, tmp_path)
        result = find_character_appearances_from_store(store, "阿")
        assert result.total_chapters == 1
        assert result.appearances[0].story_key == SECOND_STORY_KEY
        assert result.appearances[0].speaks is False
        assert result.appearances[0].mentioned is True

    def test_empty_name_raises(self, tmp_path: Path) -> None:
        store = _story_store("directory", tmp_path)
        with pytest.raises(ValueError):
            find_character_appearances_from_store(store, "")

    def test_max_events_bounds(self, tmp_path: Path) -> None:
        store = _story_store("directory", tmp_path)
        with pytest.raises(ValueError):
            find_character_appearances_from_store(store, "博士", max_events=0)
        with pytest.raises(ValueError):
            find_character_appearances_from_store(store, "博士", max_events=201)

    def test_max_events_cap(self, tmp_path: Path) -> None:
        store = _story_store("directory", tmp_path)
        result = find_character_appearances_from_store(store, "博士", max_events=1)
        assert result.total_chapters == 1


# ---------------------------------------------------------------------------
# find_speakers_in
# ---------------------------------------------------------------------------


class TestFindSpeakersIn:
    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_speakers_with_counts(self, tmp_path: Path, store_kind: str) -> None:
        # 阿米娅 speaks once (ch1), 博士 speaks twice (ch1 + ch2).
        store = _story_store(store_kind, tmp_path)
        speakers = find_speakers_in_from_store(store, "act_test")

        by_name = {s.name: s.line_count for s in speakers}
        assert by_name == {"博士": 2, "阿米娅": 1}

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_sorted_by_count_desc(self, tmp_path: Path, store_kind: str) -> None:
        store = _story_store(store_kind, tmp_path)
        speakers = find_speakers_in_from_store(store, "act_test")
        counts = [s.line_count for s in speakers]
        assert counts == sorted(counts, reverse=True)
        # 博士 (2) ranks above 阿米娅 (1).
        assert speakers[0].name == "博士"

    def test_unknown_event_raises(self, tmp_path: Path) -> None:
        store = _story_store("directory", tmp_path)
        with pytest.raises(KeyError):
            find_speakers_in_from_store(store, "no_such_event")


# ---------------------------------------------------------------------------
# Edge case: event exists but has no dialog (narration only)
# ---------------------------------------------------------------------------


NARRATION_ONLY_KEY = "activities/act_narration/level_narration_01"


def _narration_only_files() -> dict[str, object]:
    return {
        STORY_REVIEW_PATH: {
            "act_narration": {
                "name": "纯旁白活动",
                "entryType": "ACTIVITY",
                "infoUnlockDatas": [
                    {
                        "storyTxt": NARRATION_ONLY_KEY,
                        "storyCode": "NAR-1",
                        "storyName": "旁白章",
                        "avgTag": None,
                        "storySort": 1,
                    },
                ],
            },
        },
        _story_path(NARRATION_ONLY_KEY): {
            "storyCode": "NAR-1",
            "storyName": "旁白章",
            "avgTag": None,
            "eventName": "纯旁白活动",
            "storyInfo": "",
            "storyList": [
                {"prop": "sticker", "attributes": {"content": "只有旁白文本。"}},
            ],
        },
    }


def _narration_only_store(kind: str, tmp_path: Path) -> DirectoryStore | ZipStore:
    files = _narration_only_files()
    if kind == "directory":
        for path, data in files.items():
            target = tmp_path / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return DirectoryStore(tmp_path)
    else:
        zip_path = tmp_path / "zh_CN.zip"
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "w") as zf:
            for inner_path, data in files.items():
                zf.writestr(inner_path, json.dumps(data, ensure_ascii=False))
        return ZipStore(zip_path)


class TestNarrationOnlyEvent:
    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_speakers_empty(self, tmp_path: Path, store_kind: str) -> None:
        # Event exists in the index but has zero dialog lines → empty speakers.
        store = _narration_only_store(store_kind, tmp_path)
        speakers = find_speakers_in_from_store(store, "act_narration")
        assert speakers == []

    @pytest.mark.parametrize("store_kind", ["directory", "zip"])
    def test_character_no_match(self, tmp_path: Path, store_kind: str) -> None:
        # The narration text mentions no real speaker name; any lookup is empty.
        store = _narration_only_store(store_kind, tmp_path)
        result = find_character_appearances_from_store(store, "博士")
        assert result.total_chapters == 0


# ---------------------------------------------------------------------------
# Tool layer: KeyError messages surface bare (1.7.2 backport of main d1d7852)
#
# str(KeyError) repr-wraps the message in quotes, so the three story tools
# that catch KeyError used to return doubled-quoted garbage. The tool layer
# now unwraps e.args[0]; these tests pin the clean text for each tool.
# ---------------------------------------------------------------------------

CHARDICT_PATH = "zh_CN/chardict.json"


@pytest.fixture()
def tool_story_zip(tmp_path: Path) -> Path:
    files = _story_files()
    files[CHARDICT_PATH] = {
        "amiya": {"name": "阿米娅", "id": "char_002_amiya"},
        "nomemoir": {"name": "无密录干员", "id": "char_999_nomemoir"},
    }
    zip_path = tmp_path / "zh_CN.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        for inner_path, data in files.items():
            zf.writestr(inner_path, json.dumps(data, ensure_ascii=False))
    return zip_path


class _RecordingMCP:
    """Capture registered tool functions without a live MCP transport.

    test_server_startup_sync.py installs mcp/pydantic import stubs into
    sys.modules before this module is collected, so the real FastMCP class
    is not reliably importable here; a recorder follows the same FakeFastMCP
    pattern while still exercising the tool bodies end to end.
    """

    def __init__(self) -> None:
        self.tools: dict[str, object] = {}

    def tool(self):  # type: ignore[no-untyped-def]
        def decorator(func):  # type: ignore[no-untyped-def]
            self.tools[func.__name__] = func
            return func
        return decorator


def _story_tools() -> dict[str, object]:
    recorder = _RecordingMCP()
    register_story_tools(recorder)
    return recorder.tools


class TestStoryToolKeyErrorMessages:
    def test_get_operator_memoirs_unknown_operator_is_bare(
        self, monkeypatch: pytest.MonkeyPatch, tool_story_zip: Path,
    ) -> None:
        monkeypatch.setenv("STORYJSON_PATH", str(tool_story_zip))
        text = _story_tools()["get_operator_memoirs"](operator_name="不存在的干员")
        # No repr wrapper: str(KeyError) would add outer double quotes.
        assert text == "未找到干员名称 '不存在的干员' 对应的内部代码。请使用游戏内中文名称。"
        assert not text.startswith('"') and not text.endswith('"')

    def test_get_operator_memoirs_no_memoir_data_is_bare(
        self, monkeypatch: pytest.MonkeyPatch, tool_story_zip: Path,
    ) -> None:
        monkeypatch.setenv("STORYJSON_PATH", str(tool_story_zip))
        # 无密录干员 exists in chardict but has no memoir chapters.
        text = _story_tools()["get_operator_memoirs"](operator_name="无密录干员")
        assert text == "干员 '无密录干员' (code=nomemoir) 暂无密录数据。"
        assert not text.startswith('"') and not text.endswith('"')

    def test_get_operator_memoirs_missing_chardict_gets_prefix(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    ) -> None:
        # Zip without chardict.json: the KeyError message is not in the
        # bare-message allowlist, so the tool prefixes it.
        zip_path = tmp_path / "zh_CN.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            for inner_path, data in _story_files().items():
                zf.writestr(inner_path, json.dumps(data, ensure_ascii=False))
        monkeypatch.setenv("STORYJSON_PATH", str(zip_path))
        text = _story_tools()["get_operator_memoirs"](operator_name="阿米娅")
        assert text == "查询干员密录失败：chardict.json 未在 story zip 中找到。"

    def test_find_character_appearances_unknown_scope_is_bare(
        self, monkeypatch: pytest.MonkeyPatch, tool_story_zip: Path,
    ) -> None:
        monkeypatch.setenv("STORYJSON_PATH", str(tool_story_zip))
        text = _story_tools()["find_character_appearances"](
            name="博士", scope="no_such_event",
        )
        assert text == "未找到匹配的活动：'no_such_event'。"
        assert not text.startswith('"') and not text.endswith('"')

    def test_find_speakers_in_unknown_event_is_bare(
        self, monkeypatch: pytest.MonkeyPatch, tool_story_zip: Path,
    ) -> None:
        monkeypatch.setenv("STORYJSON_PATH", str(tool_story_zip))
        text = _story_tools()["find_speakers_in"](event_id="no_such_event")
        assert text == "未找到匹配的活动：'no_such_event'。"
        assert not text.startswith('"') and not text.endswith('"')
