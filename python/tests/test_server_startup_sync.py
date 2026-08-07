from __future__ import annotations

import sys
import types


class _FakeMcpServer:
    def __init__(self) -> None:
        self.version = "0.0.0"


class FakeFastMCP:
    def __init__(self, _name: str):
        self._mcp_server = _FakeMcpServer()

    def tool(self):
        return lambda func: func

    def run(self) -> None:
        pass


def _install_server_import_stubs() -> None:
    mcp_module = types.ModuleType("mcp")
    mcp_server_module = types.ModuleType("mcp.server")
    fastmcp_module = types.ModuleType("mcp.server.fastmcp")
    pydantic_module = types.ModuleType("pydantic")
    fastmcp_module.FastMCP = FakeFastMCP
    pydantic_module.Field = lambda *args, **kwargs: kwargs.get("default")
    mcp_types_module = types.ModuleType("mcp.types")
    for _name in ("CallToolResult", "ImageContent", "TextContent"):
        setattr(mcp_types_module, _name, type(_name, (), {}))
    sys.modules.setdefault("mcp", mcp_module)
    sys.modules.setdefault("mcp.server", mcp_server_module)
    sys.modules.setdefault("mcp.server.fastmcp", fastmcp_module)
    sys.modules.setdefault("mcp.types", mcp_types_module)
    sys.modules.setdefault("pydantic", pydantic_module)


_install_server_import_stubs()

from prts_mcp import server


class FakeTimer:
    instances: list["FakeTimer"] = []

    def __init__(self, delay: int, callback):
        self.delay = delay
        self.callback = callback
        self.daemon = False
        self.started = False
        FakeTimer.instances.append(self)

    def start(self) -> None:
        self.started = True


def test_sync_needs_retry_only_for_offline_or_empty_data():
    assert server._sync_needs_retry("offline_fallback")
    assert server._sync_needs_retry("no_data")
    assert not server._sync_needs_retry("updated")
    assert not server._sync_needs_retry("up_to_date")


def test_schedule_sync_retry_uses_daemon_timer(monkeypatch):
    FakeTimer.instances.clear()
    monkeypatch.setattr(server.threading, "Timer", FakeTimer)

    server._schedule_sync_retry("Storyjson", lambda: False)

    assert len(FakeTimer.instances) == 1
    timer = FakeTimer.instances[0]
    assert timer.delay == 30
    assert timer.daemon is True
    assert timer.started is True


def test_schedule_sync_retry_advances_until_success(monkeypatch):
    FakeTimer.instances.clear()
    monkeypatch.setattr(server.threading, "Timer", FakeTimer)

    attempts = iter([True, False])

    server._schedule_sync_retry("Gamedata", lambda: next(attempts))
    FakeTimer.instances[0].callback()

    assert [timer.delay for timer in FakeTimer.instances] == [30, 120]
    FakeTimer.instances[1].callback()
    assert [timer.delay for timer in FakeTimer.instances] == [30, 120]


def test_schedule_sync_retry_stops_after_configured_attempts(monkeypatch):
    FakeTimer.instances.clear()
    monkeypatch.setattr(server.threading, "Timer", FakeTimer)

    server._schedule_sync_retry("Storyjson", lambda: True)
    index = 0
    while index < len(FakeTimer.instances):
        FakeTimer.instances[index].callback()
        index += 1

    assert [timer.delay for timer in FakeTimer.instances] == [30, 120, 600]


def test_schedule_sync_retry_does_not_advance_attempt_when_overlapping(monkeypatch):
    FakeTimer.instances.clear()
    monkeypatch.setattr(server.threading, "Timer", FakeTimer)

    label = "unit-test-overlap"
    with server._SYNC_LOCKS_GUARD:
        server._SYNC_LOCKS.pop(label, None)
        lock = server._SYNC_LOCKS.setdefault(label, server.threading.Lock())
        lock.acquire()

    try:
        server._schedule_sync_retry(label, lambda: True)
        FakeTimer.instances[0].callback()
    finally:
        lock.release()
        with server._SYNC_LOCKS_GUARD:
            server._SYNC_LOCKS.pop(label, None)

    assert [timer.delay for timer in FakeTimer.instances] == [30, 30]


def test_run_initial_sync_treats_unexpected_exceptions_as_retry_needed():
    def raises() -> bool:
        raise RuntimeError("boom")

    assert server._run_initial_sync("Gamedata", raises) is True


def test_run_initial_sync_returns_sync_func_value_on_success():
    assert server._run_initial_sync("Gamedata", lambda: False) is False
    assert server._run_initial_sync("Storyjson", lambda: True) is True


def test_single_flight_sync_skips_overlapping_attempt(monkeypatch):
    label = "unit-test-sync"
    with server._SYNC_LOCKS_GUARD:
        server._SYNC_LOCKS.pop(label, None)

    calls = 0

    def sync_func() -> bool:
        nonlocal calls
        calls += 1
        lock = server._SYNC_LOCKS[label]
        assert lock.locked()
        assert server._single_flight_sync(label, lambda: False) == "skipped"
        return False

    assert server._single_flight_sync(label, sync_func) == "done"
    assert calls == 1

    with server._SYNC_LOCKS_GUARD:
        server._SYNC_LOCKS.pop(label, None)
