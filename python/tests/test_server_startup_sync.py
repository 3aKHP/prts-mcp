from __future__ import annotations

import sys
import types


class FakeFastMCP:
    def __init__(self, _name: str):
        pass

    def tool(self):
        return lambda func: func

    def run(self) -> None:
        pass


def _install_server_import_stubs() -> None:
    mcp_module = types.ModuleType("mcp")
    mcp_server_module = types.ModuleType("mcp.server")
    fastmcp_module = types.ModuleType("mcp.server.fastmcp")
    fastmcp_module.FastMCP = FakeFastMCP
    sys.modules.setdefault("mcp", mcp_module)
    sys.modules.setdefault("mcp.server", mcp_server_module)
    sys.modules.setdefault("mcp.server.fastmcp", fastmcp_module)


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
