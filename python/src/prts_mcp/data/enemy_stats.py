"""Enemy combat-stats extraction and m_defined override merging.

Extracted from ``data/enemy`` (``extract_enemy_stats``) and ``data/stage_enemy``
(``merge_defined`` / ``stage_specific_enemy_data`` / ``overwritten_enemy_name`` /
``format_stats``) in P3.A. Pure dict logic only — no store/config; callers pass
the shared dataset accessor's result (``levels``) so this module stays
side-effect-free. The TS mirror is ``ts/src/data/enemyStats.ts`` (which also
holds the TS-only Python-formatting shims).
"""
from __future__ import annotations

from typing import Any

from prts_mcp.data.gamedata_attrs import m_value

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


def extract_enemy_stats(db_entry: dict) -> dict:
    """Extract combat stats from an enemy_database entry into a structured dict.

    Numeric values are pre-formatted as render_enemy_info will emit them
    (e.g. HP with thousands separator), and only non-default fields are
    included.
    """
    attrs: dict = db_entry.get("attributes", {})
    hp = m_value(attrs.get("maxHp"), 0)
    atk = m_value(attrs.get("atk"), 0)
    defense = m_value(attrs.get("def"), 0)
    res = m_value(attrs.get("magicResistance"))
    speed = m_value(attrs.get("moveSpeed"), 0.0)
    atk_time = m_value(attrs.get("baseAttackTime"), 0.0)
    atk_speed = m_value(attrs.get("attackSpeed"), 100.0)
    mass = m_value(attrs.get("massLevel"), 0)
    hp_recovery = m_value(attrs.get("hpRecoveryPerSec"), 0.0)

    immunities = []
    for key, label in _IMMUNITY_LABELS.items():
        if m_value(attrs.get(key), False):
            immunities.append(label)
    lpr = m_value(attrs.get("lifePointReduce"), 0)

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
        sp_cost = m_value(s.get("spData", {}).get("spCost") if s.get("spData") else None, None)
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


def merge_defined(base: Any, override: Any) -> Any:
    """Merge enemyData dictionaries, applying only m_defined=true overrides."""
    if not isinstance(override, dict):
        return base
    if "m_defined" in override and "m_value" in override:
        return override["m_value"] if override.get("m_defined") else base
    if isinstance(base, dict):
        merged = dict(base)
    else:
        merged = {}
    for key, value in override.items():
        if isinstance(value, dict) and value.get("m_defined") is False:
            continue
        merged[key] = merge_defined(merged.get(key), value)
    return merged


def stage_specific_enemy_data(
    levels: dict[str, dict[int, dict[str, Any]]] | None,
    enemy_id: str,
    level: int,
    overwritten: Any = None,
) -> dict[str, Any] | None:
    """Resolve the effective enemyData for one enemy at one stage level.

    ``levels`` is the raw normalized enemy_database map (the shared dataset
    accessor's result); None/absent enemy falls back to the stage-overwritten
    data when it is dict-shaped.
    """
    db_entry = (levels or {}).get(enemy_id, {})
    base = db_entry.get(level) or db_entry.get(0)
    if base is None:
        return overwritten if isinstance(overwritten, dict) else None
    merged = merge_defined(base, overwritten)
    return merged if isinstance(merged, dict) else base


def overwritten_enemy_name(overwritten: Any) -> str | None:
    if not isinstance(overwritten, dict):
        return None
    name = overwritten.get("name") or overwritten.get("prefabKey")
    return str(m_value(name)) if name else None


def format_stats(enemy_data: dict[str, Any] | None) -> str:
    """One-line compact stat summary for stage-enemies listings."""
    if not enemy_data:
        return "无数据库记录"
    attrs = enemy_data.get("attributes") or {}
    hp = m_value(attrs.get("maxHp"), 0)
    atk = m_value(attrs.get("atk"), 0)
    defense = m_value(attrs.get("def"), 0)
    res = m_value(attrs.get("magicResistance"), 0)
    speed = m_value(attrs.get("moveSpeed"), 0)
    atk_time = m_value(attrs.get("baseAttackTime"), 0)
    parts = [
        f"HP {hp:,}" if isinstance(hp, int) else f"HP {hp}",
        f"ATK {atk}",
        f"DEF {defense}",
        f"RES {res}",
    ]
    if speed:
        parts.append(f"移速 {speed}")
    if atk_time:
        parts.append(f"攻击间隔 {atk_time}s")
    return "；".join(parts)
