from __future__ import annotations

import re as _re
from dataclasses import dataclass as _dataclass
from typing import Any

from prts_mcp.activation import register_activation_listener
from prts_mcp.config import Config as _Config
from prts_mcp.data.dataset_access import (
    DatasetSpec as _DatasetSpec,
    LoaderSpec as _LoaderSpec,
    define_dataset as _define_dataset,
    excel_store as _excel_store,
)
from prts_mcp.data.item import get_item_name_by_id as _get_item_name_by_id
from prts_mcp.data.messages import (
    excel_missing_message as _excel_missing_message,
    regex_error_message as _regex_error_message,
    validate_bounds as _validate_bounds,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_STAGE_FILE = "stage_table.json"
_ZONE_FILE = "zone_table.json"

_STAGE_TYPE_LABELS: dict[str, str] = {
    "MAIN": "主线",
    "ACTIVITY": "活动",
    "SUB": "支线",
    "DAILY": "每日",
    "CAMPAIGN": "剿灭",
    "CLIMB_TOWER": "爬塔",
    "SPECIAL_STORY": "特殊故事",
    "GUIDE": "教程",
}

_DIFFICULTY_LABELS: dict[str, str] = {
    "NORMAL": "普通",
    "FOUR_STAR": "突袭",
    "SIX_STAR": "六星",
}


@_dataclass(frozen=True)
class _StageSearchRecord:
    stage_id: str
    entry: dict
    search_text: str

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_config() -> _Config:
    return _Config.load()


def _has_stage_data() -> bool:
    cfg = _get_config()
    if cfg.effective_excel_path is None:
        return False
    return _excel_store().exists(_STAGE_FILE)


def _missing_data_message() -> str:
    return _access.missing_message()


def _stage_type_label(t: str) -> str:
    return _STAGE_TYPE_LABELS.get(t, t)


def _difficulty_label(d: str) -> str:
    return _DIFFICULTY_LABELS.get(d, d)


def _clean_description(desc: str) -> str:
    """Strip angle-bracket markup like <@lv.fs> and </>."""
    if not desc:
        return ""
    return _re.sub(r"<[^>]+>", "", desc).strip()


def _format_unlock(conditions: list) -> str:
    if not conditions:
        return "（无条件）"
    state_labels = {
        "PASS": lambda sid: f"通关 {sid}",
        "STAR_3": lambda sid: f"三星通关 {sid}",
    }
    parts: list[str] = []
    for c in conditions:
        sid = c.get("stageId", "?")
        cs = c.get("completeState", "")
        parts.append(state_labels.get(cs, lambda s: f"{cs} {s}")(sid))
    return "；".join(parts)


def _format_drops(drop_info: dict | None) -> str:
    if not drop_info:
        return "（无）"
    display = drop_info.get("displayRewards") or []
    if not display:
        return "（无）"
    parts: list[str] = []
    for d in display:
        item_id = str(d.get("id") or "")
        item_name = None
        if item_id:
            item_name = _get_item_name_by_id(item_id)
        name = item_name or d.get("type") or d.get("dropType") or item_id or "?"
        if item_id and item_name:
            name = f"{name}（{item_id}）"
        elif item_id and name != item_id:
            name = f"{name}（{item_id}）"
        count = d.get("count", 1)
        drop_type = d.get("dropType")
        suffix = f" [{drop_type}]" if drop_type else ""
        parts.append(f"- {name} ×{count}{suffix}")
    return "\n".join(parts) if parts else "（无）"


# ---------------------------------------------------------------------------
# Cached loaders
# ---------------------------------------------------------------------------


def _load_stage_table_impl() -> dict[str, dict]:
    if not _has_stage_data():
        raise FileNotFoundError(_STAGE_FILE)
    raw = _excel_store().read_json(_STAGE_FILE)
    if not isinstance(raw, dict):
        raise TypeError(f"{_STAGE_FILE} top-level shape mismatch")
    stages = raw.get("stages")
    if not isinstance(stages, dict):
        raise TypeError(f"{_STAGE_FILE} missing 'stages' dict")
    return stages


def _load_zone_table_impl() -> dict[str, dict] | None:
    store = _excel_store()
    if not store.exists(_ZONE_FILE):
        return None
    raw = store.read_json(_ZONE_FILE)
    if not isinstance(raw, dict):
        return None
    zones = raw.get("zones")
    return zones if isinstance(zones, dict) else None


def _zone_display(zone_id: str) -> str:
    zones = _load_zone_table()
    if zones is None:
        return zone_id
    z = zones.get(zone_id)
    if z is None:
        return zone_id
    first = z.get("zoneNameFirst") or ""
    second = z.get("zoneNameSecond") or ""
    if first and second:
        return f"{first}-{second}"
    if first:
        return first
    return zone_id


def clear_stage_caches() -> None:
    _access.clear()


register_activation_listener(clear_stage_caches)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_stages_listing(
    chapter: str | None = None,
    type: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict | str:
    """Build the structured payload for a stages listing.

    Returns the dict payload on success, including legitimate empty results,
    or a markdown error string on user-input / missing-data paths. The dict is
    the single source of truth that ``render_stages_listing`` consumes.
    """
    if message := _validate_bounds("limit", limit, minimum=1, maximum=200):
        return message
    if message := _validate_bounds("offset", offset, minimum=0):
        return message
    if type is not None and type.upper() not in _STAGE_TYPE_LABELS:
        allowed = "、".join(_STAGE_TYPE_LABELS)
        return f"无效的 type：{type!r}。可选值：{allowed}。"

    try:
        stages = load_stage_table()
    except (FileNotFoundError, TypeError) as e:
        return _missing_data_message() + f"（{e}）"

    filtered: list[dict] = []
    for sid, entry in sorted(stages.items()):
        if chapter is not None and entry.get("zoneId") != chapter:
            continue
        if type is not None and entry.get("stageType") != type.upper():
            continue
        filtered.append(entry)

    total = len(filtered)
    page = filtered[offset : offset + limit]

    entries = []
    for e in page:
        entries.append(
            {
                "stage_id": e.get("stageId", ""),
                "name": e.get("name") or "（无名）",
                "code": e.get("code") or "?",
                "type": e.get("stageType", ""),
                "type_label": _stage_type_label(e.get("stageType", "")),
                "difficulty_label": _difficulty_label(e.get("difficulty", "")),
                "zone_id": e.get("zoneId", ""),
                "zone_display": _zone_display(e.get("zoneId", "")),
            }
        )

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        # chapter is echoed verbatim (it is an exact zoneId match, no
        # normalization); type is upper-cased to match stageType values.
        "filters": {
            "chapter": chapter,
            "type": type.upper() if type else None,
        },
        "stages": entries,
    }


def render_stages_listing(data: dict) -> str:
    """Render a stages-listing payload dict to markdown.

    Pure renderer; the inverse of ``build_stages_listing``'s success path.
    """
    total = data["total"]
    offset = data["offset"]
    limit = data["limit"]
    stages = data["stages"]

    if not stages:
        if total == 0:
            filters: list[str] = []
            f = data["filters"]
            if f["chapter"]:
                filters.append(f"zoneId={f['chapter']}")
            if f["type"]:
                filters.append(f"stageType={f['type']}")
            return f"没有匹配的关卡（filter: {', '.join(filters) or 'none'}）。"
        return f"offset {offset} 超出范围（共 {total} 条）。"

    lines = [f"# 关卡列表（共 {total} 个）"]
    for s in stages:
        lines.append(
            f"- **{s['name']}** [{s['type_label']}] {s['code']} — "
            f"{s['difficulty_label']} — {s['zone_display']}"
            f"（id: {s['stage_id']}）"
        )

    start = offset + 1
    end = min(offset + limit, total)
    lines.append(
        f"\n（显示第 {start}–{end} 条，共 {total} 条。"
        f"使用 offset={offset + limit} 查看下一页）"
    )
    return "\n".join(lines)


def list_stages(
    chapter: str | None = None,
    type: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> str:
    """List stages, optionally filtered by zone ID and/or stage type."""
    data = build_stages_listing(chapter=chapter, type=type, limit=limit, offset=offset)
    if isinstance(data, str):
        return data
    return render_stages_listing(data)


def build_stage_info(stage_id: str) -> dict | str:
    """Build the structured payload for a single stage's detail.

    Returns the dict payload on success, or a markdown error string on a
    missing-data / not-found path. The dict is the single source of truth
    that ``render_stage_info`` consumes.
    """
    try:
        stages = load_stage_table()
    except (FileNotFoundError, TypeError) as e:
        return _missing_data_message() + f"（{e}）"

    entry: dict | None = stages.get(stage_id)
    if entry is None:
        return f"未找到关卡：{stage_id!r}。"

    _ap = entry.get("apCost")
    raw_desc = entry.get("description") or ""

    # Related stages — resolve names up front so render stays pure.
    hard_id = entry.get("hardStagedId")
    hard_name = None
    if hard_id:
        h_entry = stages.get(hard_id)
        hard_name = h_entry.get("name") if h_entry else None
    six_star_id = entry.get("sixStarStageId")
    six_star_name = None
    if six_star_id:
        s_entry = stages.get(six_star_id)
        six_star_name = s_entry.get("name") if s_entry else None

    return {
        "stage_id": stage_id,
        "name": entry.get("name") or "（无名）",
        "code": entry.get("code") or "?",
        "type_raw": entry.get("stageType", ""),
        "type_label": _stage_type_label(entry.get("stageType", "")),
        "difficulty_raw": entry.get("difficulty", ""),
        "difficulty_label": _difficulty_label(entry.get("difficulty", "")),
        "zone_id": entry.get("zoneId", ""),
        "zone_display": _zone_display(entry.get("zoneId", "")),
        "ap_cost": _ap if _ap is not None else "?",
        "danger_level": entry.get("dangerLevel") or "?",
        "boss_mark": entry.get("bossMark", False),
        "description": _clean_description(raw_desc) or "（无描述）",
        "drop_info": entry.get("stageDropInfo"),
        "unlock_conditions": entry.get("unlockCondition") or [],
        "level_id": entry.get("levelId"),
        "hard_stage": {"id": hard_id, "name": hard_name},
        "six_star_stage": {"id": six_star_id, "name": six_star_name},
    }


def render_stage_info(data: dict) -> str:
    """Render a stage-detail payload dict to markdown.

    Pure renderer; the inverse of ``build_stage_info``'s success path.
    Reuses ``_format_drops`` / ``_format_unlock`` for the drop/unlock
    sections so the output stays byte-for-byte equivalent.
    """
    parts = [f"# {data['name']} — 关卡详情", "", "## 基本信息"]
    parts.append(f"- **ID**：{data['stage_id']}")
    parts.append(f"- **编号**：{data['code']}")
    parts.append(f"- **类型**：{data['type_label']}")
    parts.append(f"- **难度**：{data['difficulty_label']}")
    parts.append(f"- **所属区域**：{data['zone_display']}")
    parts.append(f"- **理智消耗**：{data['ap_cost']}")
    parts.append(f"- **危险等级**：{data['danger_level']}")
    if data["boss_mark"]:
        parts.append("- **BOSS标记**：是")
    if data["level_id"]:
        parts.append(f"- **关卡数据**：{data['level_id']}")

    parts.append("")
    parts.append("## 描述")
    parts.append(data["description"])

    parts.append("")
    parts.append("## 掉落信息")
    parts.append(_format_drops(data["drop_info"]))

    parts.append("")
    parts.append("## 解锁条件")
    parts.append(_format_unlock(data["unlock_conditions"]))

    parts.append("")
    parts.append("## 关联关卡")
    hard = data["hard_stage"]
    if hard["id"]:
        parts.append(f"- 突袭模式：{hard['id']}" + (f"（{hard['name']}）" if hard["name"] else ""))
    else:
        parts.append("- 突袭模式：无")
    six_star = data["six_star_stage"]
    if six_star["id"]:
        parts.append(
            f"- 六星模式：{six_star['id']}" + (f"（{six_star['name']}）" if six_star["name"] else "")
        )

    return "\n".join(parts)


def get_stage_info(stage_id: str) -> str:
    """Return detailed information for a single stage."""
    data = build_stage_info(stage_id)
    if isinstance(data, str):
        return data
    return render_stage_info(data)


def search_stages(pattern: str, max_results: int = 30) -> str:
    """Regex search across stage names, codes, and descriptions."""
    data = build_stage_search(pattern, max_results=max_results)
    if isinstance(data, str):
        return data
    return render_stage_search(data)


def build_stage_search(pattern: str, max_results: int = 30) -> dict | str:
    """Build the structured payload for stage search."""
    if message := _validate_bounds("max_results", max_results, minimum=1, maximum=100):
        return message

    try:
        regex = _re.compile(pattern, _re.IGNORECASE)
    except _re.error as e:
        return _regex_error_message(e)

    matched: list[_StageSearchRecord] = []
    try:
        records = _stage_search_records()
    except (FileNotFoundError, TypeError) as e:
        return _missing_data_message() + f"（{e}）"
    for record in records:
        if regex.search(record.search_text):
            matched.append(record)
            if len(matched) >= max_results:
                break

    return {
        "scope": "stages",
        "pattern": pattern,
        "total": len(matched),
        "results": [_stage_search_entry(record) for record in matched],
    }


def render_stage_search(data: dict) -> str:
    """Render a stage search payload to markdown."""
    pattern = data["pattern"]
    results = data["results"]
    if not results:
        return f"未找到匹配 '{pattern}' 的关卡。"

    lines = [f"# 搜索结果：{pattern}（共 {data['total']} 个）"]
    for entry in results:
        lines.append(
            f"\n## {entry['name']} [{entry['type_label']}] "
            f"{entry['code']}（id: {entry['stage_id']}）"
        )
        lines.append(f"- **区域**：{entry['zone_display']}")
        lines.append(f"- **难度**：{entry['difficulty_label']}")
        lines.append(f"- **理智**：{entry['ap']}")
        desc = entry["description"]
        if desc:
            lines.append(f"- **描述**：{desc[:120]}{'...' if len(desc) > 120 else ''}")

    return "\n".join(lines)


def _stage_search_entry(record: _StageSearchRecord) -> dict[str, Any]:
    e = record.entry
    type_raw = e.get("stageType", "")
    difficulty_raw = e.get("difficulty", "")
    zone_id = e.get("zoneId", "")
    ap = e.get("apCost")
    return {
        "stage_id": record.stage_id,
        "name": e.get("name") or "（无名）",
        "code": e.get("code") or "?",
        "type": type_raw,
        "type_label": _stage_type_label(type_raw),
        "difficulty": difficulty_raw,
        "difficulty_label": _difficulty_label(difficulty_raw),
        "zone_id": zone_id,
        "zone_display": _zone_display(zone_id),
        "ap": ap if ap is not None else "?",
        "description": _clean_description(e.get("description") or ""),
    }


def _stage_search_records_impl() -> tuple[_StageSearchRecord, ...]:
    records: list[_StageSearchRecord] = []
    for sid, entry in sorted(load_stage_table().items()):
        search_text = " ".join([
            entry.get("name") or "",
            entry.get("code") or "",
            _clean_description(entry.get("description") or ""),
            entry.get("stageType") or "",
            sid,
        ])
        records.append(_StageSearchRecord(
            stage_id=sid,
            entry=entry,
            search_text=search_text,
        ))
    return tuple(records)


_access = _define_dataset(_DatasetSpec(
    name="stage",
    loaders={
        "stage_table": _LoaderSpec(load=_load_stage_table_impl),
        "zone_table": _LoaderSpec(load=_load_zone_table_impl),
        "stage_search_records": _LoaderSpec(load=_stage_search_records_impl),
    },
    store=_excel_store,
    available=_has_stage_data,
    missing_message=_excel_missing_message("关卡"),
))

load_stage_table = _access.cached("stage_table")
_load_zone_table = _access.cached("zone_table")
_stage_search_records = _access.cached("stage_search_records")


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count}}`` for instrumentation (#104)."""
    return _access.stats()
