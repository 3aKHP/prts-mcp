from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[2]  # -> PRTS-MCP/
_LOCAL_REPO_FILE = _PROJECT_ROOT / "local_repo.jsonc"

PRTS_API_ENDPOINT = "https://prts.wiki/api.php"
USER_AGENT = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper; +https://github.com)"
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


@dataclass(frozen=True)
class Config:
    gamedata_path: Path
    storyjson_path: Path

    # derived convenience paths
    excel_path: Path = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "excel_path",
            self.gamedata_path / "zh_CN" / "gamedata" / "excel",
        )

    @classmethod
    def load(cls) -> Config:
        repo_map = _load_local_repo_jsonc()
        gamedata = os.environ.get("GAMEDATA_PATH") or repo_map.get("ArknightsGameData", "")
        storyjson = os.environ.get("STORYJSON_PATH") or repo_map.get("ArknightsStoryJson", "")
        return cls(
            gamedata_path=Path(gamedata),
            storyjson_path=Path(storyjson),
        )
