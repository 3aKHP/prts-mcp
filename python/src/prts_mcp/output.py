"""Output-channel rendering for 2.0 structuredContent support.

The 2.0 output-channel plan (``dev/docs/2.0-output-channel-plan.md``) splits
the orthogonal axes of *text rendering* (markdown) and *structured data*
(dict) and carries them on MCP's native ``content`` / ``structuredContent``
channels. The control plane is a single connection-level knob
``output_channel`` — not a per-call tool parameter — because its correct
value depends on which client owns the connection, which the LLM cannot
know.

This module hosts:

- ``OutputChannel`` — the enum and env-var parser (``OUTPUT_CHANNEL``).
- ``render_result`` — the cross-cutting helper that turns a
  ``(data, markdown)`` pair into a ``CallToolResult`` shaped by the channel.

Layering: depends only on ``mcp.types``. No data/api imports. Called from
the ``tools_*`` registration modules.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Literal

from mcp.types import CallToolResult, TextContent

_logger = logging.getLogger("prts_mcp.output")

#: Accepted channel values. ``content`` is the default and reproduces the
#: pre-2.0 behaviour byte-for-byte (markdown text only, no structuredContent).
OutputChannel = Literal["content", "structured", "both"]

_VALID_CHANNELS: frozenset[str] = frozenset({"content", "structured", "both"})


def _parse_channel(raw: str | None) -> OutputChannel:
    """Resolve the env var to a valid channel, falling back to ``content``.

    An unset or empty value yields the default ``content``. An unrecognized
    value logs a warning and also falls back to ``content`` rather than
    raising — a misconfigured channel must never break tool calls.
    """
    if not raw:
        return "content"
    value = raw.strip().lower()
    if value not in _VALID_CHANNELS:
        _logger.warning(
            "OUTPUT_CHANNEL=%r 不合法（可选 content/structured/both），回退到 content。", raw
        )
        return "content"
    return value  # type: ignore[return-value]


#: Connection-level channel, read once at import time. On stdio a connection
#: maps to one process, so a module-level constant is the right scope.
OUTPUT_CHANNEL: OutputChannel = _parse_channel(os.environ.get("OUTPUT_CHANNEL"))


def render_result(
    data: dict[str, Any] | None,
    markdown: str,
    channel: OutputChannel = OUTPUT_CHANNEL,
) -> CallToolResult:
    """Build a ``CallToolResult`` carrying markdown text and/or structured data.

    The two inputs are kept orthogonal: ``markdown`` is always the
    human-readable rendering, ``data`` is always the structured payload
    (or ``None`` when the call hit an error/missing-data path).

    Channel behaviour:

    - ``content``   → content = ``markdown``; no structuredContent.
                      (Today's behaviour, byte-for-byte. The default.)
    - ``structured`` → content = a one-line summary derived from ``data``;
                      structuredContent = ``data``. Avoids emitting both the
                      full markdown and the JSON for capable clients.
    - ``both``      → content = ``markdown``; structuredContent = ``data``.
                      Debug / dual-channel compatibility, accepts the token cost.

    When ``data is None`` (error / missing data), every channel falls back to
    a content-only result carrying ``markdown`` — per the design doc, errors
    never travel in structuredContent.
    """
    if data is None:
        # Error / missing-data path: text only, regardless of channel.
        return CallToolResult(
            content=[TextContent(type="text", text=markdown)],
            structuredContent=None,
            isError=False,
        )

    if channel == "content":
        return CallToolResult(
            content=[TextContent(type="text", text=markdown)],
            structuredContent=None,
            isError=False,
        )

    if channel == "both":
        return CallToolResult(
            content=[TextContent(type="text", text=markdown)],
            structuredContent=data,
            isError=False,
        )

    # channel == "structured": minimal content summary + structured payload.
    summary = _summarize(data)
    return CallToolResult(
        content=[TextContent(type="text", text=summary)],
        structuredContent=data,
        isError=False,
    )


def _summarize(data: dict[str, Any]) -> str:
    """Derive a one-line content summary for ``structured`` mode.

    The floor per the design doc (§4/§10) is "don't degrade to
    'incapable clients see nothing'". A short header naming the payload and
    its size is the generic template; tools with richer summary needs may
    build their own string and pass it as ``markdown`` instead.
    """
    total = data.get("total")
    if isinstance(total, int):
        return f"（结构化结果共 {total} 条，详见 structuredContent）"
    return "（结构化结果详见 structuredContent）"
