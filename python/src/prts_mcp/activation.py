"""GameData generation activation.

Detect when the auto-synced GameData generation pointer changes and pin one
stable generation for the duration of a complete tool invocation. Extracted
from ``config.py`` — this is the state+update+query trinity (signature token,
listener registry, per-invocation snapshot) that STYLE.md requires be its own
unit rather than a hidden module-level singleton inside config.

``Config.load`` reads the pinned config back via :func:`peek_pinned_config`
(late-importing this module so the import graph stays a one-way DAG
``activation -> config``).
"""
from __future__ import annotations

import logging
import os
import threading
from contextvars import ContextVar
from functools import wraps
from inspect import iscoroutinefunction
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from prts_mcp import config

if TYPE_CHECKING:
    from prts_mcp.config import Config

_logger = logging.getLogger(__name__)
_activation_lock = threading.RLock()
_activation_signature: tuple[object, ...] | None = None
_activation_listeners: list[Callable[[], None]] = []
_activation_snapshot: ContextVar[tuple[Any, tuple[object, ...]] | None] = (
    ContextVar("prts_activation_snapshot", default=None)
)


def register_activation_listener(listener: Callable[[], None]) -> None:
    """Register a cache invalidator for activated GameData generation changes."""
    with _activation_lock:
        if listener not in _activation_listeners:
            _activation_listeners.append(listener)


def _activation_meta_token(root: Path) -> tuple[object, ...]:
    return _activation_path_token(root / "archives" / "extract_meta.json")


def _activation_path_token(path: Path) -> tuple[object, ...]:
    try:
        info = path.stat()
        return (
            str(path),
            info.st_ino,
            info.st_size,
            info.st_mtime_ns,
            info.st_ctime_ns,
        )
    except OSError:
        return (str(path), None)


def check_activation_change() -> None:
    """Invalidate GameData caches when either activation pointer is replaced."""
    global _activation_signature

    if _activation_snapshot.get() is not None:
        return

    custom = "GAMEDATA_PATH" in os.environ
    gamedata = Path(os.environ["GAMEDATA_PATH"]) if custom else config._DEFAULT_GAMEDATA_PATH
    levels = config._resolve_levels_path(gamedata)
    signature = (
        _activation_path_token(config._gamedata_pair_path(gamedata, levels))
        + _activation_meta_token(gamedata)
        + _activation_meta_token(levels)
    )
    with _activation_lock:
        previous = _activation_signature
        _activation_signature = signature
        if previous is None or previous == signature:
            return
        for listener in tuple(_activation_listeners):
            try:
                listener()
            except Exception:  # noqa: BLE001
                _logger.exception("Failed to invalidate a GameData cache")


def current_activation_signature() -> tuple[object, ...]:
    snapshot = _activation_snapshot.get()
    if snapshot is not None:
        return snapshot[1]
    check_activation_change()
    with _activation_lock:
        return _activation_signature or ()


def _load_activation_snapshot() -> tuple[Config, tuple[object, ...]]:
    while True:
        before = current_activation_signature()
        cfg = config.Config.load()
        after = current_activation_signature()
        if before == after:
            return cfg, after


def peek_pinned_config() -> Config | None:
    """Return the config pinned by the active activation snapshot, or None.

    Lets ``Config.load`` honor a pinned generation without touching this
    module's private ``ContextVar``.
    """
    snapshot = _activation_snapshot.get()
    return snapshot[0] if snapshot is not None else None


def activation_snapshot(func: Callable[..., Any]) -> Callable[..., Any]:
    """Keep one activated generation stable for a complete tool invocation."""
    if iscoroutinefunction(func):
        @wraps(func)
        async def async_wrapped(*args: Any, **kwargs: Any) -> Any:
            if _activation_snapshot.get() is not None:
                return await func(*args, **kwargs)
            cfg, generation = _load_activation_snapshot()
            token = _activation_snapshot.set((cfg, generation))
            try:
                return await func(*args, **kwargs)
            finally:
                _activation_snapshot.reset(token)

        return async_wrapped

    @wraps(func)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        if _activation_snapshot.get() is not None:
            return func(*args, **kwargs)
        cfg, generation = _load_activation_snapshot()
        token = _activation_snapshot.set((cfg, generation))
        try:
            return func(*args, **kwargs)
        finally:
            _activation_snapshot.reset(token)

    return wrapped
