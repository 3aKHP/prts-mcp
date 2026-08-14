"""Base-skill (基建技能) data reader — building_data.json backed.

Mirrors ts/src/data/building.ts. Deliberately dependency-free beyond the
dataset-access layer: operator imports this module, so it must not import
operator at module level (cycle hygiene) — the search-records builder
imports it lazily instead.
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

_ROOM_ZH: dict[str, str] = {
    "CONTROL": "控制中枢",
    "POWER": "发电站",
    "MANUFACTURE": "制造站",
    "TRADING": "贸易站",
    "WORKSHOP": "加工站",
    "TRAINING": "训练室",
    "DORMITORY": "宿舍",
    "HIRE": "人力办公室",
    "MEETING": "会客室",
}

_PHASE_ZH: dict[str, str] = {
    "PHASE_0": "精英0",
    "PHASE_1": "精英1",
    "PHASE_2": "精英2",
}


def _get_config() -> Config:
    return Config.load()


def _load_json(filename: str) -> dict[str, Any]:
    store = excel_store()
    if not store.exists(filename):
        raise FileNotFoundError(
            f"基建技能数据文件不存在：{store.root / filename}。"
            "数据目录可能为空，或挂载路径有误（GAMEDATA_PATH 应指向游戏数据根目录）。"
        )
    return store.read_json(filename)


_access = define_dataset(DatasetSpec(
    name="building",
    loaders={
        "building_table": LoaderSpec(
            load=lambda: _load_json("building_data.json"),
            count=lambda r: len(r.get("buffs") or {}),
        ),
        "building_skill_records": LoaderSpec(load=lambda: _building_skill_records_impl()),
    },
    store=excel_store,
    available=lambda: _get_config().has_operator_data,
    missing_message=excel_missing_message("基建技能"),
))

_load_building_table = _access.cached("building_table")
_building_skill_records = _access.cached("building_skill_records")


def clear_building_caches() -> None:
    """Clear lazy table caches after synced game data changes on disk."""
    _access.clear()


register_activation_listener(clear_building_caches)


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count}}`` for instrumentation."""
    return _access.stats()


def _clean_description(desc: str) -> str:
    """Strip game markup like ``<@cc.vup>`` and ``</>`` (stage.py twin)."""
    if not desc:
        return ""
    return _re.sub(r"<[^>]+>", "", desc).strip()


def _phase_rank(buff_data: dict[str, Any]) -> int:
    phase = (buff_data.get("cond") or {}).get("phase", "")
    try:
        return int(phase.replace("PHASE_", ""))
    except ValueError:
        return -1


def building_skills_for(char_id: str) -> list[dict[str, str]]:
    """Return an operator's base skills, highest phase per buff slot.

    Raises ``FileNotFoundError`` when building_data.json is absent (older
    user-supplied data roots); callers degrade gracefully.
    """
    table = _load_building_table()
    chars = table.get("chars") or {}
    buffs = table.get("buffs") or {}
    entry = chars.get(char_id) or {}
    skills: list[dict[str, str]] = []
    for slot in entry.get("buffChar") or []:
        # A slot's buffData lists per-elite-phase variants of the same
        # skill; keep only the highest phase (lower ones are weaker).
        best: dict[str, Any] | None = None
        for buff_data in slot.get("buffData") or []:
            if best is None or _phase_rank(buff_data) > _phase_rank(best):
                best = buff_data
        if best is None:
            continue
        buff = buffs.get(best.get("buffId", ""))
        if not buff:
            continue
        room_raw = buff.get("roomType", "")
        phase = (best.get("cond") or {}).get("phase", "")
        skills.append({
            "name": buff.get("buffName", ""),
            "room": _ROOM_ZH.get(room_raw, room_raw),
            "description": _clean_description(buff.get("description", "")),
            "unlock": _PHASE_ZH.get(phase, phase),
        })
    return skills


# ---------------------------------------------------------------------------
# Cross-operator search (search tool's building_skills scope)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _BuildingSkillRecord:
    operator: str
    skill: str
    room: str
    unlock: str
    text: str


def _building_skill_records_impl() -> tuple[_BuildingSkillRecord, ...]:
    # Lazy import to break the operator → building module cycle.
    from prts_mcp.data.operator import _build_name_to_id

    records: list[_BuildingSkillRecord] = []
    for name, char_id in _build_name_to_id().items():
        try:
            skills = building_skills_for(char_id)
        except FileNotFoundError:
            # Older user-supplied data roots may lack building_data.json;
            # the scope then reports no matches rather than a data error.
            return ()
        for s in skills:
            records.append(_BuildingSkillRecord(
                operator=name,
                skill=s["name"],
                room=s["room"],
                unlock=s["unlock"],
                text=s["description"],
            ))
    return tuple(records)


def build_building_skill_search(pattern: str, max_results: int = 30) -> dict | str:
    """Build the structured payload for base-skill search."""
    if message := validate_bounds("max_results", max_results, minimum=1, maximum=100):
        return message

    if not _get_config().has_operator_data:
        return _access.missing_message()

    try:
        regex = _re.compile(pattern, _re.IGNORECASE)
    except _re.error as exc:
        return regex_error_message(exc)

    results: list[_BuildingSkillRecord] = []
    try:
        records = _building_skill_records()
    except (FileNotFoundError, RuntimeError, TypeError) as exc:
        # Same degrade-to-message contract as the sibling scopes (item.py).
        return _access.missing_message() + f"（{exc}）"
    # Haystack = skill name + room + description; the unlock phase is
    # deliberately not searchable (it is a display attribute, not content).
    for record in records:
        if regex.search(f"{record.skill} {record.room} {record.text}"):
            results.append(record)
            if len(results) >= max_results:
                break

    return {
        "scope": "building_skills",
        "pattern": pattern,
        "total": len(results),
        "results": [
            {
                "operator": r.operator,
                "skill": r.skill,
                "room": r.room,
                "unlock": r.unlock,
                "text": r.text,
            }
            for r in results
        ],
    }


def render_building_skill_search(data: dict) -> str:
    """Render a base-skill search payload to markdown."""
    pattern = data["pattern"]
    results = data["results"]
    if not results:
        return f"未找到匹配 '{pattern}' 的干员基建技能。"

    lines = [f"# 搜索 \"{pattern}\" 的结果（共 {data['total']} 条）"]
    for r in results:
        lines.append(
            f"- **{r['operator']}**｜{r['skill']}"
            f"（{r['room']}，{r['unlock']}解锁）：{r['text']}"
        )
    return "\n".join(lines)
