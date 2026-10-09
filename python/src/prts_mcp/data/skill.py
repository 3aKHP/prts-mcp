"""Combat-skill (战斗技能) data reader — skill_table.json backed.

Mirrors ts/src/data/skill.ts. Joins ``character_table.json`` skill refs
against ``skill_table.json`` per-level entries and renders level
descriptions by substituting blackboard placeholders (``{key}`` plain and
``{key:0%}`` .NET-style formats). Depends on operator's shared accessors;
operator never imports this module, so the top-level import is cycle-free.
"""
from __future__ import annotations

import re as _re
from dataclasses import dataclass
from typing import Any

from prts_mcp.activation import register_activation_listener
from prts_mcp.config import Config
from prts_mcp.data.dataset_access import (
    DatasetSpec,
    LoaderSpec,
    define_dataset,
    excel_store,
)
from prts_mcp.data.messages import (
    excel_missing_message,
    regex_error_message,
    validate_bounds,
)
from prts_mcp.data.operator import (
    _build_name_to_id,
    _load_character_table,
    resolve_char_id,
)
from prts_mcp.utils.numbers import round_half_away
from prts_mcp.utils.sanitizer import strip_wikitext

_SKILL_TYPE_ZH: dict[str, str] = {
    "MANUAL": "手动",
    "AUTO": "自动",
    "PASSIVE": "被动",
}

_SP_TYPE_ZH: dict[str, str] = {
    "INCREASE_WITH_TIME": "自动回复",
    "INCREASE_WHEN_ATTACK": "攻击回复",
    "INCREASE_WHEN_TAKEN_DAMAGE": "受击回复",
}


def _get_config() -> Config:
    return Config.load()


def _load_json(filename: str) -> dict[str, Any]:
    store = excel_store()
    if not store.exists(filename):
        raise FileNotFoundError(
            f"战斗技能数据文件不存在：{store.root / filename}。"
            "数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向游戏数据根目录）。"
        )
    return store.read_json(filename)


_access = define_dataset(DatasetSpec(
    name="skill",
    loaders={
        "skill_table": LoaderSpec(
            load=lambda: _load_json("skill_table.json"),
            count=lambda r: len(r) if isinstance(r, dict) else 0,
        ),
        "skill_search_records": LoaderSpec(load=lambda: _skill_search_records_impl()),
    },
    store=excel_store,
    available=lambda: _get_config().has_operator_data,
    missing_message=excel_missing_message("战斗技能"),
))

_load_skill_table = _access.cached("skill_table")
_skill_search_records = _access.cached("skill_search_records")


def clear_skill_caches() -> None:
    """Clear lazy table caches after synced game data changes on disk."""
    _access.clear()


register_activation_listener(clear_skill_caches)


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count}}`` for instrumentation."""
    return _access.stats()


# ---------------------------------------------------------------------------
# Blackboard placeholder rendering
# ---------------------------------------------------------------------------

# Placeholder formats observed across all 1795 skill_table entries (closed
# set as of the 2.8.0 scan): "", "0", "0.0", "0%", "0.0%".
_PLACEHOLDER_RE = _re.compile(r"\{([^{}:]+)(?::([^{}]*))?\}")
_KNOWN_FORMAT_RE = _re.compile(r"^0(?:\.0+)?%?$")


def format_placeholder_value(value: float, fmt: str) -> str | None:
    """Render a blackboard value under a .NET-style format suffix.

    Returns ``None`` for formats outside the observed closed set so the
    caller keeps the literal ``{token}`` (fail-open against upstream
    format drift).
    """
    if fmt == "":
        if float(value).is_integer():
            return str(int(value))
        return f"{value:.6f}".rstrip("0").rstrip(".")
    if not _KNOWN_FORMAT_RE.match(fmt):
        return None
    percent = fmt.endswith("%")
    if percent:
        fmt = fmt[:-1]
        value = value * 100
    decimals = len(fmt.split(".", 1)[1]) if "." in fmt else 0
    rendered = f"{round_half_away(float(value), decimals):.{decimals}f}"
    return rendered + "%" if percent else rendered


def render_skill_description(
    description: str,
    blackboard: list[dict[str, Any]] | None,
) -> str:
    """Substitute ``{key}`` / ``{key:fmt}`` placeholders, then strip markup.

    Placeholders whose key is absent from the level's blackboard stay
    literal (upstream constants like ``ABILITY_RANGE_FORWARD_EXTEND``).
    A leading ``-`` in the key negates the positive twin's value — the
    table's convention for debuffs (``-{-def}`` with ``def: -330``).
    """
    values: dict[str, dict[str, Any]] = {}
    for entry in blackboard or []:
        key = entry.get("key")
        if key:
            values[key] = entry

    def _sub(match: _re.Match[str]) -> str:
        token, key = match.group(0), match.group(1)
        fmt = match.group(2) or ""
        negated = key.startswith("-")
        entry = values.get(key[1:] if negated else key)
        if entry is None:
            return token
        if entry.get("valueStr") is not None:
            # Negation only applies to numeric values; a string twin of a
            # minus key has no defined rendering — keep the literal token.
            return token if negated else str(entry["valueStr"])
        value = entry.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return token
        if negated:
            value = -float(value)
        rendered = format_placeholder_value(float(value), fmt)
        return rendered if rendered is not None else token

    return strip_wikitext(_PLACEHOLDER_RE.sub(_sub, description or ""))


# ---------------------------------------------------------------------------
# Per-operator payload (get_operator_skills)
# ---------------------------------------------------------------------------


def _skill_levels(entry: dict[str, Any]) -> list[dict[str, Any]]:
    """Project one skill_table entry into per-level payloads.

    skill_table level entries carry no explicit ``level`` field — the level
    is the 1-based array index (levels[0] is Lv1, levels[9] is mastery 3).
    """
    levels: list[dict[str, Any]] = []
    for idx, lv in enumerate(entry.get("levels") or [], start=1):
        if not isinstance(lv, dict):
            continue
        sp = lv.get("spData")
        if not isinstance(sp, dict):
            sp = {}
        skill_type_raw = lv.get("skillType") or ""
        # Real passives carry spType as the JSON integer 8 (a "no SP
        # recovery" sentinel), not a string — non-string spTypes render
        # as empty rather than leaking the raw value into payloads.
        sp_type_raw = sp.get("spType")
        if not isinstance(sp_type_raw, str):
            sp_type_raw = ""
        duration_type_raw = lv.get("durationType") or ""
        levels.append({
            "level": idx,
            "name": lv.get("name") or "",
            "skill_type": _SKILL_TYPE_ZH.get(skill_type_raw, skill_type_raw),
            "skill_type_raw": skill_type_raw,
            "sp_type": _SP_TYPE_ZH.get(sp_type_raw, sp_type_raw),
            "sp_cost": sp.get("spCost"),
            "init_sp": sp.get("initSp"),
            "max_charge_time": sp.get("maxChargeTime"),
            "duration": lv.get("duration"),
            "duration_type": duration_type_raw,
            "description": render_skill_description(
                lv.get("description") or "", lv.get("blackboard"),
            ),
        })
    return levels


def build_operator_skills(name: str) -> dict | str:
    """Build the per-operator combat-skill payload, or an error message."""
    if not _get_config().has_operator_data:
        return _access.missing_message()

    char_id = resolve_char_id(name)
    if char_id is None:
        return f"未找到干员 '{name}'。请使用游戏内中文名称（如'阿米娅'）。"

    info = (_load_character_table() or {}).get(char_id) or {}

    try:
        table = _load_skill_table()
    except (FileNotFoundError, OSError, ValueError) as exc:
        # Same tolerate-family as operator.py's building-skills guard:
        # corrupt JSON (JSONDecodeError is a ValueError) and wrong-shape
        # roots degrade to a message instead of a raw traceback.
        return str(exc)
    if not isinstance(table, dict):
        return "skill_table.json 顶层不是 JSON 对象。"

    skills: list[dict[str, Any]] = []
    for ref in info.get("skills") or []:
        skill_id = (ref or {}).get("skillId") if isinstance(ref, dict) else None
        if not skill_id:
            continue
        entry = table.get(skill_id)
        if not isinstance(entry, dict):
            continue
        levels = _skill_levels(entry)
        if not levels:
            continue
        skills.append({
            "skill_id": skill_id,
            "name": levels[-1].get("name") or levels[0].get("name", ""),
            "levels": levels,
        })

    if not skills:
        return f"干员 '{name}' 暂无战斗技能数据。"
    return {"name": name, "char_id": char_id, "skills": skills}


_LEVEL_LABELS: dict[int, str] = {8: "专一", 9: "专二", 10: "专三"}


def _level_label(level: Any) -> str:
    try:
        numeric = int(level)
    except (TypeError, ValueError):
        return "Lv-"
    return _LEVEL_LABELS.get(numeric, f"Lv{numeric}")


def _plain_number(value: Any) -> str:
    rendered = format_placeholder_value(float(value), "")
    return rendered if rendered is not None else str(value)


def _level_suffix(level: dict[str, Any]) -> str:
    parts: list[str] = []
    sp_cost = level.get("sp_cost")
    if level.get("skill_type_raw") != "PASSIVE" and sp_cost is not None:
        parts.append(f"SP {sp_cost}")
        if level.get("init_sp"):
            parts.append(f"初始 {level['init_sp']}")
        charge = level.get("max_charge_time")
        if isinstance(charge, int) and charge > 1:
            parts.append(f"可充能 {charge} 次")
    duration = level.get("duration")
    # -1 is the table's "no duration" sentinel (instant / on-next-attack
    # skills and passives); only positive durations render.
    if isinstance(duration, (int, float)) and not isinstance(duration, bool) and duration > 0:
        if level.get("duration_type") == "AMMO":
            parts.append(f"弹药 {_plain_number(duration)} 发")
        else:
            parts.append(f"持续 {_plain_number(duration)} 秒")
    return f"（{'，'.join(parts)}）" if parts else ""


def render_operator_skills(data: dict) -> str:
    """Render an operator combat-skill payload to markdown."""
    lines = [f"# {data['name']} - 战斗技能"]
    for skill in data["skills"]:
        top = skill["levels"][-1]
        heading = skill["name"]
        if top.get("skill_type"):
            heading += f"（{top['skill_type']}"
            if top.get("sp_type"):
                heading += f"，{top['sp_type']}"
            heading += "）"
        lines.append(f"\n## {heading}")
        for level in skill["levels"]:
            lines.append(
                f"- **{_level_label(level.get('level'))}**："
                f"{level['description']}{_level_suffix(level)}"
            )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Cross-operator search (search tool's skills scope)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _SkillSearchRecord:
    operator: str
    skill: str
    text: str
    haystack: str


def _skill_search_records_impl() -> tuple[_SkillSearchRecord, ...]:
    try:
        table = _load_skill_table()
    except FileNotFoundError:
        # Older user-supplied data roots may lack skill_table.json; the
        # scope then reports no matches rather than a data error.
        return ()
    if not isinstance(table, dict):
        raise ValueError("skill_table.json 顶层不是 JSON 对象")

    ct = _load_character_table() or {}
    records: list[_SkillSearchRecord] = []
    for op_name, char_id in _build_name_to_id().items():
        info = ct.get(char_id) or {}
        for ref in info.get("skills") or []:
            skill_id = (ref or {}).get("skillId") if isinstance(ref, dict) else None
            entry = table.get(skill_id) if skill_id else None
            if not isinstance(entry, dict):
                continue
            levels = _skill_levels(entry)
            if not levels:
                continue
            top = levels[-1]
            records.append(_SkillSearchRecord(
                operator=op_name,
                skill=top.get("name") or levels[0].get("name", ""),
                text=top.get("description", ""),
                haystack=" ".join(
                    f"{lv.get('name') or ''} {lv.get('description') or ''}"
                    for lv in levels
                ),
            ))
    return tuple(records)


def build_skill_search(pattern: str, max_results: int = 30) -> dict | str:
    """Build the structured payload for combat-skill search."""
    if message := validate_bounds("max_results", max_results, minimum=1, maximum=100):
        return message

    if not _get_config().has_operator_data:
        return _access.missing_message()

    try:
        regex = _re.compile(pattern, _re.IGNORECASE)
    except _re.error as exc:
        return regex_error_message(exc)

    results: list[_SkillSearchRecord] = []
    try:
        records = _skill_search_records()
    except (FileNotFoundError, RuntimeError, TypeError, ValueError) as exc:
        # Same degrade-to-message contract as the sibling scopes.
        return _access.missing_message() + f"（{exc}）"
    for record in records:
        if regex.search(record.haystack):
            results.append(record)
            if len(results) >= max_results:
                break

    return {
        "scope": "skills",
        "pattern": pattern,
        "total": len(results),
        "results": [
            {
                "operator": r.operator,
                "skill": r.skill,
                "text": r.text,
            }
            for r in results
        ],
    }


def render_skill_search(data: dict) -> str:
    """Render a combat-skill search payload to markdown."""
    pattern = data["pattern"]
    results = data["results"]
    if not results:
        return f"未找到匹配 '{pattern}' 的干员战斗技能。"

    lines = [f"# 搜索 \"{pattern}\" 的结果（共 {data['total']} 条）"]
    for r in results:
        lines.append(f"- **{r['operator']}**｜{r['skill']}：{r['text']}")
    return "\n".join(lines)
