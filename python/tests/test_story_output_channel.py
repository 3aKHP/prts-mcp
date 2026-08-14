"""Golden tests for P2b story/wiki output-channel migration."""
from __future__ import annotations

import asyncio
import json
import zipfile
from pathlib import Path

import pytest
from mcp.server import MCPServer
from mcp.server.mcpserver import Context

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
NO_SUMMARY_SECOND_STORY_KEY = "activities/act_no_summary/level_act_no_summary_02"
NARRATION_STORY_KEY = "activities/act_narration/level_act_narration_01"
MEMOIR_STORY_KEY = "memory/amiya/level_amiya_01"


def _story_path(story_key: str) -> str:
    return f"zh_CN/gamedata/story/{story_key}.json"


def _load_parity_fixture(name: str) -> dict:
    path = Path(__file__).parents[2] / "tests" / "parity-fixtures" / name
    return json.loads(path.read_text(encoding="utf-8"))


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
                    },
                    {
                        "storyTxt": NO_SUMMARY_SECOND_STORY_KEY,
                        "storyCode": "NS-2",
                        "storyName": "无摘要章",
                        "avgTag": None,
                        "storySort": 2,
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
            "nomemoir": {"name": "无密录干员", "id": "char_999_nomemoir"},
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
        _story_path(NO_SUMMARY_SECOND_STORY_KEY): {
            "storyCode": "NS-2",
            "storyName": "无摘要章",
            "avgTag": None,
            "eventName": "无长摘要活动",
            "storyInfo": "",
            "storyList": [
                {"prop": "name", "attributes": {"name": "阿米娅", "content": "没有一句话梗概。"}},
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

    assert data == _load_parity_fixture("story_events_activities.json")
    assert data["total"] == 4
    assert data["filters"] == {
        "category": "activities",
        "category_normalized": "activities",
    }
    assert render_story_events_listing(data) == (
        "- [ACTIVITY] act_test：测试活动（2 章）\n"
        "- [ACTIVITY] act_no_summary：无长摘要活动（2 章）\n"
        "- [ACTIVITY] act_narration：纯旁白活动（1 章）\n"
        "- [ACTIVITY] act_empty：空活动（0 章）"
    )

    empty = build_story_events_listing(story_zip, category="main")
    assert empty == _load_parity_fixture("story_events_empty.json")
    assert empty["total"] == 0
    assert empty["events"] == []
    assert render_story_events_listing(empty) == "未找到符合条件的活动（category='main'）。"


def test_list_stories_without_summaries_golden(story_zip: Path) -> None:
    data = build_stories_listing(story_zip, "act_test", include_summaries=False)

    assert data == _load_parity_fixture("list_stories.json")
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

    assert data == _load_parity_fixture("list_stories_with_summaries.json")
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

    assert data == _load_parity_fixture("list_stories_no_summary.json")
    assert "event_summary" not in data
    assert data["chapters"][1]["summary"] == ""
    assert render_stories_listing(data) == (
        f"- NS-1 短章（key: {NO_SUMMARY_STORY_KEY}）\n"
        "  无长摘要的一句话梗概\n"
        f"- NS-2 无摘要章（key: {NO_SUMMARY_SECOND_STORY_KEY}）"
    )


def test_list_stories_empty_event_is_structured_empty(story_zip: Path) -> None:
    data = build_stories_listing(story_zip, "act_empty")

    assert data == _load_parity_fixture("list_stories_empty_event.json")
    assert data["total"] == 0
    assert data["chapters"] == []
    assert render_stories_listing(data) == "活动 'act_empty' 暂无剧情章节。"


def test_get_operator_memoirs_golden(story_zip: Path) -> None:
    data = build_operator_memoirs(story_zip, "阿米娅")

    assert data == _load_parity_fixture("operator_memoirs.json")
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

    assert data == _load_parity_fixture("character_appearances.json")
    assert data["total"] == 2
    assert data["appearances"][0]["speaks"] is True
    assert data["appearances"][0]["mentioned"] is True
    assert render_character_appearances(data) == (
        "# 「博士」的出场（共 2 章）\n"
        f"- [speaks+mentioned] act_test / TEST-1 开端（key: {FIRST_STORY_KEY}）\n"
        f"- [speaks] act_test / TEST-2 终章（key: {SECOND_STORY_KEY}）"
    )

    empty = build_character_appearances(story_zip, "不存在", scope="act_test")
    assert empty == _load_parity_fixture("character_appearances_empty.json")
    assert empty["total"] == 0
    assert empty["appearances"] == []
    assert render_character_appearances(empty) == (
        "未找到「不存在」的出场记录。（限定活动：'act_test'）"
    )


def test_find_speakers_in_golden_and_empty(story_zip: Path) -> None:
    data = build_speakers_in_event(story_zip, "act_test")

    assert data == _load_parity_fixture("speakers_in_event.json")
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
    assert empty == _load_parity_fixture("speakers_in_event_empty.json")
    assert empty["total"] == 0
    assert empty["speakers"] == []
    assert render_speakers_in_event(empty) == "活动 'act_narration' 暂无对话发言者数据。"


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

    assert data == _load_parity_fixture("search_prts.json")
    assert _render_prts_search(data) == (
        "# 搜索 \"阿米娅\"（共 9 条匹配）\n"
        "**阿米娅**\n"
        "罗德岛公开领袖。"
    )


async def _fake_filtered_empty_search_prts(
    query: str,
    limit: int = 5,
    search_mode: str = "text",
    filter_technical: bool = True,
) -> dict:
    return {"totalhits": 9, "results": []}


def test_search_prts_filtered_empty_keeps_totalhits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("prts_mcp.tools_prts._search_prts", _fake_filtered_empty_search_prts)

    data = asyncio.run(_build_prts_search("阿米娅", limit=1))

    assert data == {
        "query": "阿米娅",
        "search_mode": "text",
        "filters": {
            "limit": 1,
            "filter_technical": True,
        },
        "total": 9,
        "results": [],
    }
    assert _render_prts_search(data) == "未找到与 '阿米娅' 相关的词条。"


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

    assert data == _load_parity_fixture("search_prts_empty.json")
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
    app = MCPServer("prts-test")
    register_prts_tools(app)

    result = asyncio.run(
        app._tool_manager.call_tool(
            "search_prts", {"query": "阿米娅"}, Context(mcp_server=app),
            convert_result=True,
        )
    )

    assert result.structured_content is None
    assert result.content[0].text == "搜索 PRTS 失败：network down"


def test_search_stories_missing_zip_is_content_only(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("STORYJSON_PATH", str(tmp_path / "missing.zip"))
    app = MCPServer("story-test")
    register_story_tools(app)

    result = asyncio.run(
        app._tool_manager.call_tool(
            "search_stories", {"pattern": "博士"}, Context(mcp_server=app),
            convert_result=True,
        )
    )

    assert result.structured_content is None
    assert result.content[0].text == (
        "剧情数据未就绪。请设置 STORYJSON_PATH 环境变量指向 zh_CN.zip，"
        "或等待服务器自动从 GitHub Release 下载完成后重试。"
    )


def test_list_story_events_missing_zip_is_content_only(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Regression for #42: list_story_events returned a bare str on the
    # missing-zip path, which the MCP server then wrapped into an automatic
    # structuredContent={"result": ...}. The fix routes it through
    # text_result(...) so the missing-data message stays content-only.
    monkeypatch.setenv("STORYJSON_PATH", str(tmp_path / "missing.zip"))
    app = MCPServer("story-test")
    register_story_tools(app)

    result = asyncio.run(
        app._tool_manager.call_tool(
            "list_story_events", {}, Context(mcp_server=app), convert_result=True,
        )
    )

    assert result.structured_content is None
    assert result.content[0].text == (
        "剧情数据未就绪。请设置 STORYJSON_PATH 环境变量指向 zh_CN.zip，"
        "或等待服务器自动从 GitHub Release 下载完成后重试。"
    )


def test_read_activity_out_of_range_page_is_content_only(
    monkeypatch: pytest.MonkeyPatch,
    story_zip: Path,
) -> None:
    monkeypatch.setenv("STORYJSON_PATH", str(story_zip))
    app = MCPServer("story-test")
    register_story_tools(app)

    result = asyncio.run(
        app._tool_manager.call_tool(
            "read_activity",
            {"event_id": "act_test", "page": 3, "page_size": 1},
            Context(mcp_server=app),
            convert_result=True,
        )
    )

    assert result.structured_content is None
    assert result.content[0].text == (
        "页码超出范围：act_test 共 2 章，按 page_size=1 分页共 2 页，请求的 page=3 不存在。"
    )


def test_read_activity_page_schema_requires_positive_integer() -> None:
    app = MCPServer("story-test")
    register_story_tools(app)

    tools = asyncio.run(app.list_tools())
    read_activity = next(tool for tool in tools if tool.name == "read_activity")
    page_schema = read_activity.input_schema["properties"]["page"]

    assert page_schema["anyOf"][0]["minimum"] == 1


# ---------------------------------------------------------------------------
# Story text parity with the TS twin (fix/v2.7.0-story-text-parity)
# ---------------------------------------------------------------------------


def _call_story_tool(app: MCPServer, name: str, args: dict) -> str:
    result = asyncio.run(
        app._tool_manager.call_tool(
            name, args, Context(mcp_server=app), convert_result=True,
        )
    )
    return result.content[0].text


def _story_app() -> MCPServer:
    app = MCPServer("story-parity-test")
    register_story_tools(app)
    return app


def test_read_activity_paged_rendering_matches_ts(
    monkeypatch: pytest.MonkeyPatch,
    story_zip: Path,
) -> None:
    monkeypatch.setenv("STORYJSON_PATH", str(story_zip))
    app = _story_app()

    text = _call_story_tool(
        app, "read_activity", {"event_id": "act_test", "page": 1, "page_size": 1},
    )

    assert text.startswith("# 测试活动（共 2 章，当前为部分内容）")
    assert "简介：第一章梗概" in text
    assert '[还有更多章节，请调用 read_activity(event_id="act_test", page=2)]' in text
    # The old Python-only inline pagination header is gone.
    assert "当前第 1 页" not in text
    assert "还有更多（下一页" not in text


def test_read_activity_full_rendering_has_no_partial_marker(
    monkeypatch: pytest.MonkeyPatch,
    story_zip: Path,
) -> None:
    monkeypatch.setenv("STORYJSON_PATH", str(story_zip))
    app = _story_app()

    text = _call_story_tool(app, "read_activity", {"event_id": "act_test"})

    assert text.startswith("# 测试活动（共 2 章）")
    assert "当前为部分内容" not in text
    assert "还有更多章节" not in text


def test_story_not_found_messages_double_quoted(
    monkeypatch: pytest.MonkeyPatch,
    story_zip: Path,
) -> None:
    monkeypatch.setenv("STORYJSON_PATH", str(story_zip))
    app = _story_app()

    assert _call_story_tool(app, "list_stories", {"event_id": "no-such-event"}) == (
        '未找到活动："no-such-event"。请先调用 list_story_events 确认活动 ID。'
    )
    assert _call_story_tool(
        app, "read_story", {"story_key": "no-such-key"},
    ) == '未找到剧情："no-such-key"。请通过 list_stories 确认章节 key。'
    # get_story_summary's not-found comes from the data layer as a message
    # string (already identical on both implementations).
    assert _call_story_tool(
        app, "get_story_summary", {"story_key": "no-such-key"},
    ) == "未找到剧情章节 'no-such-key' 的梗概。"
    assert _call_story_tool(
        app, "find_speakers_in", {"event_id": "no-such-event"},
    ) == '未找到匹配的活动："no-such-event"。'


def test_operator_memoirs_no_data_message_is_bare(
    monkeypatch: pytest.MonkeyPatch,
    story_zip: Path,
) -> None:
    monkeypatch.setenv("STORYJSON_PATH", str(story_zip))
    app = _story_app()

    # 无密录干员 exists in chardict but has no memoir chapters.
    text = _call_story_tool(app, "get_operator_memoirs", {"name": "无密录干员"})

    # No KeyError repr wrapper quotes around the message.
    assert text == "干员 '无密录干员' (code=nomemoir) 暂无密录数据。"
