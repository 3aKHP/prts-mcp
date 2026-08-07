from __future__ import annotations

from prts_mcp import startup_sync


class FakeStopEvent:
    def __init__(self, stop_after: int):
        self.stop_after = stop_after
        self.waits: list[float] = []

    def wait(self, delay: float) -> bool:
        self.waits.append(delay)
        return len(self.waits) >= self.stop_after


def test_auto_sync_interval_defaults_and_can_be_disabled(monkeypatch):
    monkeypatch.delenv("PRTS_AUTO_SYNC_INTERVAL_SECONDS", raising=False)
    assert startup_sync._auto_sync_interval_seconds() == 3600

    monkeypatch.setenv("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "0")
    assert startup_sync._auto_sync_interval_seconds() == 0


def test_auto_sync_interval_rejects_unsafe_values(monkeypatch):
    for value in ("", "   ", "59", "-1", "604801", "invalid", "1.5", "1e3"):
        monkeypatch.setenv("PRTS_AUTO_SYNC_INTERVAL_SECONDS", value)
        assert startup_sync._auto_sync_interval_seconds() == 3600

    monkeypatch.setenv("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "604800")
    assert startup_sync._auto_sync_interval_seconds() == 604800


def test_auto_sync_runs_periodically_and_forces_later_checks(monkeypatch):
    monkeypatch.setenv("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "60")
    force_checks: list[bool] = []
    monkeypatch.setattr(
        startup_sync,
        "_run_startup_sync",
        lambda *, force_check=False: force_checks.append(force_check),
    )
    stop = FakeStopEvent(stop_after=2)

    startup_sync._run_auto_sync(stop)  # type: ignore[arg-type]

    assert force_checks == [False, True]
    assert stop.waits == [60, 60]


def test_disabled_periodic_sync_still_runs_startup_sync(monkeypatch):
    monkeypatch.setenv("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "0")
    force_checks: list[bool] = []
    monkeypatch.setattr(
        startup_sync,
        "_run_startup_sync",
        lambda *, force_check=False: force_checks.append(force_check),
    )
    stop = FakeStopEvent(stop_after=1)

    startup_sync._run_auto_sync(stop)  # type: ignore[arg-type]

    assert force_checks == [False]
    assert stop.waits == []


def test_auto_sync_continues_after_unexpected_cycle_error(monkeypatch):
    monkeypatch.setenv("PRTS_AUTO_SYNC_INTERVAL_SECONDS", "60")
    force_checks: list[bool] = []

    def run_sync(*, force_check=False):
        force_checks.append(force_check)
        if not force_check:
            raise RuntimeError("boom")

    monkeypatch.setattr(startup_sync, "_run_startup_sync", run_sync)
    stop = FakeStopEvent(stop_after=2)

    startup_sync._run_auto_sync(stop)  # type: ignore[arg-type]

    assert force_checks == [False, True]


def test_gamedata_pair_retry_ignores_generation_mismatch():
    """#102: divergent commit_shas alone must not trigger dense retries."""
    assert startup_sync._gamedata_pair_needs_retry("up_to_date", "up_to_date") is False
    assert startup_sync._gamedata_pair_needs_retry("updated", "up_to_date") is False
    assert startup_sync._gamedata_pair_needs_retry("up_to_date", "updated") is False


def test_gamedata_pair_retries_on_no_data_or_offline_fallback():
    assert startup_sync._gamedata_pair_needs_retry("no_data", "up_to_date") is True
    assert startup_sync._gamedata_pair_needs_retry("up_to_date", "offline_fallback") is True
    assert startup_sync._gamedata_pair_needs_retry("offline_fallback", "no_data") is True
