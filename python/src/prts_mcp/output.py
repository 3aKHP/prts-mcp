"""Output-channel rendering for 2.0 structuredContent support.

The 2.0 output-channel plan (``dev/docs/2.0-output-channel-plan.md``) splits
the orthogonal axes of *text rendering* (markdown) and *structured data*
(dict) and carries them on MCP's native ``content`` / ``structuredContent``
channels. The control plane is a single connection-level knob
``output_channel`` — not a per-call tool parameter — because its correct
value depends on which client owns the connection, which the LLM cannot
know.

This module hosts:

- ``OutputChannel`` — the enum and env-var parser (``PRTS_OUTPUT_CHANNEL``).
- ``render_result`` — the cross-cutting helper that turns a
  ``(data, markdown)`` pair into a ``CallToolResult`` shaped by the channel.

Layering: depends only on ``mcp.types``. No data/api imports. Called from
the ``tools_*`` registration modules.
"""
from __future__ import annotations

import contextvars
import logging
import os
from typing import Any, Literal

from mcp.types import CallToolResult, ImageContent, TextContent

_logger = logging.getLogger("prts_mcp.output")

#: Accepted channel values. ``content`` is the default and preserves the
#: human-readable markdown text while avoiding FastMCP's automatic
#: ``outputSchema`` / ``structuredContent={"result": markdown}`` wrapper for
#: tools that opt in to explicit ``CallToolResult`` delivery.
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
            "PRTS_OUTPUT_CHANNEL=%r 不合法（可选 content/structured/both），回退到 content。",
            raw,
        )
        return "content"
    return value  # type: ignore[return-value]


#: Per-connection channel, backed by a ContextVar so future transports or
#: SDK changes can plug in per-connection overrides without touching tool
#: code.
#:
#: The default value is read once from the ``PRTS_OUTPUT_CHANNEL`` env var
#: and is currently the only effective source — both stdio and the
#: Streamable HTTP transport read it at process scope. Per-request
#: query/header resolution is NOT supported on the Python HTTP transport
#: (FastMCP's session model makes per-request contextvars invisible to
#: tool code; see server.py ``_build_http_app`` docstring). The TypeScript
#: HTTP transport differs, resolving channel at session creation.
#:
#: The module-level identifier ``OUTPUT_CHANNEL`` is kept as a backward-compat
#: alias for the parsed env default; the *environment variable* that populates
#: it is ``PRTS_OUTPUT_CHANNEL`` (``PRTS_`` prefix to avoid collisions in
#: shared Docker/CI environments).
_ENV_DEFAULT_CHANNEL: OutputChannel = _parse_channel(os.environ.get("PRTS_OUTPUT_CHANNEL"))

_channel_var: contextvars.ContextVar[OutputChannel] = contextvars.ContextVar(
    "prts_output_channel", default=_ENV_DEFAULT_CHANNEL
)

#: Backward-compat alias for the env-parsed default. Tools should prefer
#: :func:`get_output_channel` (the ContextVar is currently env-only but kept
#: for future transport extensibility).
OUTPUT_CHANNEL: OutputChannel = _ENV_DEFAULT_CHANNEL


def get_output_channel() -> OutputChannel:
    """Return the effective output channel for the current context.

    Currently always the env-parsed default, since per-request overrides
    are not effective under FastMCP's session model (see server.py
    ``_build_http_app`` docstring). The ContextVar indirection is kept so
    a future transport or SDK change can plug in per-connection overrides
    without touching tool code.
    """
    return _channel_var.get()


def render_result(
    data: dict[str, Any] | None,
    markdown: str,
    channel: OutputChannel | None = None,
    summary: str | None = None,
) -> CallToolResult:
    """Build a ``CallToolResult`` carrying markdown text and/or structured data.

    The two inputs are kept orthogonal: ``markdown`` is always the
    human-readable rendering, ``data`` is always the structured payload
    (or ``None`` when the call hit an error/missing-data path).

    ``channel`` resolves the effective channel via :func:`get_output_channel`
    when left as ``None`` (the default). Today that value is the env-parsed
    process default; the ContextVar indirection is reserved for future
    per-connection transport support. Pass an explicit value only when
    overriding per-call (rare).

    Channel behaviour:

    - ``content``   → content = ``markdown``; no structuredContent.
                      Preserves the text seen by content-only clients while
                      suppressing FastMCP's automatic duplicate structured
                      wrapper for migrated tools. The default.
    - ``structured`` → content = a one-line summary (see ``summary`` below);
                      structuredContent = ``data``. ``markdown`` is unused
                      in this mode (the summary is the only text an incapable
                      client sees). Avoids emitting both the full markdown and
                      the JSON for capable clients.
    - ``both``      → content = ``markdown``; structuredContent = ``data``.
                      Debug / dual-channel compatibility, accepts the token cost.

    ``summary`` overrides the one-line content shown in ``structured`` mode.
    Detail tools (single-record payloads with no ``total``) should pass an
    explicit one-liner like ``"敌人『霜星』的图鉴"``; list tools can omit it
    and let the total-based fallback apply. Ignored for ``content``/``both``.

    When ``data is None`` (error / missing data), every channel falls back to
    a content-only result carrying ``markdown`` — per the design doc, errors
    never travel in structuredContent.
    """
    if channel is None:
        channel = get_output_channel()
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
    return CallToolResult(
        content=[TextContent(type="text", text=_summarize(data, summary))],
        structuredContent=data,
        isError=False,
    )


def _summarize(data: dict[str, Any], summary: str | None = None) -> str:
    """Derive a one-line content summary for ``structured`` mode.

    Precedence: an explicit ``summary`` (detail tools) wins; otherwise a
    list payload's ``total`` is used; otherwise a generic pointer.

    The floor per the design doc (§4/§10) is "don't degrade to
    'incapable clients see nothing'": this summary is the only content a
    non-capable client sees when the channel is misconfigured to
    ``structured``, so the ``markdown`` argument to ``render_result`` is
    intentionally ignored in this mode.
    """
    if summary:
        return summary
    total = data.get("total")
    if isinstance(total, int):
        return f"（结构化结果共 {total} 条，详见 structuredContent）"
    return "（结构化结果详见 structuredContent）"


def text_result(markdown: str) -> CallToolResult:
    """Build a content-only ``CallToolResult`` carrying markdown text.

    For narrative tools (§5) — whose output is prose with no useful
    structured form — and for error/missing-data paths across all tools.
    The structured payload axis simply does not apply: ``structuredContent``
    is always ``None`` regardless of ``OUTPUT_CHANNEL``, and the markdown is
    the whole result.

    Use this instead of ``render_result(None, …)`` for narrative tools:
    "narrative tool has no structure" is the *normal* success case here, not
    a "data missing" condition, so the dedicated helper keeps the semantics
    honest (design doc §11).
    """
    return CallToolResult(
        content=[TextContent(type="text", text=markdown)],
        structuredContent=None,
        isError=False,
    )


def render_image_result(
    markdown: str,
    image_data: str,
    image_mimetype: str,
    data: dict[str, Any] | None = None,
    channel: OutputChannel | None = None,
    summary: str | None = None,
) -> CallToolResult:
    """Build a ``CallToolResult`` carrying text + one image, shaped by the channel.

    The image always rides in ``content`` as an ``ImageContent`` block — MCP
    does not allow images inside ``structuredContent``. The ``data`` payload
    (image metadata) travels in ``structuredContent`` per the same channel
    rules as :func:`render_result`:

    - ``content``   → markdown + image; no structuredContent.
    - ``structured`` → summary text + image + structuredContent.
    - ``both``      → markdown + image + structuredContent.

    When ``data is None`` the image is still returned with the markdown text
    and no structuredContent (rare; prefer passing metadata for ``get``).
    """
    if channel is None:
        channel = get_output_channel()
    image = ImageContent(type="image", data=image_data, mimeType=image_mimetype)
    if data is None or channel == "content":
        return CallToolResult(
            content=[TextContent(type="text", text=markdown), image],
            structuredContent=None,
            isError=False,
        )
    if channel == "both":
        return CallToolResult(
            content=[TextContent(type="text", text=markdown), image],
            structuredContent=data,
            isError=False,
        )
    # structured: summary text + image, plus structured payload.
    return CallToolResult(
        content=[TextContent(type="text", text=_summarize(data, summary)), image],
        structuredContent=data,
        isError=False,
    )
