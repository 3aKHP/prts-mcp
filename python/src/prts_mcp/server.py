"""PRTS-MCP server entry point.

Creates the FastMCP instance, delegates tool registration to focused
modules (tools_prts / tools_gamedata / tools_story), and starts the
background data-sync daemon before running the MCP stdio transport.

Sync orchestration lives in startup_sync; its symbols are re-exported here
for backward compatibility with tests that access them via ``server.*``.
"""
from __future__ import annotations

import logging
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
    """Register all 30 MCP tools via the focused tool modules."""
    from prts_mcp.tools_prts import register_prts_tools
    from prts_mcp.tools_gamedata import register_gamedata_tools
    from prts_mcp.tools_story import register_story_tools

    register_prts_tools(mcp)
    register_gamedata_tools(mcp)
    register_story_tools(mcp)


_register_tools()


def main() -> None:
    t = threading.Thread(target=_run_startup_sync, daemon=True, name="prts-sync")
    t.start()
    mcp.run()


if __name__ == "__main__":
    main()
