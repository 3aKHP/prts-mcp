from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from prts_mcp.config import Config
from prts_mcp.data.stores import DirectoryStore


def _get_config() -> Config:
    return Config.load()


def clear_enemy_caches() -> None:
    _load_enemy_handbook.cache_clear()
    _load_enemy_database.cache_clear()
    _build_enemy_name_to_id.cache_clear()
    _enemy_search_records.cache_clear()


_HANDBOOK_FILE = "enemy_handbook_table.json"
_DATABASE_FILE = "enemy_database.json"


@dataclass(frozen=True)
class _EnemySearchRecord:
    info: dict[str, Any]
    search_text: str


def _missing_data_message() -> str:
    config = _get_config()
    return (
        "敌人图鉴数据暂不可用。"
        "容器启动时的 auto-sync 可能仍在进行中，请稍后重试；"
        "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。"
        f"（当前同步目标路径：{config.excel_path}）"
    )


def _store() -> DirectoryStore:
    ep = _get_config().effective_excel_path
    assert ep is not None
    return DirectoryStore(ep)


def _has_enemy_data() -> bool:
    cfg = _get_config()
    if cfg.effective_excel_path is None:
        return False
    return _store().exists(_HANDBOOK_FILE)


def _database_store() -> DirectoryStore:
    """Return a store rooted at levels/enemydata/ for enemy_database.json."""
    lp = _get_config().effective_levels_path
    assert lp is not None
    db_root = lp / "zh_CN" / "gamedata" / "levels" / "enemydata"
    return DirectoryStore(db_root)


def _has_database() -> bool:
    cfg = _get_config()
    if cfg.effective_levels_path is None:
        return False
    return _database_store().exists(_DATABASE_FILE)


def _m_value(obj: Any, default: Any = None) -> Any:
    """Unwrap {m_defined, m_value} if present, else return as-is."""
    if isinstance(obj, dict) and "m_value" in obj:
        return obj["m_value"]
    return obj if obj is not None else default


@lru_cache(maxsize=1)
def _load_enemy_handbook() -> dict[str, Any]:
    store = _store()
    if not store.exists(_HANDBOOK_FILE):
        raise FileNotFoundError(
            f"敌人图鉴数据文件不存在：{store.root / _HANDBOOK_FILE}。"
        )
    return store.read_json(_HANDBOOK_FILE)


@lru_cache(maxsize=1)
def _load_enemy_database() -> dict[str, Any] | None:
    """Load enemy_database.json. Returns None when the file is absent.

    Note: lru_cache is acceptable here because the sync hook in server.py
    calls clear_enemy_caches() after a successful sync, invalidating both
    the None and the populated cache.
    """
    if not _has_database():
        return None
    store = _database_store()
    raw = store.read_json(_DATABASE_FILE)
    # Build enemyId → first-level-enemyData lookup
    index: dict[str, dict] = {}
    for entry in raw.get("enemies", []):
        key = entry.get("Key", "")
        values = entry.get("Value", [])
        if values and key:
            index[key] = values[0].get("enemyData", {})
    return {"_index": index}


@lru_cache(maxsize=1)
def _build_enemy_name_to_id() -> dict[str, str]:
    raw = _load_enemy_handbook()
    ed = raw.get("enemyData", {})
    return {info["name"]: eid for eid, info in ed.items() if info.get("name")}


def _resolve_enemy_id(name: str) -> str | None:
    mapping = _build_enemy_name_to_id()
    return mapping.get(name)


# ---------------------------------------------------------------------------
# Format helpers
# ---------------------------------------------------------------------------

_ENEMY_LEVEL_ZH: dict[str, str] = {
    "BOSS": "领袖",
    "ELITE": "精英",
    "NORMAL": "普通",
}

_DAMAGE_TYPE_ZH: dict[str, str] = {
    "PHYSIC": "物理",
    "MAGIC": "法术",
    "HEAL": "治疗",
}

_IMMUNITY_LABELS: dict[str, str] = {
    "stunImmune": "眩晕",
    "silenceImmune": "沉默",
    "sleepImmune": "睡眠",
    "frozenImmune": "冻结",
    "levitateImmune": "浮空",
    "disarmedCombatImmune": "缴械",
    "fearedImmune": "恐惧",
    "palsyImmune": "瘫痪",
    "attractImmune": "牵引",
}


def _fmt_enemy(info: dict, include_id: bool = False) -> str:
    lines: list[str] = []
    name = info.get("name", "")
    if name:
        lines.append(f"# {name} - 敌人图鉴\n")
        if include_id:
            lines.append(f"- **ID**：{info.get('enemyId', '')}")

    enemy_index = info.get("enemyIndex", "")
    if enemy_index:
        lines.append(f"- **编号**：{enemy_index}")

    level = info.get("enemyLevel", "")
    level_zh = _ENEMY_LEVEL_ZH.get(level, level)
    if level_zh:
        lines.append(f"- **威胁等级**：{level_zh}")

    desc = info.get("description", "")
    if desc:
        lines.append(f"- **描述**：{desc}")

    attack = info.get("attackType") or ""
    if attack:
        lines.append(f"- **攻击方式**：{attack}")

    ability = info.get("ability") or ""
    if ability:
        lines.append(f"- **特殊能力**：{ability}")

    damage_types: list[str] = info.get("damageType") or []
    if damage_types:
        dt_zh = "、".join(_DAMAGE_TYPE_ZH.get(dt, dt) for dt in damage_types)
        lines.append(f"- **伤害类型**：{dt_zh}")

    enemy_tags: list[str] = info.get("enemyTags") or []
    if enemy_tags:
        lines.append(f"- **标签**：{'、'.join(enemy_tags)}")

    return "\n".join(lines)


def _fmt_stats(db_entry: dict | None) -> str:
    """Format combat stats from enemy_database.json."""
    if db_entry is None:
        return ""

    attrs: dict = db_entry.get("attributes", {})
    hp = _m_value(attrs.get("maxHp"), 0)
    atk = _m_value(attrs.get("atk"), 0)
    defense = _m_value(attrs.get("def"), 0)
    res = _m_value(attrs.get("magicResistance"))
    speed = _m_value(attrs.get("moveSpeed"), 0.0)
    atk_time = _m_value(attrs.get("baseAttackTime"), 0.0)
    atk_speed = _m_value(attrs.get("attackSpeed"), 100.0)
    mass = _m_value(attrs.get("massLevel"), 0)
    hp_recovery = _m_value(attrs.get("hpRecoveryPerSec"), 0.0)

    lines: list[str] = []
    lines.append("\n## 战斗属性")
    if hp:
        lines.append(f"- **最大生命**：{hp:,}")
    if atk:
        lines.append(f"- **攻击力**：{atk}")
    if defense:
        lines.append(f"- **防御力**：{defense}")
    if res is not None:
        lines.append(f"- **法术抗性**：{res}")
    if speed:
        lines.append(f"- **移动速度**：{speed}")
    if atk_time:
        lines.append(f"- **攻击间隔**：{atk_time}s")
    if atk_speed != 100.0:
        lines.append(f"- **攻击速度**：{atk_speed}")
    if mass:
        lines.append(f"- **重量等级**：{mass}")
    if hp_recovery:
        lines.append(f"- **每秒生命回复**：{hp_recovery}")

    # Immunities
    immunities = []
    for key, label in _IMMUNITY_LABELS.items():
        if _m_value(attrs.get(key), False):
            immunities.append(label)
    if immunities:
        lines.append(f"- **免疫**：{'、'.join(immunities)}")

    # Life point reduction
    lpr = _m_value(attrs.get("lifePointReduce"), 0)
    if lpr:
        lines.append(f"- **生命值扣除**：{lpr}")

    # Skills
    skills: list[dict] = db_entry.get("skills") or []
    if skills:
        lines.append("\n## 技能")
        for s in skills:
            prefab = s.get("prefabKey", "未知")
            cooldown = s.get("cooldown", "")
            sp_cost = _m_value(s.get("spData", {}).get("spCost") if s.get("spData") else None, None)
            init_cd = s.get("initCooldown", "")

            parts = [f"- **{prefab}**"]
            cd_parts = []
            if cooldown:
                cd_parts.append(f"冷却 {cooldown}s")
            if init_cd and init_cd != cooldown:
                cd_parts.append(f"初始 {init_cd}s")
            if sp_cost:
                cd_parts.append(f"SP {sp_cost}")
            if cd_parts:
                parts.append(f"（{'，'.join(cd_parts)}）")

            # Blackboard params
            blackboard: list[dict] = s.get("blackboard", [])
            if blackboard:
                bb_strs = []
                for b in blackboard[:6]:
                    key = b.get("key", "")
                    val = b.get("value", "")
                    if val is not None:
                        bb_strs.append(f"{key}={val}")
                if bb_strs:
                    parts.append(": " + "，".join(bb_strs))
            lines.append("".join(parts))

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_enemies(
    threat_level: str | None = None,
    limit: int = 50,
    offset: int = 0,
    full: bool = False,
) -> str:
    """List enemies with optional filtering and pagination.

    Args:
        threat_level: Filter by BOSS / ELITE / NORMAL.
        limit: Max entries to return (ignored when full=True).
        offset: Pagination offset.
        full: Return ALL entries. Discouraged for normal use.
    """
    if not _has_enemy_data():
        return _missing_data_message()

    if limit < 1:
        return f"无效的 limit 参数：{limit}，需 ≥ 1。"
    if offset < 0:
        return f"无效的 offset 参数：{offset}，需 ≥ 0。"

    try:
        raw = _load_enemy_handbook()
    except FileNotFoundError as exc:
        return str(exc)

    ed = raw.get("enemyData", {})
    if not ed:
        return "敌人图鉴数据为空。"

    entries = [
        (eid, info)
        for eid, info in ed.items()
        if not info.get("hideInHandbook") and info.get("name")
    ]

    if threat_level:
        level_filter = threat_level.upper()
        if level_filter not in _ENEMY_LEVEL_ZH:
            return f"无效的 threat_level 参数：{threat_level!r}，可选值：boss、elite、normal。"
        entries = [(e, i) for e, i in entries
                   if i.get("enemyLevel", "").upper() == level_filter]

    entries.sort(key=lambda x: (x[1].get("sortId", 9999), x[0]))
    total = len(entries)

    if not full and offset >= total and total > 0:
        return f"# 敌人图鉴（共 {total} 个）\n\noffset={offset} 超出范围（总计 {total} 条）。"

    if full:
        displayed = entries
    else:
        displayed = entries[offset:offset + limit]

    header = f"# 敌人图鉴（共 {total} 个）\n"
    for _eid, info in displayed:
        level = info.get("enemyLevel", "")
        level_zh = _ENEMY_LEVEL_ZH.get(level, level)
        index = info.get("enemyIndex", "")
        name = info.get("name", "")
        desc = (info.get("description") or "").replace("\n", " ")[:60]
        line = f"- **{name}** [{level_zh}] ({index})"
        if desc:
            line += f" — {desc}"
        header += line + "\n"

    if not full and total > offset + limit:
        header += f"\n（显示第 {offset+1}–{min(offset+limit, total)} 条，共 {total} 条。使用 offset={offset+limit} 查看下一页）"

    return header.strip()


def build_enemy_info(name: str) -> dict | str:
    """Build the structured payload for a single enemy's handbook + combat stats.

    Returns the dict payload on success, or a markdown error string on a
    missing-data / not-found path. The dict is the single source of truth
    that ``render_enemy_info`` consumes.
    """
    if not _has_enemy_data():
        return _missing_data_message()

    try:
        eid = _resolve_enemy_id(name)
    except FileNotFoundError as exc:
        return str(exc)
    if eid is None:
        return f"未找到敌人 '{name}'。请使用游戏内名称。"

    try:
        raw = _load_enemy_handbook()
    except FileNotFoundError as exc:
        return str(exc)

    ed = raw.get("enemyData", {})
    info = ed.get(eid)
    if info is None:
        return f"敌人 '{name}' 暂无详细信息。"

    # Handbook fields (with localization where applicable)
    level_raw = info.get("enemyLevel", "")
    damage_types_raw: list[str] = info.get("damageType") or []

    payload: dict[str, Any] = {
        "name": info.get("name", ""),
        "enemy_id": info.get("enemyId", ""),
        "enemy_index": info.get("enemyIndex", ""),
        "level_raw": level_raw,
        "level_label": _ENEMY_LEVEL_ZH.get(level_raw, level_raw),
        "description": info.get("description", ""),
        "attack_type": info.get("attackType") or "",
        "ability": info.get("ability") or "",
        "damage_types_raw": damage_types_raw,
        "damage_types_label": "、".join(
            _DAMAGE_TYPE_ZH.get(dt, dt) for dt in damage_types_raw
        ),
        "enemy_tags": info.get("enemyTags") or [],
        "stats": None,
    }

    # Combat stats from enemy_database.json
    db = _load_enemy_database()
    db_entry = db["_index"].get(eid) if db else None
    if db_entry:
        payload["stats"] = _extract_enemy_stats(db_entry)

    return payload


def _extract_enemy_stats(db_entry: dict) -> dict:
    """Extract combat stats from an enemy_database entry into a structured dict.

    Mirrors the rendering decisions of ``_fmt_stats`` so render_enemy_info
    can reproduce its output exactly: numeric values are formatted the same
    way (e.g. HP with thousands separator), and only non-default fields are
    included.
    """
    attrs: dict = db_entry.get("attributes", {})
    hp = _m_value(attrs.get("maxHp"), 0)
    atk = _m_value(attrs.get("atk"), 0)
    defense = _m_value(attrs.get("def"), 0)
    res = _m_value(attrs.get("magicResistance"))
    speed = _m_value(attrs.get("moveSpeed"), 0.0)
    atk_time = _m_value(attrs.get("baseAttackTime"), 0.0)
    atk_speed = _m_value(attrs.get("attackSpeed"), 100.0)
    mass = _m_value(attrs.get("massLevel"), 0)
    hp_recovery = _m_value(attrs.get("hpRecoveryPerSec"), 0.0)

    immunities = []
    for key, label in _IMMUNITY_LABELS.items():
        if _m_value(attrs.get(key), False):
            immunities.append(label)
    lpr = _m_value(attrs.get("lifePointReduce"), 0)

    stats: dict[str, Any] = {
        "max_hp": f"{hp:,}" if hp else None,
        "atk": str(atk) if atk else None,
        "def": str(defense) if defense else None,
        "resistance": str(res) if res is not None else None,
        "move_speed": str(speed) if speed else None,
        "attack_interval": f"{atk_time}s" if atk_time else None,
        "attack_speed": str(atk_speed) if atk_speed != 100.0 else None,
        "mass_level": str(mass) if mass else None,
        "hp_recovery_per_sec": str(hp_recovery) if hp_recovery else None,
        "immunities": immunities,
        "life_point_reduce": str(lpr) if lpr else None,
    }

    skills: list[dict] = []
    for s in db_entry.get("skills") or []:
        prefab = s.get("prefabKey", "未知")
        cooldown = s.get("cooldown", "")
        sp_cost = _m_value(s.get("spData", {}).get("spCost") if s.get("spData") else None, None)
        init_cd = s.get("initCooldown", "")

        cd_parts = []
        if cooldown:
            cd_parts.append(f"冷却 {cooldown}s")
        if init_cd and init_cd != cooldown:
            cd_parts.append(f"初始 {init_cd}s")
        if sp_cost:
            cd_parts.append(f"SP {sp_cost}")
        timing = "，".join(cd_parts) if cd_parts else ""

        blackboard: list[dict] = s.get("blackboard", [])
        bb_strs = []
        for b in blackboard[:6]:
            key = b.get("key", "")
            val = b.get("value", "")
            if val is not None:
                bb_strs.append(f"{key}={val}")
        bb = "，".join(bb_strs)

        skills.append({"prefab": prefab, "timing": timing, "blackboard": bb})

    stats["skills"] = skills
    return stats


def render_enemy_info(data: dict) -> str:
    """Render an enemy-info payload dict to markdown.

    Pure renderer; the inverse of ``build_enemy_info``'s success path.
    """
    lines: list[str] = []
    name = data["name"]
    if name:
        lines.append(f"# {name} - 敌人图鉴\n")
        lines.append(f"- **ID**：{data['enemy_id']}")

    enemy_index = data["enemy_index"]
    if enemy_index:
        lines.append(f"- **编号**：{enemy_index}")

    level_label = data["level_label"]
    if level_label:
        lines.append(f"- **威胁等级**：{level_label}")

    desc = data["description"]
    if desc:
        lines.append(f"- **描述**：{desc}")

    attack = data["attack_type"]
    if attack:
        lines.append(f"- **攻击方式**：{attack}")

    ability = data["ability"]
    if ability:
        lines.append(f"- **特殊能力**：{ability}")

    dt_label = data["damage_types_label"]
    if dt_label:
        lines.append(f"- **伤害类型**：{dt_label}")

    enemy_tags = data["enemy_tags"]
    if enemy_tags:
        lines.append(f"- **标签**：{'、'.join(enemy_tags)}")

    stats = data["stats"]
    if stats:
        # No leading \n here: "\n".join supplies the separator between the
        # handbook block and this section (single newline, matching the old
        # `result += _fmt_stats()` concatenation). The "## 技能" heading below
        # keeps its leading \n to reproduce the original blank line there.
        lines.append("## 战斗属性")
        for field, label in (
            ("max_hp", "最大生命"),
            ("atk", "攻击力"),
            ("def", "防御力"),
            ("resistance", "法术抗性"),
            ("move_speed", "移动速度"),
            ("attack_interval", "攻击间隔"),
            ("attack_speed", "攻击速度"),
            ("mass_level", "重量等级"),
            ("hp_recovery_per_sec", "每秒生命回复"),
        ):
            val = stats.get(field)
            if val:
                lines.append(f"- **{label}**：{val}")
        immunities = stats["immunities"]
        if immunities:
            lines.append(f"- **免疫**：{'、'.join(immunities)}")
        lpr = stats["life_point_reduce"]
        if lpr:
            lines.append(f"- **生命值扣除**：{lpr}")

        skills = stats["skills"]
        if skills:
            lines.append("\n## 技能")
            for s in skills:
                parts = [f"- **{s['prefab']}**"]
                if s["timing"]:
                    parts.append(f"（{s['timing']}）")
                if s["blackboard"]:
                    parts.append(": " + s["blackboard"])
                lines.append("".join(parts))

    return "\n".join(lines)


def get_enemy_info(name: str) -> str:
    """Return full info for a single enemy, with combat stats from database."""
    data = build_enemy_info(name)
    if isinstance(data, str):
        return data
    return render_enemy_info(data)


def search_enemies(pattern: str, max_results: int = 30) -> str:
    """Regex search across enemy names and descriptions."""
    if not _has_enemy_data():
        return _missing_data_message()
    if max_results < 1:
        return "max_results 必须 >= 1。"
    if max_results > 100:
        return "max_results 必须 <= 100。"

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return f"正则表达式无效：{exc}"

    matches: list[dict] = []
    try:
        records = _enemy_search_records()
    except FileNotFoundError as exc:
        return str(exc)
    for record in records:
        if regex.search(record.search_text):
            matches.append(record.info)
        if len(matches) >= max_results:
            break

    if not matches:
        return f"未找到匹配 '{pattern}' 的敌人。"

    lines: list[str] = [f"# 搜索结果：{pattern}（共 {len(matches)} 个）\n"]
    for info in matches:
        lines.append(_fmt_enemy(info))
        lines.append("")
    return "\n".join(lines).strip()


@lru_cache(maxsize=1)
def _enemy_search_records() -> tuple[_EnemySearchRecord, ...]:
    raw = _load_enemy_handbook()
    ed = raw.get("enemyData", {})
    records: list[_EnemySearchRecord] = []
    for _eid, info in ed.items():
        if info.get("hideInHandbook"):
            continue
        search_text = " ".join([
            info.get("name") or "",
            info.get("description") or "",
            info.get("ability") or "",
            " ".join(info.get("enemyTags") or []),
        ])
        records.append(_EnemySearchRecord(info=info, search_text=search_text))
    return tuple(records)
