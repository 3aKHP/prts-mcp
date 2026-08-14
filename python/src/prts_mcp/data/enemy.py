from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from prts_mcp.activation import register_activation_listener
from prts_mcp.config import Config
from prts_mcp.data.dataset_access import (
    DatasetSpec,
    LoaderSpec,
    define_dataset,
    excel_store,
    levels_store,
)
from prts_mcp.data.enemy_database import normalize_enemy_database
from prts_mcp.data.enemy_render import (
    render_handbook_card,
    render_stats_block,
)
from prts_mcp.data.enemy_stats import extract_enemy_stats
from prts_mcp.data.messages import (
    excel_missing_message,
    regex_error_message,
    validate_bounds,
)


def _get_config() -> Config:
    return Config.load()


_HANDBOOK_FILE = "enemy_handbook_table.json"
_DATABASE_FILE = "enemydata/enemy_database.json"


@dataclass(frozen=True)
class _EnemySearchRecord:
    enemy_id: str
    info: dict[str, Any]
    search_text: str


def _has_enemy_data() -> bool:
    cfg = _get_config()
    if cfg.effective_excel_path is None:
        return False
    return excel_store().exists(_HANDBOOK_FILE)


def _has_database() -> bool:
    cfg = _get_config()
    if cfg.effective_levels_path is None:
        return False
    return levels_store().exists(_DATABASE_FILE)


def _load_enemy_handbook_impl() -> dict[str, Any]:
    store = excel_store()
    if not store.exists(_HANDBOOK_FILE):
        raise FileNotFoundError(
            f"敌人图鉴数据文件不存在：{store.root / _HANDBOOK_FILE}。"
        )
    return store.read_json(_HANDBOOK_FILE)


def _load_enemy_database_impl() -> dict[str, Any] | None:
    """Load enemy_database.json. Returns None when the file is absent.

    Caching the None result is fine because the sync hook in server.py calls
    clear_enemy_caches() after a successful sync, invalidating both the None
    and the populated cache.
    """
    if not _has_database():
        return None
    store = levels_store()
    levels = normalize_enemy_database(store.read_json(_DATABASE_FILE))
    index = {
        enemy_id: level_map.get(0) or next(iter(level_map.values()))
        for enemy_id, level_map in levels.items()
        if level_map
    }
    return {"_index": index}


def _build_enemy_name_to_id_impl() -> dict[str, str]:
    raw = _load_enemy_handbook()
    ed = raw.get("enemyData", {})
    return {info["name"]: eid for eid, info in ed.items() if info.get("name")}


def _enemy_search_records_impl() -> tuple[_EnemySearchRecord, ...]:
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
        records.append(_EnemySearchRecord(
            enemy_id=_eid,
            info=info,
            search_text=search_text,
        ))
    return tuple(records)


_access = define_dataset(DatasetSpec(
    name="enemy",
    loaders={
        "enemy_handbook": LoaderSpec(
            load=_load_enemy_handbook_impl,
            count=lambda r: len(r.get("enemyData") or {}),
        ),
        "enemy_database": LoaderSpec(
            load=_load_enemy_database_impl,
            count=lambda r: len(r.get("_index") or {}) if r else 0,
        ),
        "enemy_name_to_id": LoaderSpec(load=_build_enemy_name_to_id_impl),
        "enemy_search_records": LoaderSpec(load=_enemy_search_records_impl),
    },
    store=excel_store,
    available=_has_enemy_data,
    missing_message=excel_missing_message("敌人图鉴"),
))

_load_enemy_handbook = _access.cached("enemy_handbook")
_load_enemy_database = _access.cached("enemy_database")
_build_enemy_name_to_id = _access.cached("enemy_name_to_id")
_enemy_search_records = _access.cached("enemy_search_records")


def clear_enemy_caches() -> None:
    _access.clear()


register_activation_listener(clear_enemy_caches)


def _missing_data_message() -> str:
    return _access.missing_message()


def _resolve_enemy_id(name: str) -> str | None:
    mapping = _build_enemy_name_to_id()
    return mapping.get(name)


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count}}`` for instrumentation (#104)."""
    return _access.stats()


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


# NOTE: a _fmt_stats helper previously lived here, formatting combat stats
# from enemy_database.json into markdown. It became dead code when
# get_enemy_info migrated to the structured-dict + markdown-renderer split.
# Stat extraction now lives in data/enemy_stats.extract_enemy_stats and
# stat rendering in data/enemy_render.render_stats_block; do not resurrect
# local copies (see git history).


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_enemies_listing(
    threat_level: str | None = None,
    limit: int = 50,
    offset: int = 0,
    full: bool = False,
) -> dict | str:
    """Build the structured payload for an enemies listing.

    Returns the dict payload on success, including legitimate empty listings,
    or a markdown error string on a validation / missing-data path.
    """
    if not _has_enemy_data():
        return _missing_data_message()

    if message := validate_bounds("limit", limit, minimum=1, maximum=200):
        return message
    if message := validate_bounds("offset", offset, minimum=0):
        return message

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

    level_filter: str | None = None
    if threat_level:
        level_filter = threat_level.upper()
        if level_filter not in _ENEMY_LEVEL_ZH:
            return f"无效的 threat_level 参数：{threat_level!r}，可选值：boss、elite、normal。"
        entries = [(e, i) for e, i in entries
                   if i.get("enemyLevel", "").upper() == level_filter]

    entries.sort(key=lambda x: (x[1].get("sortId", 9999), x[0]))
    total = len(entries)

    # Empty-result semantics (2.0 output-channel contract, intentional
    # distinction — see test_filter_no_match_is_structured_no_empty_reason):
    #   - offset_out_of_range: total > 0 but the requested page is past the
    #     end, so we return a structured payload carrying empty_reason so a
    #     paging client can tell "no more pages" from a genuine zero dataset.
    #   - filter no-match: total is legitimately 0, so there is nothing to
    #     distinguish — it falls through to the standard empty-listing payload
    #     ({total:0, enemies:[]}) below without an empty_reason marker. Adding
    #     empty_reason="no_match" here would touch the renderer, parity
    #     fixtures, and the TS equivalent, and is out of scope for this
    #     cleanup; raise it as a separate follow-up if a client ever needs it.
    filters_payload = {"threat_level": threat_level, "threat_level_filter": level_filter}
    if not full and offset >= total and total > 0:
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "full": full,
            "filters": filters_payload,
            "enemies": [],
            "empty_reason": "offset_out_of_range",
        }

    displayed = entries if full else entries[offset:offset + limit]

    item_entries = []
    for eid, info in displayed:
        level_raw = info.get("enemyLevel", "")
        desc = (info.get("description") or "").replace("\n", " ")[:60]
        item_entries.append({
            "enemy_id": eid,
            "name": info.get("name", ""),
            "enemy_index": info.get("enemyIndex", ""),
            "level_raw": level_raw,
            "level_label": _ENEMY_LEVEL_ZH.get(level_raw, level_raw),
            "description_excerpt": desc,
        })

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "full": full,
        "filters": filters_payload,
        "enemies": item_entries,
    }


def render_enemies_listing(data: dict) -> str:
    """Render an enemies-listing payload dict to markdown.

    Pure renderer; the inverse of ``build_enemies_listing``'s success path.
    """
    if data.get("empty_reason") == "offset_out_of_range":
        total = data["total"]
        offset = data["offset"]
        return f"# 敌人图鉴（共 {total} 个）\n\noffset={offset} 超出范围（总计 {total} 条）。"

    total = data["total"]
    offset = data["offset"]
    limit = data["limit"]
    full = data["full"]
    enemies = data["enemies"]

    header = f"# 敌人图鉴（共 {total} 个）\n"
    for e in enemies:
        line = f"- **{e['name']}** [{e['level_label']}] ({e['enemy_index']})"
        if e["description_excerpt"]:
            line += f" — {e['description_excerpt']}"
        header += line + "\n"

    if not full and total > offset + limit:
        header += f"\n（显示第 {offset+1}–{min(offset+limit, total)} 条，共 {total} 条。使用 offset={offset+limit} 查看下一页）"

    return header.strip()


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
    data = build_enemies_listing(threat_level=threat_level, limit=limit, offset=offset, full=full)
    if isinstance(data, str):
        return data
    return render_enemies_listing(data)


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
        payload["stats"] = extract_enemy_stats(db_entry)

    return payload


def render_enemy_info(data: dict) -> str:
    """Render an enemy-info payload dict to markdown.

    Pure renderer; the inverse of ``build_enemy_info``'s success path.
    """
    lines = render_handbook_card(data, include_enemy_id=True)
    stats = data["stats"]
    if stats:
        lines.extend(render_stats_block(stats))
    return "\n".join(lines)


def get_enemy_info(name: str) -> str:
    """Return full info for a single enemy, with combat stats from database."""
    data = build_enemy_info(name)
    if isinstance(data, str):
        return data
    return render_enemy_info(data)


def search_enemies(pattern: str, max_results: int = 30) -> str:
    """Regex search across enemy names and descriptions."""
    data = build_enemy_search(pattern, max_results=max_results)
    if isinstance(data, str):
        return data
    return render_enemy_search(data)


def build_enemy_search(pattern: str, max_results: int = 30) -> dict | str:
    """Build the structured payload for enemy handbook search."""
    if not _has_enemy_data():
        return _missing_data_message()
    if message := validate_bounds("max_results", max_results, minimum=1, maximum=100):
        return message

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return regex_error_message(exc)

    matches: list[_EnemySearchRecord] = []
    try:
        records = _enemy_search_records()
    except FileNotFoundError as exc:
        return str(exc)
    for record in records:
        if regex.search(record.search_text):
            matches.append(record)
        if len(matches) >= max_results:
            break

    return {
        "scope": "enemies",
        "pattern": pattern,
        "total": len(matches),
        "results": [_enemy_search_entry(record) for record in matches],
    }


def render_enemy_search(data: dict) -> str:
    """Render an enemy search payload to markdown."""
    pattern = data["pattern"]
    results = data["results"]
    if not results:
        return f"未找到匹配 '{pattern}' 的敌人。"

    lines: list[str] = [f"# 搜索结果：{pattern}（共 {data['total']} 个）\n"]
    for entry in results:
        lines.append(_render_enemy_search_card(entry))
        lines.append("")
    return "\n".join(lines).strip()


def _enemy_search_entry(record: _EnemySearchRecord) -> dict[str, Any]:
    info = record.info
    level_raw = info.get("enemyLevel", "")
    damage_types_raw: list[str] = info.get("damageType") or []
    return {
        "enemy_id": record.enemy_id,
        "name": info.get("name", ""),
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
    }


def _render_enemy_search_card(entry: dict) -> str:
    return "\n".join(render_handbook_card(entry))
