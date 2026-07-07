"""PRTS-MCP server entry point.

Creates the FastMCP instance, delegates tool registration to focused
modules (tools_prts / tools_gamedata / tools_story), and starts the
background data-sync daemon before running the MCP transport.

Supports two transports selected by the ``PRTS_TRANSPORT`` env var:

- ``stdio`` (default) — FastMCP stdio, for local Claude Desktop / Code.
- ``http`` — Streamable HTTP via Starlette + uvicorn, for self-hosted
  remote access. Mirrors the TypeScript implementation's HTTP surface
  (``/mcp`` endpoint, ``/health`` probe, per-request output_channel
  resolution from query string / header / env).

Sync orchestration lives in startup_sync; its symbols are re-exported here
for backward compatibility with tests that access them via ``server.*``.
"""
from __future__ import annotations

import logging
import os
import sys
import threading

from mcp.server.fastmcp import FastMCP

# Re-export sync orchestration symbols for backward compatibility
# (tests access these via server._sync_needs_retry etc.)
from prts_mcp.startup_sync import (
    _SYNC_LOCKS,
    _SYNC_LOCKS_GUARD,
    _run_startup_sync,
    _run_initial_sync,
    _schedule_sync_retry,
    _single_flight_sync,
    _sync_needs_retry,
)

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
_logger = logging.getLogger("prts_mcp.server")

mcp = FastMCP("PRTS_Wiki_Assistant")


def _register_tools() -> None:
    """Register MCP tools via the focused tool modules."""
    from prts_mcp.tools_prts import register_prts_tools
    from prts_mcp.tools_gamedata import register_gamedata_tools
    from prts_mcp.tools_story import register_story_tools

    register_prts_tools(mcp)
    register_gamedata_tools(mcp)
    register_story_tools(mcp)


_register_tools()


# ---------------------------------------------------------------------------
# Transport selection
# ---------------------------------------------------------------------------


def _resolve_http_channel(query_val: str | None, header_val: str | None) -> str:
    """Resolve output_channel for an HTTP request.

    Precedence matches the TypeScript ``resolveOutputChannel``:
    query string → header → env → default (content).
    """
    from prts_mcp.output import _parse_channel

    if query_val:
        return _parse_channel(query_val)
    if header_val:
        return _parse_channel(header_val)
    return _parse_channel(os.environ.get("PRTS_OUTPUT_CHANNEL"))


def _build_http_app():
    """Build the Starlette app for the Streamable HTTP transport.

    Wraps ``mcp.streamable_http_app()`` with:
    - a per-request output_channel middleware (query / header / env)
    - a ``/health`` JSON probe endpoint
    """
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    from prts_mcp.output import set_output_channel, reset_output_channel

    app = mcp.streamable_http_app()

    class OutputChannelMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            query_val = request.query_params.get("output_channel")
            # Starlette headers are case-insensitive
            header_val = request.headers.get("x-prts-output-channel")
            channel = _resolve_http_channel(query_val, header_val)
            token = set_output_channel(channel)
            try:
                response = await call_next(request)
            finally:
                reset_output_channel(token)
            return response

    app.add_middleware(OutputChannelMiddleware)

    async def health(_request):
        return JSONResponse({"status": "ok"})

    # Prepend /health so it is matched before any catch-all.
    app.router.routes.insert(0, Route("/health", health))

    return app


def main() -> None:
    transport = os.environ.get("PRTS_TRANSPORT", "stdio").strip().lower()
    # Start background data sync regardless of transport.
    t = threading.Thread(target=_run_startup_sync, daemon=True, name="prts-sync")
    t.start()

    if transport == "http":
        import uvicorn

        host = os.environ.get("HOST", "0.0.0.0")
        port = int(os.environ.get("PORT", "3000"))
        app = _build_http_app()
        _logger.info("PRTS-MCP Streamable HTTP listening on %s:%s (/mcp)", host, port)
        uvicorn.run(app, host=host, port=port, log_level="info")
    else:
        # stdio (default) — preserves 1.x/2.x behavior.
        mcp.run()


if __name__ == "__main__":
    main()
