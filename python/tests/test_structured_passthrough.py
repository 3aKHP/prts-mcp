"""Regression guard for the SDK structuredContent pass-through contract.

The whole output-channel design rests on one assumption validated by the
P1 spike: a tool that returns a hand-built ``CallToolResult`` reaches the
client with ``content`` and ``structuredContent`` exactly as built — MCPServer
does not rewrite content to JSON, drop structuredContent, or auto-derive
an ``outputSchema``. That assumption lives in the SDK's ``convert_result``
``isinstance(result, CallToolResult)`` branch; if a future SDK version
changes it, the failure is **silent** (structuredContent vanishes, or an
extra serialized JSON block appears) and every other test stays green.

These tests exercise the *real* MCPServer tool-call path
(``ToolManager.call_tool(..., convert_result=True)`` — the same call the
lowlevel server handler makes), not the ``render_result`` helper directly.
A dedicated probe tool returns a fixed ``CallToolResult`` so the assertion
isolates "did the SDK pass it through?" from env parsing and data-layer
behaviour.

The suite is synchronous (``asyncio.run``) to match the project's testing
style — no pytest-asyncio dependency.
"""
from __future__ import annotations

import asyncio

import pytest
from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import CallToolResult

from prts_mcp.output import render_result

_PROBE_DATA = {"total": 2, "stages": [{"stage_id": "main_00-01"}, {"stage_id": "main_00-02"}]}
_PROBE_MD = "# probe\n\n- main_00-01\n- main_00-02"


def _build_probe_app(channel: str) -> MCPServer:
    """MCPServer app with one probe tool returning render_result(...) for a channel.

    The probe fixes its inputs so only the channel (and thus the SDK
    pass-through) varies — env parsing and the data layer are out of scope.
    """

    app = MCPServer("probe")

    @app.tool()
    async def probe() -> object:  # returns a CallToolResult, not a str
        return render_result(_PROBE_DATA, _PROBE_MD, channel=channel)  # type: ignore[arg-type]

    return app


def _call_probe(channel: str) -> CallToolResult:
    """Drive the probe tool through the real MCPServer tool-call path."""
    app = _build_probe_app(channel)
    result = asyncio.run(
        app._tool_manager.call_tool(
            "probe", {}, Context(mcp_server=app), convert_result=True
        )
    )
    return result  # type: ignore[return-value]


@pytest.mark.parametrize("channel", ["content", "structured", "both"])
def test_sdk_passes_through_call_tool_result_verbatim(channel: str) -> None:
    result = _call_probe(channel)

    # The SDK must hand back exactly the CallToolResult the tool built —
    # not unwrap it, not re-serialize it, not append a JSON block.
    assert isinstance(result, CallToolResult), (
        f"SDK did not pass the CallToolResult through for channel={channel!r}; "
        f"got {type(result).__name__}"
    )

    if channel == "content":
        assert result.structured_content is None
        assert len(result.content) == 1
        assert result.content[0].text == _PROBE_MD
    elif channel == "both":
        assert result.structured_content == _PROBE_DATA
        # Exactly one text block — no extra serialized-JSON block appended.
        assert len(result.content) == 1, "both channel appended an extra content block"
        assert result.content[0].text == _PROBE_MD
    else:  # structured
        assert result.structured_content == _PROBE_DATA
        assert result.content[0].text != _PROBE_MD  # summary, not full markdown
        assert len(result.content) == 1


def test_no_output_schema_pollutes_the_manifest() -> None:
    app = _build_probe_app("both")
    tools = asyncio.run(app.list_tools())
    probe = next(t for t in tools if t.name == "probe")
    assert probe.output_schema is None, (
        "Returning a CallToolResult derived an outputSchema; this would eat the "
        "context budget the consolidation work is trying to save."
    )


def test_str_annotation_rejects_explicit_call_tool_result() -> None:
    """Guard against forgetting -> object when migrating tools in P2.

    MCPServer derives outputSchema from the return annotation. If a tool keeps
    ``-> str`` but starts returning our explicit ``CallToolResult``, MCPServer
    validates that object against ``{result: string}`` and the tool call fails.
    """

    app = MCPServer("bad-probe")

    @app.tool()
    async def bad_probe() -> str:
        return render_result(  # type: ignore[return-value]
            _PROBE_DATA, _PROBE_MD, channel="content"
        )

    with pytest.raises(ToolError) as excinfo:
        asyncio.run(
            app._tool_manager.call_tool(
                "bad_probe", {}, Context(mcp_server=app), convert_result=True
            )
        )

    message = str(excinfo.value)
    assert "validation error" in message
    assert "bad_probeOutput" in message
