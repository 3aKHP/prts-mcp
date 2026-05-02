from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from prts_mcp.config import Config
from prts_mcp.utils.sanitizer import strip_wikitext

def _get_config() -> Config:
    return Config.load()


def clear_operator_caches() -> None:
    """Clear lazy table caches after synced game data changes on disk."""
    _load_character_table.cache_clear()
    _load_handbook_table.cache_clear()
    _load_charword_table.cache_clear()
    _build_name_to_id.cache_clear()


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


# ---------------------------------------------------------------------------
# Basic info helpers
# ---------------------------------------------------------------------------

_PROFESSION_ZH: dict[str, str] = {
    "CASTER": "术师",
    "MEDIC": "医疗",
    "PIONEER": "先锋",
    "SNIPER": "狙击",
    "SPECIAL": "特种",
    "SUPPORT": "辅助",
    "TANK": "重装",
    "WARRIOR": "近卫",
}

_POSITION_ZH: dict[str, str] = {
    "RANGED": "远程",
    "MELEE": "近战",
    "ALL": "通用",
    "NONE": "-",
}


def get_operator_basic_info(name: str) -> str:
    """Return basic profile info for an operator by Chinese name."""
    if not _get_config().has_operator_data:
        return _missing_operator_data_message()

    try:
        char_id = _resolve_char_id(name)
    except FileNotFoundError as exc:
        return str(exc)
    if char_id is None:
        return f"未找到干员 '{name}'。请使用游戏内中文名称（如'阿米娅'）。"

    try:
        ct = _load_character_table()
    except FileNotFoundError as exc:
        return str(exc)
    info = ct.get(char_id)
    if info is None:
        return f"干员 '{name}' 暂无基本信息。"

    rarity_raw: str = info.get("rarity", "")
    rarity = rarity_raw.replace("TIER_", "") + "★" if rarity_raw.startswith("TIER_") else rarity_raw

    profession_raw: str = info.get("profession", "")
    profession = _PROFESSION_ZH.get(profession_raw, profession_raw)

    position_raw: str = info.get("position", "")
    position = _POSITION_ZH.get(position_raw, position_raw)

    appellation: str = info.get("appellation", "")
    display_number: str = info.get("displayNumber", "")
    description: str = info.get("description", "")
    item_usage: str = info.get("itemUsage", "")
    item_desc: str = info.get("itemDesc", "")
    item_obtain: str = info.get("itemObtainApproach", "")
    tag_list: list[str] = info.get("tagList") or []

    nation_id: str = info.get("nationId") or ""
    group_id: str = info.get("groupId") or ""
    team_id: str = info.get("teamId") or ""
    affiliation_parts = [x for x in [nation_id, group_id, team_id] if x]
    affiliation = " / ".join(affiliation_parts) if affiliation_parts else "-"

    lines: list[str] = [f"# {name} - 干员基本信息\n"]
    lines.append(f"- **编号**：{display_number}")
    lines.append(f"- **英文名**：{appellation}")
    lines.append(f"- **稀有度**：{rarity}")
    lines.append(f"- **职业**：{profession}（{info.get('subProfessionId', '')}）")
    lines.append(f"- **站位**：{position}")
    lines.append(f"- **所属**：{affiliation}")
    if tag_list:
        lines.append(f"- **招募标签**：{'、'.join(tag_list)}")
    if description:
        lines.append(f"- **攻击属性**：{strip_wikitext(description)}")
    if item_usage:
        lines.append(f"\n**图鉴**：{item_usage}")
    if item_desc:
        lines.append(f"\n> {item_desc}")
    if item_obtain:
        lines.append(f"\n**获取方式**：{item_obtain}")

    # Talents — show the highest-unlock candidate for each talent slot
    talents: list[Any] = info.get("talents") or []
    if talents:
        lines.append("\n## 天赋")
        for talent in talents:
            candidates: list[Any] = talent.get("candidates") or []
            # Pick last candidate with a real name
            chosen = None
            for c in reversed(candidates):
                if c.get("name") and c["name"] not in ("？？？",):
                    chosen = c
                    break
            if chosen:
                t_name: str = chosen.get("name", "")
                t_desc: str = strip_wikitext(chosen.get("description", ""))
                lines.append(f"- **{t_name}**：{t_desc}")

    return "\n".join(lines)
