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


def _missing_operator_data_message() -> str:
    config = _get_config()
    searched = str(config.excel_path)
    return (
        "干员数据暂不可用。"
        "容器启动时的 auto-sync 可能仍在进行中，请稍后重试；"
        "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。"
        f"（当前同步目标路径：{searched}）"
    )


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(
            f"干员数据文件不存在：{path}。"
            "数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向 ArknightsGameData 仓库根目录）。"
        )
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _load_character_table() -> dict[str, Any]:
    ep = _get_config().effective_excel_path
    assert ep is not None
    return _load_json(ep / "character_table.json")


@lru_cache(maxsize=1)
def _load_handbook_table() -> dict[str, Any]:
    ep = _get_config().effective_excel_path
    assert ep is not None
    return _load_json(ep / "handbook_info_table.json")


@lru_cache(maxsize=1)
def _load_charword_table() -> dict[str, Any]:
    ep = _get_config().effective_excel_path
    assert ep is not None
    return _load_json(ep / "charword_table.json")


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
    if not _get_config().has_operator_data:
        return _missing_operator_data_message()

    try:
        char_id = _resolve_char_id(name)
    except FileNotFoundError as exc:
        return str(exc)
    if char_id is None:
        return f"未找到干员 '{name}'。请使用游戏内中文名称（如'阿米娅'）。"

    try:
        handbook = _load_handbook_table().get("handbookDict", {})
    except FileNotFoundError as exc:
        return str(exc)
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
    if not _get_config().has_operator_data:
        return _missing_operator_data_message()

    try:
        char_id = _resolve_char_id(name)
    except FileNotFoundError as exc:
        return str(exc)
    if char_id is None:
        return f"未找到干员 '{name}'。请使用游戏内中文名称（如'阿米娅'）。"

    try:
        charwords = _load_charword_table().get("charWords", {})
    except FileNotFoundError as exc:
        return str(exc)
    lines: list[str] = []
    for entry in charwords.values():
        if entry.get("charId") == char_id and entry.get("voiceText"):
            title = entry.get("voiceTitle", "未知")
            lines.append(f"**{title}**: {entry['voiceText']}")

    if not lines:
        return f"干员 '{name}' 暂无语音数据。"
    return f"# {name} - 语音记录\n\n" + "\n".join(lines)
