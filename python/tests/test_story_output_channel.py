"""Golden tests for P2b story/wiki output-channel migration."""
from __future__ import annotations

import asyncio
import json
import zipfile
from pathlib import Path

import pytest
from mcp.server.fastmcp import FastMCP

from prts_mcp.data.story import (
    build_character_appearances,
    build_operator_memoirs,
    build_speakers_in_event,
    build_stories_listing,
    build_story_events_listing,
    render_character_appearances,
    render_operator_memoirs,
    render_speakers_in_event,
    render_stories_listing,
    render_story_events_listing,
)
from prts_mcp.output import render_result
from prts_mcp.tools_prts import (
    _build_prts_search,
    _render_prts_search,
    register_prts_tools,
)
from prts_mcp.tools_story import register_story_tools

STORY_REVIEW_PATH = "zh_CN/gamedata/excel/story_review_table.json"
CHARDICT_PATH = "zh_CN/chardict.json"
STORYINFO_PATH = "zh_CN/storyinfo.json"
EVENT_SUMMARIES_PATH = "zh_CN/event_summaries.json"

FIRST_STORY_KEY = "activities/act_test/level_act_test_01_beg"
SECOND_STORY_KEY = "activities/act_test/level_act_test_02_end"
NO_SUMMARY_STORY_KEY = "activities/act_no_summary/level_act_no_summary_01"
NARRATION_STORY_KEY = "activities/act_narration/level_act_narration_01"
MEMOIR_STORY_KEY = "memory/amiya/level_amiya_01"


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
            "act_no_summary": {
                "name": "无长摘要活动",
                "entryType": "ACTIVITY",
                "infoUnlockDatas": [
                    {
                        "storyTxt": NO_SUMMARY_STORY_KEY,
                        "storyCode": "NS-1",
                        "storyName": "短章",
                        "avgTag": None,
                        "storySort": 1,
                    }
                ],
            },
            "act_narration": {
                "name": "纯旁白活动",
                "entryType": "ACTIVITY",
                "infoUnlockDatas": [
                    {
                        "storyTxt": NARRATION_STORY_KEY,
                        "storyCode": "NAR-1",
                        "storyName": "旁白章",
                        "avgTag": None,
                        "storySort": 1,
                    }
                ],
            },
            "act_empty": {
                "name": "空活动",
                "entryType": "ACTIVITY",
                "infoUnlockDatas": [],
            },
            "story_amiya_set_1": {
                "name": "阿米娅密录",
                "entryType": "NONE",
                "infoUnlockDatas": [
                    {
                        "storyTxt": MEMOIR_STORY_KEY,
                        "storyCode": "AM-1",
                        "storyName": "出发",
                        "avgTag": None,
                        "storySort": 1,
                    }
                ],
            },
        },
        STORYINFO_PATH: {
            FIRST_STORY_KEY: "第一章梗概",
            SECOND_STORY_KEY: "第二章梗概",
            NO_SUMMARY_STORY_KEY: "无长摘要的一句话梗概",
        },
        EVENT_SUMMARIES_PATH: {
            "act_test": "活动总览",
        },
        CHARDICT_PATH: {
            "amiya": {"name": "阿米娅", "id": "char_002_amiya"},
        },
        _story_path(FIRST_STORY_KEY): {
            "storyCode": "TEST-1",
            "storyName": "开端",
            "avgTag": "BEG",
            "eventName": "测试活动",
            "storyInfo": "第一章梗概",
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
            "storyInfo": "第二章梗概",
            "storyList": [
                {"prop": "name", "attributes": {"name": "博士", "content": "任务完成。阿米娅干得不错。"}},
            ],
        },
        _story_path(NO_SUMMARY_STORY_KEY): {
            "storyCode": "NS-1",
            "storyName": "短章",
            "avgTag": None,
            "eventName": "无长摘要活动",
            "storyInfo": "无长摘要的一句话梗概",
            "storyList": [
                {"prop": "name", "attributes": {"name": "阿米娅", "content": "短章台词。"}},
            ],
        },
        _story_path(NARRATION_STORY_KEY): {
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


@pytest.fixture()
def story_zip(tmp_path: Path) -> Path:
    zip_path = tmp_path / "zh_CN.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        for inner_path, data in _story_files().items():
            zf.writestr(inner_path, json.dumps(data, ensure_ascii=False))
    return zip_path


def test_list_story_events_golden_and_empty(story_zip: Path) -> None:
    data = build_story_events_listing(story_zip, category="activities")

    assert data["total"] == 4
    assert data["filters"] == {
        "category": "activities",
        "category_normalized": "activities",
    }
    assert render_story_events_listing(data) == (
        "- [ACTIVITY] act_test：测试活动（2 章）\n"
        "- [ACTIVITY] act_no_summary：无长摘要活动（1 章）\n"
        "- [ACTIVITY] act_narration：纯旁白活动（1 章）\n"
        "- [ACTIVITY] act_empty：空活动（0 章）"
    )

    empty = build_story_events_listing(story_zip, category="main")
    assert empty["total"] == 0
    assert empty["events"] == []
    assert render_story_events_listing(empty) == "未找到符合条件的活动（category='main'）。"


def test_list_stories_without_summaries_golden(story_zip: Path) -> None:
    data = build_stories_listing(story_zip, "act_test", include_summaries=False)

    assert data == {
        "event_id": "act_test",
        "total": 2,
        "include_summaries": False,
        "chapters": [
            {
                "story_code": "TEST-1",
                "story_name": "开端",
                "story_key": FIRST_STORY_KEY,
                "avg_tag": "BEG",
            },
            {
                "story_code": "TEST-2",
                "story_name": "终章",
                "story_key": SECOND_STORY_KEY,
                "avg_tag": "END",
            },
        ],
    }
    assert render_stories_listing(data) == (
        f"- TEST-1 [BEG] 开端（key: {FIRST_STORY_KEY}）\n"
        f"- TEST-2 [END] 终章（key: {SECOND_STORY_KEY}）"
    )


def test_list_stories_with_summaries_golden(story_zip: Path) -> None:
    data = build_stories_listing(story_zip, "act_test", include_summaries=True)

    assert data["event_summary"] == "活动总览"
    assert data["chapters"][0]["summary"] == "第一章梗概"
    assert render_stories_listing(data) == (
        "活动总览\n\n"
        f"- TEST-1 [BEG] 开端（key: {FIRST_STORY_KEY}）\n"
        "  第一章梗概\n"
        f"- TEST-2 [END] 终章（key: {SECOND_STORY_KEY}）\n"
        "  第二章梗概"
    )


def test_list_stories_with_summaries_but_no_event_summary(story_zip: Path) -> None:
    data = build_stories_listing(story_zip, "act_no_summary", include_summaries=True)

    assert "event_summary" not in data
    assert render_stories_listing(data) == (
        f"- NS-1 短章（key: {NO_SUMMARY_STORY_KEY}）\n"
        "  无长摘要的一句话梗概"
    )


def test_list_stories_empty_event_is_structured_empty(story_zip: Path) -> None:
    data = build_stories_listing(story_zip, "act_empty")

    assert data["total"] == 0
    assert data["chapters"] == []
    assert render_stories_listing(data) == "活动 'act_empty' 暂无剧情章节。"


def test_get_operator_memoirs_golden(story_zip: Path) -> None:
    data = build_operator_memoirs(story_zip, "阿米娅")

    assert data == {
        "operator_name": "阿米娅",
        "internal_code": "amiya",
        "operator_id": "char_002_amiya",
        "total": 1,
        "chapters": [
            {
                "story_code": "AM-1",
                "story_name": "出发",
                "story_key": MEMOIR_STORY_KEY,
            }
        ],
    }
    assert render_operator_memoirs(data) == (
        "# 阿米娅（code: amiya，id: char_002_amiya）\n"
        "共 1 章密录\n\n"
        f"- AM-1 出发（key: {MEMOIR_STORY_KEY}）"
    )


def test_find_character_appearances_golden_and_empty(story_zip: Path) -> None:
    data = build_character_appearances(story_zip, "博士")

    assert data["total"] == 2
    assert data["appearances"][0]["speaks"] is True
    assert data["appearances"][0]["mentioned"] is True
    assert render_character_appearances(data) == (
        "# 「博士」的出场（共 2 章）\n"
        f"- [speaks+mentioned] act_test / TEST-1 开端（key: {FIRST_STORY_KEY}）\n"
        f"- [speaks] act_test / TEST-2 终章（key: {SECOND_STORY_KEY}）"
    )

    empty = build_character_appearances(story_zip, "不存在", scope="act_test")
    assert empty["total"] == 0
    assert empty["appearances"] == []
    assert render_character_appearances(empty) == (
        "未找到「不存在」的出场记录。（限定活动：'act_test'）"
    )


def test_find_speakers_in_golden_and_empty(story_zip: Path) -> None:
    data = build_speakers_in_event(story_zip, "act_test")

    assert data == {
        "event_id": "act_test",
        "total": 2,
        "speakers": [
            {"name": "博士", "line_count": 2},
            {"name": "阿米娅", "line_count": 1},
        ],
    }
    assert render_speakers_in_event(data) == (
        "# act_test 的发言角色（共 2 位）\n"
        "- 博士（2 句）\n"
        "- 阿米娅（1 句）"
    )

    empty = build_speakers_in_event(story_zip, "act_narration")
    assert empty["total"] == 0
    assert empty["speakers"] == []
    assert render_speakers_in_event(empty) == "活动 'act_narration' 暂无对话发言者数据。"


@pytest.mark.parametrize(
    ("builder", "renderer", "args"),
    [
        (build_story_events_listing, render_story_events_listing, ("activities",)),
        (build_stories_listing, render_stories_listing, ("act_test",)),
        (build_operator_memoirs, render_operator_memoirs, ("阿米娅",)),
        (build_character_appearances, render_character_appearances, ("博士",)),
        (build_speakers_in_event, render_speakers_in_event, ("act_test",)),
    ],
)
def test_story_payloads_emit_structured_content_in_both_channel(
    story_zip: Path,
    builder,
    renderer,
    args,
) -> None:
    data = builder(story_zip, *args)
    markdown = renderer(data)

    result = render_result(data, markdown, channel="both")

    assert result.structuredContent == data
    assert len(result.content) == 1
    assert result.content[0].text == markdown


async def _fake_search_prts(
    query: str,
    limit: int = 5,
    search_mode: str = "text",
    filter_technical: bool = True,
) -> dict:
    return {
        "totalhits": 9,
        "results": [{"title": "阿米娅", "snippet": "罗德岛公开领袖。"}],
    }


def test_search_prts_build_render_and_totalhits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("prts_mcp.tools_prts._search_prts", _fake_search_prts)

    data = asyncio.run(_build_prts_search("阿米娅", limit=1))

    assert data == {
        "query": "阿米娅",
        "search_mode": "text",
        "total": 9,
        "results": [{"title": "阿米娅", "snippet": "罗德岛公开领袖。"}],
    }
    assert _render_prts_search(data) == (
        "# 搜索 \"阿米娅\"（共 9 条匹配）\n"
        "**阿米娅**\n"
        "罗德岛公开领袖。"
    )
    result = render_result(data, _render_prts_search(data), channel="both")
    assert result.structuredContent == data


async def _fake_empty_search_prts(
    query: str,
    limit: int = 5,
    search_mode: str = "text",
    filter_technical: bool = True,
) -> dict:
    return {"totalhits": 0, "results": []}


def test_search_prts_empty_is_structured_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("prts_mcp.tools_prts._search_prts", _fake_empty_search_prts)

    data = asyncio.run(_build_prts_search("不存在"))

    assert data == {
        "query": "不存在",
        "search_mode": "text",
        "total": 0,
        "results": [],
    }
    assert _render_prts_search(data) == "未找到与 '不存在' 相关的词条。"


def test_search_prts_invalid_mode_is_content_only_error() -> None:
    assert asyncio.run(_build_prts_search("阿米娅", search_mode="bad")) == (
        "无效的 search_mode 参数，可选值：text、title。"
    )


async def _raising_search_prts(*_args, **_kwargs) -> dict:
    raise RuntimeError("network down")


def test_search_prts_network_failure_is_content_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("prts_mcp.tools_prts._search_prts", _raising_search_prts)
    app = FastMCP("prts-test")
    register_prts_tools(app)

    result = asyncio.run(
        app._tool_manager.call_tool(
            "search_prts", {"query": "阿米娅"}, convert_result=True,
        )
    )

    assert result.structuredContent is None
    assert result.content[0].text == "搜索 PRTS 失败：network down"


def test_p2b_manifest_output_schema_shape() -> None:
    app = FastMCP("manifest-test")
    register_story_tools(app)
    register_prts_tools(app)

    tools = {tool.name: tool for tool in asyncio.run(app.list_tools())}
    for name in {
        "list_story_events",
        "list_stories",
        "get_operator_memoirs",
        "find_character_appearances",
        "find_speakers_in",
        "search_prts",
    }:
        assert tools[name].outputSchema is None, f"{name} still has outputSchema"

    assert tools["search_stories"].outputSchema is not None
