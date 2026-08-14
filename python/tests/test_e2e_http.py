"""
E2E test for the Python MCP server (Streamable HTTP transport).

Spawns ``PRTS_TRANSPORT=http python -m prts_mcp.server`` as a subprocess
and communicates via HTTP POST to /mcp. Mirrors the TypeScript e2e.test.ts
pattern. Tests that run without network or full data:

  1. /health probe
  2. MCP initialize handshake + session id
  3. tools/list — all tools registered
  4. output_channel env-only behavior (query string ignored)
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from importlib.metadata import PackageNotFoundError, version as _pkg_version
from pathlib import Path

import httpx
import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

GAMEDATA_PATH = Path(__file__).resolve().parents[2] / "data" / "gamedata"
GAMEDATA_PATH = GAMEDATA_PATH.resolve()
_DEBUG_HEADERS = {"Authorization": "Bearer test-debug-token"}


def _free_port() -> int:
    """Return a free TCP port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_health(origin: str, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{origin}/health", timeout=1.0)
            if r.status_code == 200 and r.json().get("status") == "ok":
                return
        except Exception as e:  # noqa: BLE001
            last_err = e
        time.sleep(0.2)
    raise TimeoutError(f"server did not become healthy: {last_err}")


def _parse_sse(text: str) -> dict:
    """Extract the JSON payload from an SSE ``data:`` line."""
    for line in text.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    raise ValueError(f"no data line in SSE response: {text[:200]}")


def _mcp_post(
    origin: str,
    body: dict,
    session_id: str | None = None,
    extra_headers: dict | None = None,
    query: str | None = None,
) -> tuple[int, dict | None, str | None]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    if extra_headers:
        headers.update(extra_headers)
    url = f"{origin}/mcp"
    if query:
        url += f"?{query}"
    r = httpx.post(url, json=body, headers=headers, timeout=10.0)
    sid = r.headers.get("mcp-session-id")
    payload: dict | None = None
    if r.text:
        try:
            payload = _parse_sse(r.text)
        except (ValueError, json.JSONDecodeError):
            payload = None
    return r.status_code, payload, sid


_MODERN_VERSION = "2026-07-28"
try:
    _EXPECTED_VERSION = _pkg_version("prts-mcp")
except PackageNotFoundError:
    _EXPECTED_VERSION = "0.0.0"


def _modern_body(method: str, params: dict, request_id: int) -> dict:
    """Build the SDK v2 stateless-request envelope for the modern era."""
    return {
        "jsonrpc": "2.0",
        "method": method,
        "params": {
            **params,
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": _MODERN_VERSION,
                "io.modelcontextprotocol/clientInfo": {
                    "name": "pytest-modern",
                    "version": "1.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
        "id": request_id,
    }


def _modern_post(
    origin: str, method: str, params: dict, request_id: int
) -> tuple[int, dict | None, str | None]:
    """POST one strict modern request and decode JSON or SSE output."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": _MODERN_VERSION,
        "Mcp-Method": method,
    }
    if method == "tools/call":
        headers["Mcp-Name"] = str(params["name"])
    response = httpx.post(
        f"{origin}/mcp",
        json=_modern_body(method, params, request_id),
        headers=headers,
        timeout=10.0,
    )
    payload: dict | None = None
    if response.text:
        try:
            payload = _parse_sse(response.text)
        except (ValueError, json.JSONDecodeError):
            try:
                payload = response.json()
            except json.JSONDecodeError:
                pass
    return response.status_code, payload, response.headers.get("mcp-session-id")


# ---------------------------------------------------------------------------
# Server factory + fixtures
# ---------------------------------------------------------------------------


def _start_server(extra_env: dict | None = None) -> dict:
    """Start an HTTP server with the given env overrides; return origin/proc."""
    port = _free_port()
    origin = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    env["PRTS_TRANSPORT"] = "http"
    env["PORT"] = str(port)
    env["HOST"] = "127.0.0.1"
    env["GAMEDATA_PATH"] = str(GAMEDATA_PATH)
    env["GITHUB_MIRRORS"] = ""
    env["PRTS_DEBUG_TOKEN"] = "test-debug-token"
    env.setdefault("STORYJSON_PATH", str(GAMEDATA_PATH / "does-not-exist.zip"))
    if extra_env:
        env.update(extra_env)

    python_src = Path(__file__).resolve().parents[1] / "src"
    env["PYTHONPATH"] = str(python_src)

    proc = subprocess.Popen(
        [sys.executable, "-m", "prts_mcp.server"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    _wait_for_health(origin)
    return {"origin": origin, "proc": proc}


@pytest.fixture(scope="module")
def server():
    """Default server (env-default output_channel = content)."""
    handle = _start_server()
    try:
        yield handle
    finally:
        handle["proc"].terminate()
        try:
            handle["proc"].wait(timeout=5)
        except subprocess.TimeoutExpired:
            handle["proc"].kill()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_health(server):
    r = httpx.get(f"{server['origin']}/health", timeout=5.0)
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_debug_cache(server):
    unauthenticated = httpx.get(f"{server['origin']}/debug/cache", timeout=5.0)
    assert unauthenticated.status_code == 404
    r = httpx.get(f"{server['origin']}/debug/cache", headers=_DEBUG_HEADERS, timeout=5.0)
    assert r.status_code == 200
    data = r.json()
    expected_modules = {
        "operator", "enemy", "stage", "stage_enemy", "item",
        "search", "story_search", "images", "artwork_mediawiki", "building",
    }
    assert set(data.keys()) == expected_modules
    for module_name, caches in data.items():
        assert isinstance(caches, dict)
        for cache_name, stat in caches.items():
            assert "loaded" in stat and isinstance(stat["loaded"], bool)
            assert "count" in stat and isinstance(stat["count"], int)
    # artwork_mediawiki.image_cache includes bytes
    am = data["artwork_mediawiki"]["image_cache"]
    assert "bytes" in am and isinstance(am["bytes"], int)


def test_initialize_and_tools_list(server):
    origin = server["origin"]
    status, payload, sid = _mcp_post(
        origin,
        {
            "jsonrpc": "2.0",
            "method": "initialize",
            "id": 1,
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "pytest", "version": "0"},
            },
        },
    )
    assert status == 200
    assert payload is not None
    assert payload["result"]["serverInfo"]["name"] == "PRTS_Wiki_Assistant"
    assert sid is not None

    # Send initialized notification
    _mcp_post(
        origin,
        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        session_id=sid,
    )

    # tools/list
    status, payload, _ = _mcp_post(
        origin,
        {"jsonrpc": "2.0", "method": "tools/list", "id": 2, "params": {}},
        session_id=sid,
    )
    assert status == 200
    assert payload is not None
    names = {t["name"] for t in payload["result"]["tools"]}
    # Spot-check a few tools across domains.
    for required in [
        "search_prts",
        "get_operator_archives",
        "list_story_events",
        "read_story",
        "list_enemies",
    ]:
        assert required in names, f"missing tool {required}; got {sorted(names)[:10]}..."


def test_modern_http_requests_are_stateless_and_strict(server):
    """SDK v2 serves modern discovery/list/call without legacy sessions."""
    origin = server["origin"]

    status, payload, sid = _modern_post(origin, "server/discover", {}, 100)
    assert status == 200
    assert sid is None
    assert payload is not None and payload.get("result")
    discover_result = payload["result"]
    assert _MODERN_VERSION in discover_result["supportedVersions"]
    server_info = discover_result["_meta"]["io.modelcontextprotocol/serverInfo"]
    assert server_info["name"] == "PRTS_Wiki_Assistant"
    assert server_info["version"] == _EXPECTED_VERSION

    status, payload, sid = _modern_post(origin, "tools/list", {}, 101)
    assert status == 200
    assert sid is None
    assert payload is not None
    names = {tool["name"] for tool in payload["result"]["tools"]}
    assert "get_operator_basic_info" in names

    if not (GAMEDATA_PATH / "zh_CN/gamedata/excel/character_table.json").is_file():
        pytest.skip("GameData character_table not available; cannot verify modern tool call")
    status, payload, sid = _modern_post(
        origin,
        "tools/call",
        {"name": "get_operator_basic_info", "arguments": {"name": "阿米娅"}},
        102,
    )
    assert status == 200
    assert sid is None
    assert payload is not None
    assert "阿米娅" in payload["result"]["content"][0]["text"]

    malformed = httpx.post(
        f"{origin}/mcp",
        headers={
            "Content-Type": "application/json",
            "MCP-Protocol-Version": _MODERN_VERSION,
            "Mcp-Method": "tools/list",
        },
        json={"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 103},
        timeout=10.0,
    )
    assert malformed.status_code == 400
    assert malformed.headers.get("mcp-session-id") is None


def test_output_channel_env_governs_not_query():
    """Python HTTP output_channel is process-level (env), not per-request.

    Starts a server with PRTS_OUTPUT_CHANNEL=structured, then calls a
    structured tool (search) with ?output_channel=content in the query
    string. If query-string resolution worked, the response would be
    content-only (structuredContent null). Because the env governs and
    the query is ignored, structuredContent stays non-null — proving
    env-only behavior. Uses search(operators) which needs the
    character_table; skips if that data is absent or returns no results.
    """
    char_table = GAMEDATA_PATH / "zh_CN" / "gamedata" / "excel" / "character_table.json"
    if not char_table.is_file():
        pytest.skip("GameData character_table not available; cannot test structured tool")

    handle = _start_server(extra_env={"PRTS_OUTPUT_CHANNEL": "structured"})
    try:
        origin = handle["origin"]
        _, _, sid = _mcp_post(
            origin,
            {
                "jsonrpc": "2.0",
                "method": "initialize",
                "id": 1,
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "pytest", "version": "0"},
                },
            },
        )
        assert sid is not None
        _mcp_post(
            origin,
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
            session_id=sid,
        )

        # Call search (structured tool) with ?output_channel=content — the
        # query should be IGNORED; env=structured governs, so structuredContent
        # is non-null.
        status, payload, _ = _mcp_post(
            origin,
            {
                "jsonrpc": "2.0",
                "method": "tools/call",
                "id": 2,
                "params": {
                    "name": "search",
                    "arguments": {"scope": "operators", "pattern": "阿"},
                },
            },
            session_id=sid,
            query="output_channel=content",
        )
        assert status == 200
        assert payload is not None
        result = payload.get("result", {})
        # Guard against the data-unavailable error path: if search hit the
        # error/missing-data branch, structuredContent is null regardless of
        # channel (text_result is used), which would make the channel
        # assertion below meaningless. Verify data was actually returned first.
        content_text = ""
        if result.get("content"):
            content_text = result["content"][0].get("text", "")
        assert "暂不可用" not in content_text and "未就绪" not in content_text, (
            f"search returned a data-unavailable path; cannot verify channel "
            f"behavior. Response: {content_text[:120]}"
        )
        assert result.get("structuredContent") is not None, (
            "env PRTS_OUTPUT_CHANNEL=structured should govern; "
            "query ?output_channel=content must be ignored. "
            "If structuredContent is null, the query override leaked."
        )
    finally:
        handle["proc"].terminate()
        try:
            handle["proc"].wait(timeout=5)
        except subprocess.TimeoutExpired:
            handle["proc"].kill()
