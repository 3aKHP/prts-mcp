"""Tests for the output-channel renderer (2.0 structuredContent support)."""
from __future__ import annotations

import importlib
import os

from mcp.types import CallToolResult

import prts_mcp.output as output_module
from prts_mcp.output import (
    _parse_channel,
    render_result,
    text_result,
)


# ---------------------------------------------------------------------------
# Channel parsing
# ---------------------------------------------------------------------------


def test_parse_channel_unset_defaults_to_content() -> None:
    assert _parse_channel(None) == "content"
    assert _parse_channel("") == "content"


def test_parse_channel_accepts_known_values_case_insensitively() -> None:
    assert _parse_channel("content") == "content"
    assert _parse_channel("STRUCTURED") == "structured"
    assert _parse_channel(" Both ") == "both"


def test_parse_channel_rejects_unknown_and_falls_back() -> None:
    # Should not raise; unknown values fall back to content.
    assert _parse_channel("yaml") == "content"
    assert _parse_channel("json") == "content"  # deliberately not a channel


def test_module_constant_reads_env_at_import(monkeypatch) -> None:
    # OUTPUT_CHANNEL is a connection-level constant resolved at import time.
    original_raw = os.environ.get("PRTS_OUTPUT_CHANNEL")
    try:
        monkeypatch.setenv("PRTS_OUTPUT_CHANNEL", "structured")
        assert importlib.reload(output_module).OUTPUT_CHANNEL == "structured"

        monkeypatch.setenv("PRTS_OUTPUT_CHANNEL", " Both ")
        assert importlib.reload(output_module).OUTPUT_CHANNEL == "both"

        monkeypatch.setenv("PRTS_OUTPUT_CHANNEL", "bad")
        assert importlib.reload(output_module).OUTPUT_CHANNEL == "content"

        monkeypatch.delenv("PRTS_OUTPUT_CHANNEL", raising=False)
        assert importlib.reload(output_module).OUTPUT_CHANNEL == "content"
    finally:
        if original_raw is None:
            monkeypatch.delenv("PRTS_OUTPUT_CHANNEL", raising=False)
        else:
            monkeypatch.setenv("PRTS_OUTPUT_CHANNEL", original_raw)
        importlib.reload(output_module)


# ---------------------------------------------------------------------------
# render_result — channel behaviour
# ---------------------------------------------------------------------------

_DATA = {"total": 2, "offset": 0, "stages": [{"stage_id": "main_00-01"}]}
_MD = "# 关卡列表\n\n- main_00-01：第一关"


def test_content_channel_emits_markdown_only() -> None:
    r = render_result(_DATA, _MD, channel="content")
    assert isinstance(r, CallToolResult)
    assert [c.text for c in r.content] == [_MD]
    assert r.structuredContent is None
    assert r.isError is False


def test_both_channel_emits_markdown_and_structured() -> None:
    r = render_result(_DATA, _MD, channel="both")
    assert [c.text for c in r.content] == [_MD]
    assert r.structuredContent == _DATA


def test_structured_channel_emits_summary_and_structured() -> None:
    r = render_result(_DATA, _MD, channel="structured")
    # content is the minimal summary, NOT the full markdown.
    assert r.content[0].text != _MD
    assert "structuredContent" in r.content[0].text or "条" in r.content[0].text
    assert r.structuredContent == _DATA


def test_structured_summary_mentions_total_count() -> None:
    r = render_result(_DATA, _MD, channel="structured")
    assert "2" in r.content[0].text


# ---------------------------------------------------------------------------
# render_result — error / missing-data path
# ---------------------------------------------------------------------------


def test_none_data_emits_markdown_only_regardless_of_channel() -> None:
    # The error/missing-data contract: never put errors in structuredContent.
    err = "limit 必须 >= 1。"
    for ch in ("content", "structured", "both"):
        r = render_result(None, err, channel=ch)  # type: ignore[arg-type]
        assert [c.text for c in r.content] == [err], f"channel={ch}"
        assert r.structuredContent is None, f"channel={ch}"


def test_structured_channel_without_total_falls_back_to_generic_summary() -> None:
    data = {"items": [1, 2, 3]}  # no "total" key
    r = render_result(data, _MD, channel="structured")
    assert r.structuredContent == data
    assert "structuredContent" in r.content[0].text


# ---------------------------------------------------------------------------
# text_result — narrative / error-path content-only helper
# ---------------------------------------------------------------------------


def test_text_result_is_content_only() -> None:
    r = text_result(_MD)
    assert isinstance(r, CallToolResult)
    assert [c.text for c in r.content] == [_MD]
    assert r.structuredContent is None
    assert r.isError is False


def test_text_result_carries_error_messages_verbatim() -> None:
    err = "未找到剧情章节：'nope'。请通过 list_stories 确认章节 key。"
    r = text_result(err)
    assert [c.text for c in r.content] == [err]
    assert r.structuredContent is None
    assert r.isError is False


# ---------------------------------------------------------------------------
# render_result — explicit summary override (detail tools)
# ---------------------------------------------------------------------------


def test_explicit_summary_used_in_structured_mode() -> None:
    # Detail payloads have no "total"; an explicit summary must win.
    data = {"name": "霜星", "id": "enemy_1505_frstar"}
    r = render_result(data, _MD, channel="structured", summary="敌人『霜星』的图鉴")
    assert r.content[0].text == "敌人『霜星』的图鉴"
    assert r.structuredContent == data


def test_explicit_summary_ignored_in_content_and_both() -> None:
    data = {"name": "霜星", "id": "enemy_1505_frstar"}
    for ch in ("content", "both"):
        r = render_result(data, _MD, channel=ch, summary="ignored")  # type: ignore[arg-type]
        assert r.content[0].text == _MD, f"channel={ch}"


def test_explicit_summary_overrides_total_when_both_present() -> None:
    # Explicit summary takes precedence even if a total happens to exist.
    data = {"total": 5, "items": []}
    r = render_result(data, _MD, channel="structured", summary="定制摘要")
    assert r.content[0].text == "定制摘要"
