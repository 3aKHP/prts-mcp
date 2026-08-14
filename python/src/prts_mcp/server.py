"""PRTS-MCP server entry point.

Creates the MCPServer instance, delegates tool registration to focused
modules (tools_prts / tools_gamedata / tools_story), and starts the
background data-sync daemon before running the MCP transport.

Supports two transports selected by the ``PRTS_TRANSPORT`` env var:

- ``stdio`` (default) — MCP stdio, for local Claude Desktop / Code.
- ``http`` — Streamable HTTP via Starlette + uvicorn, for self-hosted
  remote access. Mirrors the TypeScript implementation's HTTP surface
  (``/mcp`` endpoint, ``/health`` probe). output_channel is process-level
  (env-only) on Python HTTP; see ``_build_http_app`` for the limitation.

Sync orchestration lives in startup_sync; its symbols are re-exported here
for backward compatibility with tests that access them via ``server.*``.
"""
from __future__ import annotations

import logging
import os
import sys
import threading
from secrets import compare_digest
from importlib.metadata import PackageNotFoundError, version as _pkg_version

from mcp.server import MCPServer

# Re-export sync orchestration symbols for backward compatibility
# (tests access these via server._sync_needs_retry etc.)
from prts_mcp.startup_sync import (
    _SYNC_LOCKS,
    _SYNC_LOCKS_GUARD,
    _run_auto_sync,
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

mcp = MCPServer("PRTS_Wiki_Assistant")
try:
    mcp._lowlevel_server.version = _pkg_version("prts-mcp")
except PackageNotFoundError:
    mcp._lowlevel_server.version = "0.0.0"


def _register_tools() -> None:
    """Register MCP tools via the focused tool modules."""
    from prts_mcp.config import Config
    from prts_mcp.tools_prts import register_prts_tools
    from prts_mcp.tools_gamedata import register_gamedata_tools
    from prts_mcp.tools_story import register_story_tools

    register_prts_tools(mcp)
    register_gamedata_tools(mcp)
    register_story_tools(mcp)

    # operator_artwork is registered only when IMAGES_ENABLED=true.
    if Config.load().images_enabled:
        from prts_mcp.tools_artwork import register_artwork_tools

        register_artwork_tools(mcp)


_register_tools()


# ---------------------------------------------------------------------------
# Transport selection
# ---------------------------------------------------------------------------


def _build_http_app():
    """Build the Starlette app for the Streamable HTTP transport.

    Wraps ``mcp.streamable_http_app()`` with a ``/health`` JSON probe.

    Note on output_channel: per-request resolution (query string / header)
    is **not supported** on the Python HTTP transport. FastMCP's Streamable
    HTTP uses a stateful session model — the session task is created at
    ``initialize`` and tools execute inside that long-lived task, so a
    per-request contextvar set in middleware is invisible to tool code.
    The output channel is therefore process-level (read from
    ``PRTS_OUTPUT_CHANNEL`` env) on Python HTTP, matching Python stdio.
    The TypeScript HTTP transport does support per-request resolution
    because it resolves the channel at session-creation time and injects
    it into ``createMcpServer(channel)``.
    """
    from starlette.responses import JSONResponse, Response
    from starlette.routing import Route

    app = mcp.streamable_http_app()

    async def health(_request):
        return JSONResponse({"status": "ok"})

    def debug_authorized(request) -> bool:
        token = os.environ.get("PRTS_DEBUG_TOKEN")
        authorization = request.headers.get("authorization")
        expected = f"Bearer {token}" if token else None
        return bool(expected and authorization and compare_digest(authorization, expected))

    async def debug_cache(request):
        if not debug_authorized(request):
            return Response(status_code=404)
        # The data-module imports populate the dataset registry (registration
        # side effect). The projection below uses an EXPLICIT fixed key order —
        # registry insertion order is transitive-import-order-driven and must
        # not leak into the output. story_search and artwork_mediawiki are not
        # on the contract yet and are read directly. Mirrors ts cacheStats.ts.
        from prts_mcp.data import (  # noqa: F401
            building,
            enemy,
            images,
            item,
            operator,
            search,
            stage,
            stage_enemy,
        )
        from prts_mcp.data.artwork_mediawiki import cache_stats as _am
        from prts_mcp.data.story_search import cache_stats as _ss
        from prts_mcp.data.dataset_access import dataset_registry

        registry = dataset_registry()
        projection = {
            name: registry[name].stats()
            for name in (
                "operator", "enemy", "stage", "stage_enemy", "item", "search",
                "building",
            )
        }
        return JSONResponse({
            **projection,
            "story_search": _ss(),
            "images": registry["images"].stats(),
            "artwork_mediawiki": _am(),
        })

    # Prepend /health and /debug/cache so they are matched before any catch-all.
    app.router.routes.insert(0, Route("/health", health))
    app.router.routes.insert(0, Route("/debug/cache", debug_cache))

    return app


def main() -> None:
    transport = os.environ.get("PRTS_TRANSPORT", "stdio").strip().lower()
    # Start background data sync regardless of transport.
    t = threading.Thread(target=_run_auto_sync, daemon=True, name="prts-sync")
    t.start()

    if transport == "http":
        import uvicorn

        host = os.environ.get("HOST", "0.0.0.0")
        port_raw = os.environ.get("PORT", "3000")
        try:
            port = int(port_raw)
        except ValueError:
            _logger.error("PORT must be numeric, got %r. Exiting.", port_raw)
            sys.exit(1)
        app = _build_http_app()
        _logger.info("PRTS-MCP Streamable HTTP listening on %s:%s (/mcp)", host, port)
        uvicorn.run(app, host=host, port=port, log_level="info")
    else:
        # stdio (default) — preserves 1.x/2.x behavior.
        mcp.run()


if __name__ == "__main__":
    main()
