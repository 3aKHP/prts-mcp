from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[2]  # -> PRTS-MCP/
_LOCAL_REPO_FILE = _PROJECT_ROOT / "local_repo.jsonc"
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


def _load_local_repo_jsonc() -> dict[str, str]:
    """Parse local_repo.jsonc (strip // comments) and return path mapping."""
    if not _LOCAL_REPO_FILE.exists():
        return {}
    text = _LOCAL_REPO_FILE.read_text(encoding="utf-8")
    lines = [line.split("//")[0] for line in text.splitlines()]
    try:
        return json.loads("\n".join(lines))
    except json.JSONDecodeError:
        return {}


def _resolve_data_path(*candidates: str | Path | None) -> Path | None:
    normalized: list[Path] = []
    for candidate in candidates:
        if candidate in (None, ""):
            continue
        normalized.append(Path(candidate))

    for path in normalized:
        if path.exists():
            return path

    return normalized[0] if normalized else None


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
        repo_map = _load_local_repo_jsonc()
        gamedata = _resolve_data_path(
            os.environ.get("GAMEDATA_PATH"),
            repo_map.get("ArknightsGameData"),
            _DEFAULT_GAMEDATA_PATH,
        )
        storyjson = _resolve_data_path(
            os.environ.get("STORYJSON_PATH"),
            repo_map.get("ArknightsStoryJson"),
            _DEFAULT_STORYJSON_PATH,
        )
        return cls(
            gamedata_path=gamedata,
            storyjson_path=storyjson,
        )
