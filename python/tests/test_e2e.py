"""
E2E test for the Python MCP server (stdio JSON-RPC).

Spawns ``python -m prts_mcp`` as a subprocess and communicates via
stdin/stdout with JSON-RPC messages.  Tests that can run without
network or full data:

  1. MCP initialize handshake
  2. tools/list — all tools registered
  3. Operator tools (bundled fixture data)
  4. Graceful errors for unavailable data
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from importlib.metadata import version as _pkg_version
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

GAMEDATA_PATH = Path(__file__).resolve().parents[2] / "data" / "gamedata"
GAMEDATA_PATH = GAMEDATA_PATH.resolve()

# Ensure data exists so the test is meaningful.
_op_table = GAMEDATA_PATH / "zh_CN" / "gamedata" / "excel" / "character_table.json"
_has_operator_data = _op_table.is_file()

_run_prts_api = os.environ.get("E2E_PRTS_API") == "1"
_expected_version = _pkg_version("prts-mcp")
_MODERN_VERSION = "2026-07-28"


def _send(proc: subprocess.Popen, msg: dict) -> None:
    """Write a JSON-RPC message to the server's stdin."""
    assert proc.stdin is not None
    data = (json.dumps(msg, ensure_ascii=False) + "\n").encode()
    proc.stdin.write(data)
    # flush() can fail on Windows pipes; the write itself is sufficient
    # because PIPE buffers are line-buffered by default in Python.
    try:
        proc.stdin.flush()
    except OSError:
        pass


def _recv(proc: subprocess.Popen, timeout: float = 10.0) -> dict:
    """Read one JSON-RPC message from the server's stdout."""
    assert proc.stdout is not None
    deadline = time.monotonic() + timeout
    line = None
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if line:
            break
        time.sleep(0.01)
    if not line:
        raise TimeoutError("no response from server")
    try:
        return json.loads(line)  # type: ignore[no-any-return]
    except json.JSONDecodeError:
        # Some MCP messages may be non-JSON; return raw
        return {"_raw": line.decode().strip()}


def _tool_call(name: str, args: dict, id: int) -> dict:
    return {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {"name": name, "arguments": args},
        "id": id,
    }


def _modern_message(method: str, params: dict, id: int) -> dict:
    """Build a modern SDK v2 stdio request that needs no initialize step."""
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
        "id": id,
    }


def _call_result_text(proc: subprocess.Popen, name: str, args: dict, id: int) -> str:
    _send(proc, _tool_call(name, args, id))
    resp = _recv(proc)
    content = resp.get("result", {}).get("content", [])
    return content[0].get("text", "") if content else ""


def _data_unavailable(text: str) -> bool:
    return "暂不可用" in text or "未就绪" in text or "仍在进行中" in text


# ---------------------------------------------------------------------------
# Fixture: start the server once, share across tests in this module
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def server():
    """Start the MCP server subprocess and return a handle for sending/receiving."""
    env = os.environ.copy()
    env["GAMEDATA_PATH"] = str(GAMEDATA_PATH)
    env["GITHUB_MIRRORS"] = ""
    env["IMAGES_ENABLED"] = "true"
    # Prevent auto-sync interfering with the test
    env.setdefault("STORYJSON_PATH", str(GAMEDATA_PATH / "does-not-exist.zip"))

    # Ensure the package is importable
    python_src = Path(__file__).resolve().parents[1] / "src"
    env["PYTHONPATH"] = str(python_src)

    proc = subprocess.Popen(
        [sys.executable, "-c", "from prts_mcp.server import main; main()"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    # Give the server a moment to start background threads
    time.sleep(1.0)

    # Check server didn't crash on startup
    if proc.poll() is not None:
        stderr_text = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        raise RuntimeError(f"Server exited with code {proc.returncode}: {stderr_text[-500:]}")

    yield proc

    # Cleanup
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

EXPECTED_TOOLS = {
    "search_prts", "prts_page",
    "get_operator_archives", "get_operator_voicelines", "get_operator_basic_info",
    "list_enemies", "get_enemy_info",
    "get_stage_enemies", "get_enemy_appearances",
    "list_stages", "get_stage_info",
    "list_items", "get_item_info",
    "list_story_events", "list_stories", "read_story", "read_activity",
    "search", "search_stories",
    "get_story_summary",
    "get_operator_memoirs",
    "find_character_appearances", "find_speakers_in",
    "operator_artwork",
}


def test_initialize_handshake(server: subprocess.Popen) -> None:
    _send(server, {
        "jsonrpc": "2.0",
        "method": "initialize",
        "id": 1,
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "pytest-e2e", "version": "0"},
        },
    })
    resp = _recv(server)
    assert resp.get("id") == 1, f"Expected initialize response, got: {resp}"
    result = resp.get("result", {})
    assert "serverInfo" in result or "protocolVersion" in result, f"Missing server info: {resp}"
    server_info = result.get("serverInfo", {})
    assert server_info.get("version") == _expected_version, \
        f"Expected product version {_expected_version}, got {server_info.get('version')}"

    # Send initialized notification
    _send(server, {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})


def test_tools_list(server: subprocess.Popen) -> None:
    _send(server, {"jsonrpc": "2.0", "method": "tools/list", "id": 2, "params": {}})
    resp = _recv(server)
    assert resp.get("id") == 2, f"Expected tools/list response, got: {resp}"
    tools = resp["result"]["tools"]
    names = {t["name"] for t in tools}

    assert len(names) == 24, f"Expected 24 tools, got {len(names)}: {sorted(names)}"
    for name in EXPECTED_TOOLS:
        assert name in names, f"Missing tool: {name}"


def test_modern_stdio_discovery_list_and_call_need_no_initialize() -> None:
    """A new stdio connection selects the modern era from its first request."""
    env = os.environ.copy()
    env["GAMEDATA_PATH"] = str(GAMEDATA_PATH)
    env["GITHUB_MIRRORS"] = ""
    env.setdefault("STORYJSON_PATH", str(GAMEDATA_PATH / "does-not-exist.zip"))
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    proc = subprocess.Popen(
        [sys.executable, "-c", "from prts_mcp.server import main; main()"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        _send(proc, _modern_message("server/discover", {}, 100))
        discover = _recv(proc)
        assert discover.get("id") == 100
        assert discover.get("result")

        _send(proc, _modern_message("tools/list", {}, 101))
        listing = _recv(proc)
        assert listing.get("id") == 101
        names = {tool["name"] for tool in listing["result"]["tools"]}
        assert "get_operator_basic_info" in names

        if not _has_operator_data:
            pytest.skip("No bundled operator data")
        _send(
            proc,
            _modern_message(
                "tools/call",
                {"name": "get_operator_basic_info", "arguments": {"name": "阿米娅"}},
                102,
            ),
        )
        call = _recv(proc)
        assert call.get("id") == 102
        assert "阿米娅" in call["result"]["content"][0]["text"]
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


@pytest.mark.skipif(not _has_operator_data, reason="No bundled operator data")
def test_operator_basic_info_amiya(server: subprocess.Popen) -> None:
    text = _call_result_text(server, "get_operator_basic_info", {"name": "阿米娅"}, 3)
    assert "5★" in text, f"阿米娅 should be 5★: {text.split(chr(10))}"


@pytest.mark.skipif(not _has_operator_data, reason="No bundled operator data")
def test_operator_basic_info_senye(server: subprocess.Popen) -> None:
    text = _call_result_text(server, "get_operator_basic_info", {"name": "森蚺"}, 4)
    assert "6★" in text, f"森蚺 should be 6★: {text.split(chr(10))}"


@pytest.mark.skipif(not _has_operator_data, reason="No bundled operator data")
def test_operator_archives(server: subprocess.Popen) -> None:
    text = _call_result_text(server, "get_operator_archives", {"name": "阿米娅"}, 5)
    assert "阿米娅" in text and "干员档案" in text


@pytest.mark.skipif(not _has_operator_data, reason="No bundled operator data")
def test_operator_voicelines(server: subprocess.Popen) -> None:
    text = _call_result_text(server, "get_operator_voicelines", {"name": "阿米娅"}, 6)
    assert "语音记录" in text and "阿米娅" in text


@pytest.mark.skipif(not _has_operator_data, reason="No bundled operator data")
def test_search(server: subprocess.Popen) -> None:
    text = _call_result_text(server, "search", {"scope": "operators", "pattern": "法术伤害", "max_results": 3}, 7)
    assert "法术伤害" in text


def test_list_enemies_graceful(server: subprocess.Popen) -> None:
    text = _call_result_text(server, "list_enemies", {"limit": 5}, 8)
    assert "敌人图鉴" in text or _data_unavailable(text), f"unexpected: {text[:120]}"


def test_list_story_events_graceful(server: subprocess.Popen) -> None:
    text = _call_result_text(server, "list_story_events", {}, 9)
    assert "[MAINLINE]" in text or "[ACTIVITY]" in text or _data_unavailable(text), \
        f"unexpected: {text[:120]}"


@pytest.mark.skipif(not _run_prts_api, reason="E2E_PRTS_API not set")
def test_search_prts(server: subprocess.Popen) -> None:
    text = _call_result_text(server, "search_prts", {"query": "阿米娅", "limit": 3}, 20)
    assert "阿米娅" in text and "匹配" in text


@pytest.mark.skipif(not _run_prts_api, reason="E2E_PRTS_API not set")
def test_prts_page_sections(server: subprocess.Popen) -> None:
    text = _call_result_text(server, "prts_page", {"page_title": "阿米娅", "action": "sections"}, 21)
    assert "[" in text and "] L" in text
