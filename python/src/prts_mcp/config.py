from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from functools import lru_cache, wraps
from pathlib import Path
from typing import Any, Callable

_logger = logging.getLogger(__name__)
_activation_lock = threading.RLock()
_activation_signature: tuple[Path | None, Path | None] | None = None
_activation_listeners: list[Callable[[], None]] = []


def register_activation_listener(listener: Callable[[], None]) -> None:
    """Register a cache invalidator for activated GameData generation changes."""
    with _activation_lock:
        if listener not in _activation_listeners:
            _activation_listeners.append(listener)


def _notify_activation_change(config: Config) -> None:
    global _activation_signature

    signature = (config.effective_excel_path, config.effective_levels_path)
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

# ---------------------------------------------------------------------------
# Path design (two separate roots, never mixed up)
#
# _DEFAULT_GAMEDATA_PATH — where auto-sync writes data at runtime.
#   Priority (highest to lowest):
#   1. GAMEDATA_PATH env var  — set by user when mounting a custom volume;
#                               auto-sync is DISABLED in this case.
#   2. /data/gamedata         — the fixed volume mount-point inside Docker.
#                               Used when PRTS_MCP_ROOT==/app (set by the
#                               Dockerfile) AND /data/gamedata exists or can
#                               be created.
#   3. User data directory    — ~/.local/share/prts-mcp/ on Linux/macOS;
#                               %LOCALAPPDATA%\prts-mcp\ on Windows.
#                               Used outside Docker (pip install, dev runs).
#
# _BUNDLED_GAMEDATA_PATH — read-only fallback baked into the Docker image.
#   Always /app/data/gamedata.  Only meaningful inside the container; on the
#   host this path almost certainly does not exist, which is fine — the
#   fallback simply won't trigger.
# ---------------------------------------------------------------------------

# Fixed volume mount-point inside the Docker image.
_DOCKER_VOLUME_PATH = Path("/data/gamedata")

# Bundled data baked into the image at build time (COPY data/ data/).
_BUNDLED_GAMEDATA_PATH = Path("/app/data/gamedata")

# storyjson zip paths
_DOCKER_STORYJSON_ZIP = Path("/data/storyjson/zh_CN.zip")
_BUNDLED_STORYJSON_ZIP = Path("/app/data/storyjson/zh_CN.zip")
_DOCKER_LEVELS_PATH = Path("/data/gamedata-levels")
_BUNDLED_LEVELS_PATH = Path("/app/data/gamedata-levels")

_REQUIRED_OPERATOR_FILES = (
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
)

PRTS_API_ENDPOINT = "https://prts.wiki/api.php"
USER_AGENT = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)"
RATE_LIMIT_INTERVAL = 1.5  # seconds between PRTS API requests


def _resolve_default_gamedata_path() -> Path:
    """Return the path where auto-sync should write data.

    Inside Docker (PRTS_MCP_ROOT==/app) the fixed volume mount-point
    /data/gamedata is used.  Outside Docker we fall back to the per-user
    data directory so that a bare ``pip install`` also works without any
    manual configuration.
    """
    if os.environ.get("PRTS_MCP_ROOT") == "/app":
        return _DOCKER_VOLUME_PATH

    # Outside Docker: per-user data directory.
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "prts-mcp" / "gamedata"


_DEFAULT_GAMEDATA_PATH = _resolve_default_gamedata_path()

# storyjson zip alongside gamedata in the user data directory.
_DEFAULT_STORYJSON_ZIP = _DEFAULT_GAMEDATA_PATH.parent / "storyjson" / "zh_CN.zip"


def _excel_path(gamedata_root: Path) -> Path:
    return gamedata_root / "zh_CN" / "gamedata" / "excel"


def _activated_root(root: Path) -> Path:
    """Resolve the immutable data tree selected by auto-sync metadata."""
    try:
        meta = json.loads(
            (root / "archives" / "extract_meta.json").read_text(encoding="utf-8")
        )
        data_root = meta.get("data_root")
        if not isinstance(data_root, str) or not data_root:
            return root
        activated = (root / data_root).resolve()
        if activated.is_relative_to(root.resolve()) and activated.is_dir():
            return activated
    except (OSError, json.JSONDecodeError, AttributeError):
        pass
    return root


def _levels_path(gamedata_root: Path) -> Path:
    return gamedata_root.parent / "gamedata-levels"


def _resolve_levels_path(gamedata_root: Path) -> Path:
    if "GAMEDATA_PATH" in os.environ and _levels_complete(gamedata_root):
        return gamedata_root
    if "GAMEDATA_PATH" in os.environ:
        return _levels_path(gamedata_root)
    if os.environ.get("PRTS_MCP_ROOT") == "/app":
        return _DOCKER_LEVELS_PATH
    return _levels_path(gamedata_root)


def _files_complete(excel: Path) -> bool:
    return all((excel / f).is_file() for f in _REQUIRED_OPERATOR_FILES)


def _levels_complete(root: Path) -> bool:
    return (root / "zh_CN" / "gamedata" / "levels" / "enemydata" / "enemy_database.json").is_file()


@dataclass(frozen=True)
class Config:
    gamedata_path: Path          # sync write target (volume or user dir)
    storyjson_zip: Path          # storyjson zip path (custom, volume, or default)
    is_custom_gamedata: bool     # True when GAMEDATA_PATH was set by the user

    # Derived paths — set in __post_init__, never passed to __init__.
    excel_path: Path = field(init=False)
    levels_path: Path = field(init=False)
    bundled_excel_path: Path = field(init=False)
    bundled_levels_path: Path = field(init=False)
    effective_excel_path: Path | None = field(init=False)
    effective_levels_path: Path | None = field(init=False)
    effective_storyjson_zip: Path | None = field(init=False)

    def __post_init__(self) -> None:
        ep = _excel_path(self.gamedata_path)
        active_ep = _excel_path(_activated_root(self.gamedata_path))
        object.__setattr__(self, "excel_path", ep)

        lp = _resolve_levels_path(self.gamedata_path)
        object.__setattr__(self, "levels_path", lp)

        bep = _excel_path(_BUNDLED_GAMEDATA_PATH)
        object.__setattr__(self, "bundled_excel_path", bep)

        blp = _BUNDLED_LEVELS_PATH
        object.__setattr__(self, "bundled_levels_path", blp)

        # effective_excel_path: the path operator.py should actually read from.
        # Prefer the volume/sync path when its files are present; fall back to
        # bundled data otherwise.  Returns None when neither location has data.
        if _files_complete(active_ep):
            object.__setattr__(self, "effective_excel_path", active_ep)
        elif _files_complete(bep):
            object.__setattr__(self, "effective_excel_path", bep)
        else:
            object.__setattr__(self, "effective_excel_path", None)

        active_lp = _activated_root(lp)
        if _levels_complete(active_lp):
            object.__setattr__(self, "effective_levels_path", active_lp)
        elif _levels_complete(blp):
            object.__setattr__(self, "effective_levels_path", blp)
        else:
            object.__setattr__(self, "effective_levels_path", None)

        # effective_storyjson_zip: priority — custom env var / volume path →
        # bundled zip.  Returns None when no zip is found anywhere.
        if self.storyjson_zip.is_file():
            object.__setattr__(self, "effective_storyjson_zip", self.storyjson_zip)
        elif _DOCKER_STORYJSON_ZIP.is_file():
            object.__setattr__(self, "effective_storyjson_zip", _DOCKER_STORYJSON_ZIP)
        elif _BUNDLED_STORYJSON_ZIP.is_file():
            object.__setattr__(self, "effective_storyjson_zip", _BUNDLED_STORYJSON_ZIP)
        else:
            object.__setattr__(self, "effective_storyjson_zip", None)

    @property
    def has_operator_data(self) -> bool:
        return self.effective_excel_path is not None

    @property
    def has_story_data(self) -> bool:
        return self.effective_storyjson_zip is not None

    @property
    def has_levels_data(self) -> bool:
        return self.effective_levels_path is not None

    @property
    def missing_operator_files(self) -> tuple[Path, ...]:
        """Files missing from the primary (non-bundled) excel path."""
        return tuple(
            self.excel_path / f
            for f in _REQUIRED_OPERATOR_FILES
            if not (self.excel_path / f).is_file()
        )

    @classmethod
    def load(cls) -> Config:
        custom = "GAMEDATA_PATH" in os.environ
        gamedata = Path(os.environ["GAMEDATA_PATH"]) if custom else _DEFAULT_GAMEDATA_PATH
        storyjson_zip = (
            Path(os.environ["STORYJSON_PATH"])
            if "STORYJSON_PATH" in os.environ
            else _DEFAULT_STORYJSON_ZIP
        )
        config = cls(
            gamedata_path=gamedata,
            storyjson_zip=storyjson_zip,
            is_custom_gamedata=custom,
        )
        _notify_activation_change(config)
        return config


def activation_aware_cache(maxsize: int = 1) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Cache GameData reads while checking the active generation on every access."""
    def decorate(func: Callable[..., Any]) -> Callable[..., Any]:
        cached = lru_cache(maxsize=maxsize)(func)

        @wraps(func)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            Config.load()
            return cached(*args, **kwargs)

        wrapped.cache_clear = cached.cache_clear  # type: ignore[attr-defined]
        wrapped.cache_info = cached.cache_info  # type: ignore[attr-defined]
        return wrapped

    return decorate
