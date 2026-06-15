"""Startup data sync orchestration and shared helpers.

Split from server.py. Owns the retry/backoff scheduling, single-flight
locking, and the cache-clearing cascade triggered when sync writes new data.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Callable, Literal

_logger = logging.getLogger("prts_mcp.server")

_SYNC_RETRY_DELAYS_SECONDS = (30, 120, 600)
# Startup sync labels are fixed domains; keep their locks for process lifetime
# so overlapping initial/retry attempts share the same mutex.
_SYNC_LOCKS: dict[str, threading.Lock] = {}
_SYNC_LOCKS_GUARD = threading.Lock()
_SyncRunResult = Literal["retry", "done", "skipped"]


def _require_story_zip(cfg) -> Path:  # type: ignore[no-untyped-def]
    """Return effective_storyjson_zip or raise RuntimeError.

    Takes a Config to avoid importing config at module load time (which would
    create a circular dependency during test stubbing).
    """
    if not cfg.has_story_data:
        raise RuntimeError(
            "剧情数据未就绪。请设置 STORYJSON_PATH 环境变量指向 zh_CN.zip，"
            "或等待服务器自动从 GitHub Release 下载完成后重试。"
        )
    return cfg.effective_storyjson_zip


def _sync_needs_retry(status: str) -> bool:
    return status in {"offline_fallback", "no_data"}


def _run_initial_sync(label: str, sync_func: Callable[[], bool]) -> bool:
    """Run the first sync attempt, treating unexpected exceptions as retry-needed."""
    try:
        return sync_func()
    except Exception as exc:  # noqa: BLE001
        _logger.exception("%s sync threw unexpectedly: %s", label, exc)
        return True


def _single_flight_sync(label: str, sync_func: Callable[[], bool]) -> _SyncRunResult:
    with _SYNC_LOCKS_GUARD:
        lock = _SYNC_LOCKS.setdefault(label, threading.Lock())
    if not lock.acquire(blocking=False):
        _logger.info("%s sync is already running; skipping overlapping attempt.", label)
        return "skipped"
    try:
        return "retry" if sync_func() else "done"
    finally:
        lock.release()


def _schedule_sync_retry(label: str, sync_func: Callable[[], bool], attempt: int = 0) -> None:
    delay = _SYNC_RETRY_DELAYS_SECONDS[attempt] if attempt < len(_SYNC_RETRY_DELAYS_SECONDS) else None
    if delay is None:
        _logger.warning(
            "%s sync still needs retry after %s attempts; waiting for next process start.",
            label,
            len(_SYNC_RETRY_DELAYS_SECONDS),
        )
        return

    def _retry() -> None:
        try:
            result = _single_flight_sync(label, sync_func)
        except Exception as exc:  # noqa: BLE001
            _logger.exception("%s retry sync threw unexpectedly: %s", label, exc)
            result = "retry"
        if result == "skipped":
            _schedule_sync_retry(label, sync_func, attempt)
        elif result == "retry":
            _schedule_sync_retry(label, sync_func, attempt + 1)

    timer = threading.Timer(delay, _retry)
    timer.daemon = True
    timer.start()
    _logger.info("%s sync will retry in %ss.", label, delay)


def _log_sync_result(r) -> None:  # type: ignore[no-untyped-def]
    repo = r.spec.repo
    sha_short = r.commit_sha[:8] if r.commit_sha else "unknown"
    if r.status == "updated":
        _logger.info("Data updated from GitHub (%s @ %s).", repo, sha_short)
    elif r.status == "up_to_date":
        _logger.info("Data is up to date (%s @ %s).", repo, sha_short)
    elif r.status == "offline_fallback":
        _logger.warning(
            "Network unavailable; using cached data (%s @ %s). Error: %s",
            repo, sha_short, r.error,
        )
    elif r.status == "no_data":
        _logger.warning(
            "Sync failed for %s — no data available. Error: %s",
            repo, r.error,
        )


def _run_startup_sync() -> None:
    """Check upstream GitHub and download data files if outdated.

    Skipped when GAMEDATA_PATH is explicitly set to a custom location —
    in that case the user is managing their own data and we must not
    overwrite it.
    """
    from prts_mcp.config import Config, _DEFAULT_GAMEDATA_PATH
    from prts_mcp.data.datasets import GAMEDATA_EXCEL, GAMEDATA_LEVELS, STORY_ZH_CN
    from prts_mcp.data.sync import sync_release, sync_release_archive

    cfg = Config.load()
    if cfg.is_custom_gamedata:
        _logger.info(
            "GAMEDATA_PATH is set to a custom location (%s); auto-sync disabled.",
            cfg.gamedata_path,
        )
    else:
        archive_spec = GAMEDATA_EXCEL.archive_spec(
            local_zip=_DEFAULT_GAMEDATA_PATH / "archives" / "zh_CN-excel.zip",
            local_root=_DEFAULT_GAMEDATA_PATH,
        )

        def _sync_gamedata() -> bool:
            r = sync_release_archive(archive_spec)
            _log_sync_result(r)
            if r.status == "updated":
                from prts_mcp.data.operator import clear_operator_caches
                from prts_mcp.data.enemy import clear_enemy_caches
                from prts_mcp.data.item import clear_item_caches
                from prts_mcp.data.stage_enemy import clear_stage_enemy_caches

                clear_operator_caches()
                clear_enemy_caches()
                clear_item_caches()
                clear_stage_enemy_caches()
                from prts_mcp.data.stage import clear_stage_caches as _clear_stages
                _clear_stages()
            return _sync_needs_retry(r.status)

        needs_retry = _run_initial_sync(
            "Gamedata",
            lambda: _single_flight_sync("Gamedata", _sync_gamedata) != "done",
        )
        if needs_retry:
            _schedule_sync_retry("Gamedata", _sync_gamedata)

        levels_spec = GAMEDATA_LEVELS.archive_spec(
            local_zip=cfg.levels_path / "archives" / "zh_CN-levels.zip",
            local_root=cfg.levels_path,
        )

        def _sync_levels() -> bool:
            r = sync_release_archive(levels_spec)
            _log_sync_result(r)
            if r.status == "updated":
                from prts_mcp.data.enemy import clear_enemy_caches
                from prts_mcp.data.stage_enemy import clear_stage_enemy_caches

                clear_enemy_caches()
                clear_stage_enemy_caches()
            return _sync_needs_retry(r.status)

        needs_retry = _run_initial_sync(
            "Gamedata levels",
            lambda: _single_flight_sync("Gamedata levels", _sync_levels) != "done",
        )
        if needs_retry:
            _schedule_sync_retry("Gamedata levels", _sync_levels)

    # Always try to sync storyjson from GitHub Release (unless user supplied their own zip)
    if "STORYJSON_PATH" not in os.environ:
        release_spec = STORY_ZH_CN.release_spec(cfg.storyjson_zip)

        def _sync_storyjson() -> bool:
            r = sync_release(release_spec)
            _log_sync_result(r)
            if r.status == "updated":
                from prts_mcp.data.story import clear_story_caches

                clear_story_caches()
            return _sync_needs_retry(r.status)

        needs_retry = _run_initial_sync(
            "Storyjson",
            lambda: _single_flight_sync("Storyjson", _sync_storyjson) != "done",
        )
        if needs_retry:
            _schedule_sync_retry("Storyjson", _sync_storyjson)
