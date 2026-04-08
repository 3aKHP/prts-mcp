from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Default data directory resolution
#
# Priority (highest to lowest):
#   1. GAMEDATA_PATH / STORYJSON_PATH env vars  — always honoured in Config.load()
#   2. PRTS_MCP_ROOT env var                    — set to /app in the Docker image;
#                                                 data lives at $PRTS_MCP_ROOT/data/
#   3. Editable-install heuristic               — parents[2] of __file__ points at
#                                                 the checkout root when installed
#                                                 with `pip install -e .`
#   4. User data directory                      — ~/.local/share/prts-mcp/ on Linux/
#                                                 macOS; %LOCALAPPDATA%\prts-mcp\ on
#                                                 Windows.  Used when the package is
#                                                 installed non-editably and neither
#                                                 PRTS_MCP_ROOT nor a checkout is
#                                                 detectable.
#
# Non-editable installs (pip install .) without PRTS_MCP_ROOT: the parents[2]
# heuristic points into site-packages, which is unlikely to contain a data/
# directory.  In that case _resolve_default_data_root() falls through to the
# user data directory so the server and fetch_gamedata.py agree on where data
# lives without any manual env var configuration.
# ---------------------------------------------------------------------------


def _resolve_default_data_root() -> Path:
    # Explicit override wins unconditionally.
    if "PRTS_MCP_ROOT" in os.environ:
        return Path(os.environ["PRTS_MCP_ROOT"]) / "data"

    # Editable-install / development checkout: __file__ is inside src/prts_mcp/,
    # so parents[2] is the project root.
    candidate = Path(__file__).resolve().parents[2] / "data"
    if candidate.is_dir():
        return candidate

    # Non-editable install fallback: use a per-user data directory.
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "prts-mcp"


_BUNDLED_DATA_ROOT = _resolve_default_data_root()
_DEFAULT_GAMEDATA_PATH = _BUNDLED_DATA_ROOT / "gamedata"
_DEFAULT_STORYJSON_PATH = _BUNDLED_DATA_ROOT / "storyjson"
_REQUIRED_OPERATOR_FILES = (
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
)

PRTS_API_ENDPOINT = "https://prts.wiki/api.php"
USER_AGENT = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)"
RATE_LIMIT_INTERVAL = 1.5  # seconds between PRTS API requests


@dataclass(frozen=True)
class Config:
    gamedata_path: Path | None
    storyjson_path: Path | None

    # derived convenience paths
    excel_path: Path | None = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "excel_path",
            None if self.gamedata_path is None else self.gamedata_path / "zh_CN" / "gamedata" / "excel",
        )

    @property
    def operator_data_files(self) -> tuple[Path, ...]:
        if self.excel_path is None:
            return ()
        return tuple(self.excel_path / filename for filename in _REQUIRED_OPERATOR_FILES)

    @property
    def has_operator_data(self) -> bool:
        return bool(self.operator_data_files) and all(path.is_file() for path in self.operator_data_files)

    @property
    def missing_operator_files(self) -> tuple[Path, ...]:
        return tuple(path for path in self.operator_data_files if not path.is_file())

    @classmethod
    def load(cls) -> Config:
        gamedata = (
            Path(os.environ["GAMEDATA_PATH"]) if "GAMEDATA_PATH" in os.environ else _DEFAULT_GAMEDATA_PATH
        )
        storyjson = (
            Path(os.environ["STORYJSON_PATH"]) if "STORYJSON_PATH" in os.environ else _DEFAULT_STORYJSON_PATH
        )
        return cls(gamedata_path=gamedata, storyjson_path=storyjson)
