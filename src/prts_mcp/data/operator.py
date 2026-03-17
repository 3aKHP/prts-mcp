from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from prts_mcp.config import Config

# ---------------------------------------------------------------------------
# Internal caches (loaded lazily on first call)
# ---------------------------------------------------------------------------

_config: Config | None = None


def _get_config() -> Config:
    global _config
    if _config is None:
        _config = Config.load()
    return _config


@lru_cache(maxsize=1)
def _load_character_table() -> dict[str, Any]:
    path = _get_config().excel_path / "character_table.json"
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _load_handbook_table() -> dict[str, Any]:
    path = _get_config().excel_path / "handbook_info_table.json"
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _load_charword_table() -> dict[str, Any]:
    path = _get_config().excel_path / "charword_table.json"
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _build_name_to_id() -> dict[str, str]:
    """Map operator Chinese name -> charId."""
    ct = _load_character_table()
    return {info["name"]: cid for cid, info in ct.items() if info.get("name")}


def _resolve_char_id(name: str) -> str | None:
    mapping = _build_name_to_id()
    return mapping.get(name)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_operator_archives(name: str) -> str:
    """Return formatted archive text for an operator by Chinese name."""
    char_id = _resolve_char_id(name)
    if char_id is None:
        return f"未找到干员 '{name}'。请使用游戏内中文名称（如'阿米娅'）。"

    handbook = _load_handbook_table().get("handbookDict", {})
    entry = handbook.get(char_id)
    if entry is None:
        return f"干员 '{name}' 暂无档案数据。"

    sections: list[str] = []
    for story in entry.get("storyTextAudio", []):
        title = story.get("storyTitle", "")
        texts = [s.get("storyText", "") for s in story.get("stories", []) if s.get("storyText")]
        if texts:
            sections.append(f"### {title}\n" + "\n".join(texts))

    if not sections:
        return f"干员 '{name}' 档案内容为空。"
    return f"# {name} - 干员档案\n\n" + "\n\n".join(sections)


def get_operator_voicelines(name: str) -> str:
    """Return formatted voice-line text for an operator by Chinese name."""
    char_id = _resolve_char_id(name)
    if char_id is None:
        return f"未找到干员 '{name}'。请使用游戏内中文名称（如'阿米娅'）。"

    charwords = _load_charword_table().get("charWords", {})
    lines: list[str] = []
    for entry in charwords.values():
        if entry.get("charId") == char_id and entry.get("voiceText"):
            title = entry.get("voiceTitle", "未知")
            lines.append(f"**{title}**: {entry['voiceText']}")

    if not lines:
        return f"干员 '{name}' 暂无语音数据。"
    return f"# {name} - 语音记录\n\n" + "\n".join(lines)
