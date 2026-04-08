from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Project root resolution
#
# When the package is installed via `pip install .`, __file__ resolves to a
# location inside site-packages, not the project checkout. We use the
# PRTS_MCP_ROOT environment variable (set to /app in the Docker image) as the
# authoritative project root, falling back to the parents[2] heuristic for
# editable / development installs.
# ---------------------------------------------------------------------------

_PROJECT_ROOT = Path(os.environ.get("PRTS_MCP_ROOT", str(Path(__file__).resolve().parents[2])))
_BUNDLED_DATA_ROOT = _PROJECT_ROOT / "data"
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
