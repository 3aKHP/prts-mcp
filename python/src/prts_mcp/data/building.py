"""Base-skill (基建技能) data reader — building_data.json backed.

Mirrors ts/src/data/building.ts. Deliberately dependency-free beyond the
dataset-access layer: operator and search consume this module, so it must
not import them (cycle hygiene).
"""
from __future__ import annotations

import re as _re
from typing import Any

from prts_mcp.activation import register_activation_listener
from prts_mcp.config import Config
from prts_mcp.data.dataset_access import (
    DatasetSpec,
    LoaderSpec,
    define_dataset,
    excel_store,
)
from prts_mcp.data.messages import excel_missing_message

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
    },
    store=excel_store,
    available=lambda: _get_config().has_operator_data,
    missing_message=excel_missing_message("基建技能"),
))

_load_building_table = _access.cached("building_table")


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
