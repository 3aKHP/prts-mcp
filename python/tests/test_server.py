"""
Unit tests for prts_mcp.server module-level helpers (no subprocess).

Covers SESSION_IDLE_TIMEOUT_MS parsing and its wiring into the MCP SDK
session manager. HTTP end-to-end behavior lives in test_e2e_http.py.
"""
from __future__ import annotations


def test_session_idle_timeout_parsing(monkeypatch):
    """SESSION_IDLE_TIMEOUT_MS parsing mirrors the TypeScript semantics."""
    from prts_mcp.server import _session_idle_timeout_seconds

    monkeypatch.delenv("SESSION_IDLE_TIMEOUT_MS", raising=False)
    assert _session_idle_timeout_seconds() == 24 * 60 * 60  # unset → 24h default

    for raw, expected in [("2000", 2.0), (" 2000 ", 2.0), ("1e3", 1.0), ("250.5", 0.2505)]:
        monkeypatch.setenv("SESSION_IDLE_TIMEOUT_MS", raw)
        assert _session_idle_timeout_seconds() == expected

    # Invalid or <= 0 disables — including spellings where Python float() and
    # TypeScript Number() diverge (hex/binary/octal literals, PEP 515
    # underscores); parity is pinned by ts/tests/config.test.ts.
    for bad in ("0", "-5", "abc", "", "inf", "1e400", "nan", "0x10", "0b101", "0o17", "1_000"):
        monkeypatch.setenv("SESSION_IDLE_TIMEOUT_MS", bad)
        assert _session_idle_timeout_seconds() is None, f"{bad!r} should disable eviction"


def test_session_idle_timeout_wiring(monkeypatch):
    """_build_http_app assigns the resolved timeout — None included — to the
    SDK session manager instead of relying on the SDK default staying None."""
    import prts_mcp.server as server

    monkeypatch.setenv("SESSION_IDLE_TIMEOUT_MS", "2000")
    server._build_http_app()
    assert server.mcp.session_manager.session_idle_timeout == 2.0

    monkeypatch.setenv("SESSION_IDLE_TIMEOUT_MS", "0")
    server._build_http_app()
    assert server.mcp.session_manager.session_idle_timeout is None

    monkeypatch.delenv("SESSION_IDLE_TIMEOUT_MS", raising=False)
    server._build_http_app()
    assert server.mcp.session_manager.session_idle_timeout == 24 * 60 * 60
