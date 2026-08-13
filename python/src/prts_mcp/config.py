from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Path design (two separate roots, never mixed up)
#
# DEFAULT_GAMEDATA_PATH — where auto-sync writes data at runtime.
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


DEFAULT_GAMEDATA_PATH = _resolve_default_gamedata_path()

# storyjson zip alongside gamedata in the user data directory.
_DEFAULT_STORYJSON_ZIP = DEFAULT_GAMEDATA_PATH.parent / "storyjson" / "zh_CN.zip"

# Image artwork assets (2.5.0) sit alongside gamedata under the data root.
_DEFAULT_IMAGES_PATH = DEFAULT_GAMEDATA_PATH.parent / "images"


def _env_bool(name: str, default: bool) -> bool:
    """Parse a boolean env var (``1``/``true``/``yes``/``on``); unset → default."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


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


def gamedata_pair_path(gamedata_root: Path, levels_root: Path) -> Path:
    gamedata_parent = gamedata_root.resolve().parent
    levels_parent = levels_root.resolve().parent
    if gamedata_parent != levels_parent:
        return gamedata_parent / ".gamedata_pair.invalid"
    return gamedata_parent / ".gamedata_pair.json"


def _activated_pair(
    gamedata_root: Path,
    levels_root: Path,
) -> tuple[Path, Path] | None:
    try:
        value = json.loads(
            gamedata_pair_path(gamedata_root, levels_root).read_text(
                encoding="utf-8"
            )
        )
        commit_sha = value.get("commit_sha")
        excel_data_root = value.get("excel_data_root")
        levels_data_root = value.get("levels_data_root")
        if not all(
            isinstance(item, str) and item
            for item in (commit_sha, excel_data_root, levels_data_root)
        ):
            return None
        excel_root = (gamedata_root / excel_data_root).resolve()
        active_levels_root = (levels_root / levels_data_root).resolve()
        if not excel_root.is_relative_to(gamedata_root.resolve()):
            return None
        if not active_levels_root.is_relative_to(levels_root.resolve()):
            return None
        if not excel_root.is_dir() or not active_levels_root.is_dir():
            return None
        return excel_root, active_levels_root
    except (OSError, json.JSONDecodeError, AttributeError, ValueError):
        return None


def _levels_path(gamedata_root: Path) -> Path:
    return gamedata_root.parent / "gamedata-levels"


def resolve_levels_path(gamedata_root: Path) -> Path:
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
    images_enabled: bool         # IMAGES_ENABLED; False → operator_artwork not registered
    local_image: bool            # LOCAL_IMAGE; True = AKDP local assets, False = MediaWiki
    original_image: bool         # ORIGINAL_IMAGE; True = also sync original-variant shards
    prts_image_cache: bool       # PRTS_IMAGE_CACHE; True = LRU-cache MediaWiki images (false mode)
    images_path: Path            # image asset sync target (PRTS_IMAGE_DIR or default)

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
        object.__setattr__(self, "excel_path", ep)

        lp = resolve_levels_path(self.gamedata_path)
        object.__setattr__(self, "levels_path", lp)
        active_pair = _activated_pair(self.gamedata_path, lp)
        active_gamedata_root = (
            active_pair[0]
            if active_pair is not None
            else _activated_root(self.gamedata_path)
        )
        active_levels_root = (
            active_pair[1] if active_pair is not None else _activated_root(lp)
        )
        active_ep = _excel_path(active_gamedata_root)

        bundled_pair = _activated_pair(
            _BUNDLED_GAMEDATA_PATH,
            _BUNDLED_LEVELS_PATH,
        )
        bundled_gamedata_root = (
            bundled_pair[0]
            if bundled_pair is not None
            else _activated_root(_BUNDLED_GAMEDATA_PATH)
        )
        bundled_levels_root = (
            bundled_pair[1]
            if bundled_pair is not None
            else _activated_root(_BUNDLED_LEVELS_PATH)
        )
        bep = _excel_path(bundled_gamedata_root)
        object.__setattr__(self, "bundled_excel_path", bep)

        blp = bundled_levels_root
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

        if _levels_complete(active_levels_root):
            object.__setattr__(self, "effective_levels_path", active_levels_root)
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
        from prts_mcp import activation

        pinned = activation.peek_pinned_config()
        if pinned is not None:
            return pinned
        activation.check_activation_change()
        custom = "GAMEDATA_PATH" in os.environ
        gamedata = Path(os.environ["GAMEDATA_PATH"]) if custom else DEFAULT_GAMEDATA_PATH
        storyjson_zip = (
            Path(os.environ["STORYJSON_PATH"])
            if "STORYJSON_PATH" in os.environ
            else _DEFAULT_STORYJSON_ZIP
        )
        images_path = (
            Path(os.environ["PRTS_IMAGE_DIR"])
            if "PRTS_IMAGE_DIR" in os.environ
            else _DEFAULT_IMAGES_PATH
        )
        config = cls(
            gamedata_path=gamedata,
            storyjson_zip=storyjson_zip,
            is_custom_gamedata=custom,
            images_enabled=_env_bool("IMAGES_ENABLED", True),
            local_image=_env_bool("LOCAL_IMAGE", False),
            original_image=_env_bool("ORIGINAL_IMAGE", False),
            prts_image_cache=_env_bool("PRTS_IMAGE_CACHE", True),
            images_path=images_path,
        )
        return config
