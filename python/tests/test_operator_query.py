"""MCP-level parity for the operator information actions and output channels."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from mcp.server import MCPServer
from mcp.server.mcpserver import Context

from prts_mcp.data.building import clear_building_caches
from prts_mcp.data.operator import clear_operator_caches
from prts_mcp.data.skill import clear_skill_caches
from prts_mcp.output import _channel_var
from prts_mcp.tools_gamedata import register_gamedata_tools
from tests.fixtures import write_minimal_gamedata

PARITY = Path(__file__).parents[2] / "tests" / "parity-fixtures"
CASES = json.loads((PARITY / "operator-query-cases.json").read_text())


@pytest.fixture
def operator_app(tmp_path, monkeypatch):
    write_minimal_gamedata(tmp_path)
    monkeypatch.setenv("GAMEDATA_PATH", str(tmp_path))
    for clear in (clear_operator_caches, clear_building_caches, clear_skill_caches):
        clear()
    app = MCPServer("operator-query-test")
    register_gamedata_tools(app)
    yield app, tmp_path
    for clear in (clear_operator_caches, clear_building_caches, clear_skill_caches):
        clear()


def call_operator(app, args, channel):
    async def call():
        token = _channel_var.set(channel)
        try:
            return await app._tool_manager.call_tool(
                "get_operator_basic_info", args, Context(mcp_server=app),
                convert_result=True,
            )
        finally:
            _channel_var.reset(token)
    return asyncio.run(call())


@pytest.mark.parametrize("channel", ["content", "structured", "both"])
@pytest.mark.parametrize("case", CASES)
def test_operator_actions_match_shared_contract(operator_app, channel, case):
    app, _ = operator_app
    result = call_operator(app, case["args"], channel)
    text = result.content[0].text
    if "error" in case:
        assert text == case["error"]
        assert result.structured_content is None
        return

    if channel != "content":
        expected = json.loads((PARITY / case["fixture"]).read_text())
        assert result.structured_content == expected
    else:
        assert result.structured_content is None
    if channel != "structured":
        assert case["text"] in text


def test_operator_manifest_keeps_only_name_required(operator_app):
    app, _ = operator_app
    tools = {tool.name: tool for tool in asyncio.run(app.list_tools())}
    assert "get_operator_skills" not in tools
    assert "get_operator_stats" not in tools
    schema = tools["get_operator_basic_info"].input_schema
    assert schema["required"] == ["name"]
    assert schema["properties"]["action"]["default"] == "basic"
    assert schema["properties"]["action"]["enum"] == ["basic", "skills", "stats"]


def test_basic_and_stats_do_not_require_skill_table(operator_app):
    app, root = operator_app
    (root / "zh_CN/gamedata/excel/skill_table.json").unlink()
    for action in ("basic", "stats"):
        assert call_operator(app, {"name": "阿米娅", "action": action}, "both").structured_content
    result = call_operator(app, {"name": "阿米娅", "action": "skills"}, "both")
    assert result.structured_content is None
    assert "战斗技能数据文件不存在" in result.content[0].text
