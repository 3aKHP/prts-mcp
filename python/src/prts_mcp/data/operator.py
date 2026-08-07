from __future__ import annotations

from typing import Any

from prts_mcp.config import Config, activation_aware_cache, cache_stat, register_activation_listener
from prts_mcp.data.stores import DirectoryStore
from prts_mcp.utils.sanitizer import strip_wikitext

def _get_config() -> Config:
    return Config.load()


def clear_operator_caches() -> None:
    """Clear lazy table caches after synced game data changes on disk."""
    _load_character_table.cache_clear()
    _load_handbook_table.cache_clear()
    _load_charword_table.cache_clear()
    _build_name_to_id.cache_clear()
    # Lazy import to break circular dependency (search imports from operator).
    try:
        from prts_mcp.data.search import clear_search_caches

        clear_search_caches()
    except ImportError:
        pass


register_activation_listener(clear_operator_caches)


def _missing_operator_data_message() -> str:
    config = _get_config()
    searched = str(config.excel_path)
    return (
        "干员数据暂不可用。"
        "容器启动时的 auto-sync 可能仍在进行中，请稍后重试；"
        "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。"
        f"（当前同步目标路径：{searched}）"
    )


def _operator_store() -> DirectoryStore:
    ep = _get_config().effective_excel_path
    assert ep is not None
    return DirectoryStore(ep)


def _load_json(filename: str) -> dict[str, Any]:
    store = _operator_store()
    if not store.exists(filename):
        raise FileNotFoundError(
            f"干员数据文件不存在：{store.root / filename}。"
            "数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向游戏数据根目录）。"
        )
    return store.read_json(filename)


@activation_aware_cache(maxsize=1)
def _load_character_table() -> dict[str, Any]:
    return _load_json("character_table.json")


@activation_aware_cache(maxsize=1)
def _load_handbook_table() -> dict[str, Any]:
    return _load_json("handbook_info_table.json")


@activation_aware_cache(maxsize=1)
def _load_charword_table() -> dict[str, Any]:
    return _load_json("charword_table.json")


@activation_aware_cache(maxsize=1)
def _build_name_to_id() -> dict[str, str]:
    """Map operator Chinese name -> charId."""
    ct = _load_character_table()
    return {info["name"]: cid for cid, info in ct.items()
            if info.get("name") and cid.startswith("char_")}


def resolve_char_id(name: str) -> str | None:
    mapping = _build_name_to_id()
    return mapping.get(name)


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count}}`` for instrumentation (#104)."""
    return {
        "character_table": cache_stat(_load_character_table),
        "handbook_table": cache_stat(
            _load_handbook_table, lambda r: len(r.get("handbookDict") or {})
        ),
        "charword_table": cache_stat(
            _load_charword_table, lambda r: len(r.get("charWords") or {})
        ),
        "name_to_id": cache_stat(_build_name_to_id),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_operator_archives(name: str) -> str:
    """Return formatted archive text for an operator by Chinese name."""
    if not _get_config().has_operator_data:
        return _missing_operator_data_message()

    try:
        char_id = resolve_char_id(name)
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
        char_id = resolve_char_id(name)
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


def build_operator_basic_info(name: str) -> dict | str:
    """Build the structured payload for an operator's basic profile.

    Returns the dict payload on success, or a markdown error string on a
    missing-data / not-found path. The dict is the single source of truth
    that ``render_operator_basic_info`` consumes.
    """
    if not _get_config().has_operator_data:
        return _missing_operator_data_message()

    try:
        char_id = resolve_char_id(name)
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

    nation_id: str = info.get("nationId") or ""
    group_id: str = info.get("groupId") or ""
    team_id: str = info.get("teamId") or ""
    affiliation_parts = [x for x in [nation_id, group_id, team_id] if x]
    affiliation = " / ".join(affiliation_parts) if affiliation_parts else "-"

    # Talents — show the highest-unlock candidate for each talent slot
    chosen_talents: list[dict[str, str]] = []
    talents: list[Any] = info.get("talents") or []
    for talent in talents:
        candidates: list[Any] = talent.get("candidates") or []
        # Pick last candidate with a real name
        chosen = None
        for c in reversed(candidates):
            if c.get("name") and c["name"] not in ("？？？",):
                chosen = c
                break
        if chosen:
            chosen_talents.append(
                {
                    "name": chosen.get("name", ""),
                    "description": strip_wikitext(chosen.get("description", "")),
                }
            )

    return {
        "name": name,
        "display_number": info.get("displayNumber", ""),
        "appellation": info.get("appellation", ""),
        "rarity": rarity,
        "rarity_raw": rarity_raw,
        "profession": profession,
        "profession_raw": profession_raw,
        "sub_profession_id": info.get("subProfessionId", ""),
        "position": position,
        "position_raw": position_raw,
        "affiliation": affiliation,
        "tag_list": info.get("tagList") or [],
        # Guard on the RAW description's presence (not the stripped value):
        # the original code emitted "- **攻击属性**：<stripped>" whenever the
        # raw field was truthy, even if stripping yielded "". Keep that
        # behaviour by carrying None only when raw is empty.
        "attack_attribute": (
            strip_wikitext(info["description"])
            if info.get("description")
            else None
        ),
        "item_usage": info.get("itemUsage", "") or None,
        "item_desc": info.get("itemDesc", "") or None,
        "item_obtain": info.get("itemObtainApproach", "") or None,
        "talents": chosen_talents,
    }


def render_operator_basic_info(data: dict) -> str:
    """Render an operator basic-info payload dict to markdown.

    Pure renderer; the inverse of ``build_operator_basic_info``'s success
    path.
    """
    name = data["name"]
    lines: list[str] = [f"# {name} - 干员基本信息\n"]
    lines.append(f"- **编号**：{data['display_number']}")
    lines.append(f"- **英文名**：{data['appellation']}")
    lines.append(f"- **稀有度**：{data['rarity']}")
    lines.append(f"- **职业**：{data['profession']}（{data['sub_profession_id']}）")
    lines.append(f"- **站位**：{data['position']}")
    lines.append(f"- **所属**：{data['affiliation']}")
    tag_list = data["tag_list"]
    if tag_list:
        lines.append(f"- **招募标签**：{'、'.join(tag_list)}")
    attack = data["attack_attribute"]
    if attack is not None:
        lines.append(f"- **攻击属性**：{attack}")
    if data["item_usage"]:
        lines.append(f"\n**图鉴**：{data['item_usage']}")
    if data["item_desc"]:
        lines.append(f"\n> {data['item_desc']}")
    if data["item_obtain"]:
        lines.append(f"\n**获取方式**：{data['item_obtain']}")

    talents = data["talents"]
    if talents:
        lines.append("\n## 天赋")
        for t in talents:
            lines.append(f"- **{t['name']}**：{t['description']}")

    return "\n".join(lines)


def get_operator_basic_info(name: str) -> str:
    """Return basic profile info for an operator by Chinese name."""
    data = build_operator_basic_info(name)
    if isinstance(data, str):
        return data
    return render_operator_basic_info(data)
