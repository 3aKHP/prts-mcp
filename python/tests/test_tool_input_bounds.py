"""Tool input bounds enforced at the FastMCP validation layer.

FastMCP builds a pydantic model from each tool's ``Annotated[..., Field(...)]``
signature; ``ge``/``le`` constraints are validated inside ``Tool.run`` (via
``arg_model.model_validate``) before the function body — and therefore the data
layer — executes, surfacing as ``ToolError``. These tests drive the real call
path (``FastMCP.call_tool`` → ``ToolManager.call_tool`` → ``Tool.run``) so a
drift between the schema bounds and the TypeScript twin fails loudly.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

pytest.importorskip(
    "mcp.server.fastmcp.exceptions",
    reason="requires the real mcp[cli] runtime (stubbed out in minimal environments)",
)
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError

from prts_mcp.tools_gamedata import register_gamedata_tools
from prts_mcp.tools_story import register_story_tools


def _call_tool(app: FastMCP, name: str, arguments: dict) -> str:
    content, _ = asyncio.run(app.call_tool(name, arguments))
    return content[0].text


@pytest.fixture
def story_app() -> FastMCP:
    app = FastMCP("bounds-test-story")
    register_story_tools(app)
    return app


@pytest.mark.parametrize(
    "arguments",
    [
        {"event_id": "act_test", "page": 0},
        {"event_id": "act_test", "page": -1},
        {"event_id": "act_test", "page_size": 0},
        {"event_id": "act_test", "page_size": 21},
    ],
)
def test_read_activity_rejects_out_of_range_pagination(
    story_app: FastMCP, arguments: dict
) -> None:
    # A nonexistent event_id would make the tool body return a graceful
    # message, never raise — so a ToolError here proves the pydantic arg model
    # rejected the call before the data layer ran.
    with pytest.raises(ToolError, match="validation error"):
        asyncio.run(story_app.call_tool("read_activity", arguments))


def test_read_activity_accepts_boundary_pagination(
    story_app: FastMCP, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # With no story zip configured the body degrades gracefully; reaching that
    # message proves the boundary values passed validation.
    monkeypatch.setenv("STORYJSON_PATH", str(tmp_path / "missing.zip"))

    for arguments in (
        {"event_id": "act_test", "page": 1, "page_size": 1},
        {"event_id": "act_test", "page": 1, "page_size": 20},
        {"event_id": "act_test"},
    ):
        text = _call_tool(story_app, "read_activity", arguments)
        # No zip -> "剧情数据未就绪..."; bundled zip present (Docker image)
        # -> "未找到活动：'act_test'...". Both prove the body ran.
        assert text.startswith(("剧情数据未就绪", "未找到活动")), f"{arguments}: {text[:120]}"


_GAMEDATA_LIST_TOOLS = ("list_enemies", "get_enemy_appearances", "list_stages", "list_items")

# Minimum extra arguments each list tool needs besides limit/offset.
_GAMEDATA_REQUIRED_ARGS: dict[str, dict] = {
    "list_enemies": {},
    "get_enemy_appearances": {"name": "源石虫"},
    "list_stages": {},
    "list_items": {},
}


@pytest.fixture
def gamedata_app() -> FastMCP:
    app = FastMCP("bounds-test-gamedata")
    register_gamedata_tools(app)
    return app


@pytest.mark.parametrize("tool", _GAMEDATA_LIST_TOOLS)
@pytest.mark.parametrize("bad", [{"limit": 0}, {"limit": 201}, {"offset": -1}])
def test_gamedata_list_tools_reject_out_of_range_pagination(
    gamedata_app: FastMCP, tool: str, bad: dict
) -> None:
    # With no valid gamedata configured the tool body would return a graceful
    # message, never raise — so a ToolError here proves the pydantic arg model
    # rejected the call before the data layer ran.
    arguments = _GAMEDATA_REQUIRED_ARGS[tool] | bad
    with pytest.raises(ToolError, match="validation error"):
        asyncio.run(gamedata_app.call_tool(tool, arguments))


@pytest.mark.parametrize("tool", _GAMEDATA_LIST_TOOLS)
def test_gamedata_list_tools_accept_boundary_pagination(
    gamedata_app: FastMCP,
    tool: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Empty data root: the body degrades gracefully (or, with bundled data in
    # the Docker image, returns real content). Either way a ToolError from the
    # validation layer would fail the call, so completing proves the boundary
    # values passed.
    monkeypatch.setenv("GAMEDATA_PATH", str(tmp_path))

    for extra in ({"limit": 1}, {"limit": 200}, {"offset": 0}):
        text = _call_tool(gamedata_app, tool, _GAMEDATA_REQUIRED_ARGS[tool] | extra)
        assert isinstance(text, str) and text, f"{tool} {extra}"
