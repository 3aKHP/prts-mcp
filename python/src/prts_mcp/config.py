from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

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

_REQUIRED_OPERATOR_FILES = (
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
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

# storyjson is reserved for future use; keep it alongside gamedata.
_DEFAULT_STORYJSON_PATH = _DEFAULT_GAMEDATA_PATH.parent / "storyjson"


def _excel_path(gamedata_root: Path) -> Path:
    return gamedata_root / "zh_CN" / "gamedata" / "excel"


def _files_complete(excel: Path) -> bool:
    return all((excel / f).is_file() for f in _REQUIRED_OPERATOR_FILES)


@dataclass(frozen=True)
class Config:
    gamedata_path: Path          # sync write target (volume or user dir)
    storyjson_path: Path
    is_custom_gamedata: bool     # True when GAMEDATA_PATH was set by the user

    # Derived paths — set in __post_init__, never passed to __init__.
    excel_path: Path = field(init=False)
    bundled_excel_path: Path = field(init=False)
    effective_excel_path: Path | None = field(init=False)

    def __post_init__(self) -> None:
        ep = _excel_path(self.gamedata_path)
        object.__setattr__(self, "excel_path", ep)

        bep = _excel_path(_BUNDLED_GAMEDATA_PATH)
        object.__setattr__(self, "bundled_excel_path", bep)

        # effective_excel_path: the path operator.py should actually read from.
        # Prefer the volume/sync path when its files are present; fall back to
        # bundled data otherwise.  Returns None when neither location has data.
        if _files_complete(ep):
            object.__setattr__(self, "effective_excel_path", ep)
        elif _files_complete(bep):
            object.__setattr__(self, "effective_excel_path", bep)
        else:
            object.__setattr__(self, "effective_excel_path", None)

    @property
    def has_operator_data(self) -> bool:
        return self.effective_excel_path is not None

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
        storyjson = (
            Path(os.environ["STORYJSON_PATH"])
            if "STORYJSON_PATH" in os.environ
            else _DEFAULT_STORYJSON_PATH
        )
        return cls(gamedata_path=gamedata, storyjson_path=storyjson, is_custom_gamedata=custom)
