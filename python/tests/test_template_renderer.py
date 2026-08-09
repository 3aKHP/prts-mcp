"""Regression coverage for rendered PRTS template fields (#125)."""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import pytest
from mcp.server import MCPServer
from mcp.server.mcpserver import Context

import prts_mcp.api.prts_wiki as prts_wiki
from prts_mcp.api.template_renderer import TemplateRenderError, render_template_data
from prts_mcp.tools_prts import register_prts_tools


def _fixture() -> dict:
    path = Path(__file__).parents[2] / "tests" / "parity-fixtures" / "template_nested_rendering.json"
    return json.loads(path.read_text(encoding="utf-8"))


class _Response:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self.payload


class _TemplateClient:
    def __init__(self, fixture: dict) -> None:
        self.fixture = fixture
        self.get_params: dict | None = None
        self.post_data: dict | None = None

    async def get(self, _url: str, *, params: dict) -> _Response:
        self.get_params = params
        return _Response({"parse": {"parsetree": {"*": self.fixture["parsetree"]}}})

    async def post(self, _url: str, *, data: dict) -> _Response:
        self.post_data = data
        text = data["text"]
        markers = list(re.finditer(r"(PRTSMCP_[0-9a-f]{32}_BEGIN_(\d+)_)", text))
        assert len(markers) == len(self.fixture["rendered_values"])
        html = []
        for marker, value in zip(markers, self.fixture["rendered_values"], strict=True):
            begin = marker.group(1)
            end = begin.replace("_BEGIN_", "_END_")
            html.append(f"<p>{begin}\n{value}\n{end}</p>")
        return _Response({"parse": {"text": {"*": "\n".join(html)}}})


async def _no_rate_limit() -> None:
    pass


def test_get_template_data_renders_nested_fields_in_one_post(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _fixture()
    client = _TemplateClient(fixture)
    monkeypatch.setattr(prts_wiki, "_get_client", lambda: client)
    monkeypatch.setattr(prts_wiki, "_rate_limit", _no_rate_limit)

    result = asyncio.run(prts_wiki.get_template_data(fixture["title"]))

    assert result == fixture["expected"]
    assert client.get_params == {
        "action": "parse",
        "page": fixture["title"],
        "prop": "parsetree",
        "format": "json",
    }
    assert client.post_data is not None
    assert client.post_data["action"] == "parse"
    assert client.post_data["title"] == fixture["title"]
    assert client.post_data["prop"] == "text"
    assert "攻击造成{{color|#00B0FF|法术伤害}}。" in client.post_data["text"]
    assert "攻击力{{*|100%}}" in client.post_data["text"]
    assert "查看[[阿米娅|阿米娅]]" in client.post_data["text"]
    assert "数值" not in client.post_data["text"]


def test_template_renderer_rejects_unknown_nested_node() -> None:
    xml = "<root><template><title>Test</title><part><name>字段</name><value><h>标题</h></value></part></template></root>"

    with pytest.raises(TemplateRenderError, match="不支持的模板字段节点：h"):
        asyncio.run(render_template_data("测试", xml, _unexpected_render))


def test_template_renderer_skips_batch_render_for_plain_values() -> None:
    xml = "<root><template><title>Test</title><part><name>数值</name><value>12</value></part></template></root>"

    result = asyncio.run(render_template_data("测试", xml, _unexpected_render))

    assert result == {"Test": {"数值": "12"}}


async def _unexpected_render(_title: str, _values: list[str]) -> list[str]:
    raise AssertionError("unsupported XML must not reach the renderer")


def test_prts_page_returns_content_only_template_render_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_template(_title: str) -> dict:
        raise TemplateRenderError('模板字段渲染失败。请改用 action="read" 获取正文。')

    monkeypatch.setattr("prts_mcp.tools_prts._get_template_data", fail_template)
    app = MCPServer("template-renderer-test")
    register_prts_tools(app)

    result = asyncio.run(
        app._tool_manager.call_tool(
            "prts_page",
            {"page_title": "阿米娅", "action": "template"},
            Context(mcp_server=app),
            convert_result=True,
        )
    )

    assert result.structured_content is None
    assert result.content[0].text == '模板字段渲染失败。请改用 action="read" 获取正文。'
