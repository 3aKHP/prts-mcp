from __future__ import annotations

from collections import Counter
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
from prts_mcp.data.gamedata_attrs import m_value as _m_value
from prts_mcp.data.messages import levels_missing_message, validate_bounds


_DATABASE_FILE = "enemydata/enemy_database.json"


def _get_config() -> Config:
    return Config.load()


def _missing_levels_message() -> str:
    return _access.missing_message()


def clear_stage_enemy_caches() -> None:
    _access.clear()


register_activation_listener(clear_stage_enemy_caches)


def _load_stage_table_impl() -> dict[str, dict[str, Any]]:
    raw = excel_store().read_json("stage_table.json")
    stages = raw.get("stages") if isinstance(raw, dict) else None
    if not isinstance(stages, dict):
        raise TypeError("stage_table.json missing 'stages' dict")
    return stages


def _load_enemy_handbook_impl() -> dict[str, dict[str, Any]]:
    raw = excel_store().read_json("enemy_handbook_table.json")
    data = raw.get("enemyData") if isinstance(raw, dict) else None
    if not isinstance(data, dict):
        raise TypeError("enemy_handbook_table.json missing 'enemyData' dict")
    return data


def _load_enemy_database_impl() -> dict[str, dict[int, dict[str, Any]]]:
    return normalize_enemy_database(levels_store().read_json(_DATABASE_FILE))


def _build_enemy_name_to_id_impl() -> dict[str, str]:
    return {
        str(info["name"]): enemy_id
        for enemy_id, info in _load_enemy_handbook().items()
        if info.get("name")
    }


def _level_path(level_id: str) -> str:
    return level_id.lower().replace("\\", "/") + ".json"


def _load_level_json(stage: dict[str, Any]) -> dict[str, Any] | str:
    level_id = stage.get("levelId")
    if not level_id:
        return "该关卡没有 levelId，可能是非战斗/特殊关卡。"
    path = _level_path(str(level_id))
    store = levels_store()
    if not store.exists(path):
        return f"未找到关卡战斗文件：{path}。"
    raw = store.read_json(path)
    if not isinstance(raw, dict):
        return f"关卡战斗文件格式异常：{path}。"
    return raw


def _merge_defined(base: Any, override: Any) -> Any:
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
        merged[key] = _merge_defined(merged.get(key), value)
    return merged


def _spawn_counts(level: dict[str, Any]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for wave in level.get("waves", []) or []:
        for fragment in wave.get("fragments", []) or []:
            for action in fragment.get("actions", []) or []:
                if action.get("actionType") not in ("SPAWN", 0):
                    continue
                key = action.get("key")
                if key:
                    try:
                        count = int(action.get("count", 1))
                    except (TypeError, ValueError):
                        count = 1
                    counts[str(key)] += max(count, 1)
    return counts


def _enemy_refs(level: dict[str, Any]) -> dict[str, dict[str, Any]]:
    refs: dict[str, dict[str, Any]] = {}
    for ref in level.get("enemyDbRefs", []) or []:
        key = ref.get("id")
        if key:
            refs[str(key)] = ref
    return refs


def _handbook_name(enemy_id: str) -> str:
    info = _load_enemy_handbook().get(enemy_id) or {}
    return str(info.get("name") or enemy_id)


def _overwritten_enemy_name(overwritten: Any) -> str | None:
    if not isinstance(overwritten, dict):
        return None
    name = overwritten.get("name") or overwritten.get("prefabKey")
    return str(_m_value(name)) if name else None


def _stage_label(stage: dict[str, Any], stage_id: str) -> str:
    name = stage.get("name") or "（无名）"
    code = stage.get("code") or stage_id
    return f"{name} {code}（{stage_id}）"


def _stage_specific_enemy_data(enemy_id: str, level: int, overwritten: Any = None) -> dict[str, Any] | None:
    db_entry = _load_enemy_database().get(enemy_id, {})
    base = db_entry.get(level) or db_entry.get(0)
    if base is None:
        return overwritten if isinstance(overwritten, dict) else None
    merged = _merge_defined(base, overwritten)
    return merged if isinstance(merged, dict) else base


def _format_stats(enemy_data: dict[str, Any] | None) -> str:
    if not enemy_data:
        return "无数据库记录"
    attrs = enemy_data.get("attributes") or {}
    hp = _m_value(attrs.get("maxHp"), 0)
    atk = _m_value(attrs.get("atk"), 0)
    defense = _m_value(attrs.get("def"), 0)
    res = _m_value(attrs.get("magicResistance"), 0)
    speed = _m_value(attrs.get("moveSpeed"), 0)
    atk_time = _m_value(attrs.get("baseAttackTime"), 0)
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


def build_stage_enemies(stage_id: str) -> dict | str:
    """Build the structured payload for enemies actually spawned by a stage.

    Returns the dict payload on success, or a markdown error string on a
    missing-data / not-found / empty path.
    """
    if not _get_config().has_levels_data:
        return _missing_levels_message()
    try:
        stages = _load_stage_table()
        stage = stages.get(stage_id)
        if not stage:
            return f"未找到关卡：{stage_id!r}。"
        level = _load_level_json(stage)
        if isinstance(level, str):
            return level
        counts = _spawn_counts(level)
        refs = _enemy_refs(level)
    except Exception as exc:  # noqa: BLE001
        return f"读取关卡敌人失败：{exc}"

    if not counts:
        # Legitimate-but-empty: the stage exists but spawns nothing.
        return {
            "stage_id": stage_id,
            "stage_label": _stage_label(stage, stage_id),
            "total": 0,
            "enemies": [],
            "empty_reason": "no_match",
        }

    enemy_entries = []
    for enemy_id, count in counts.most_common():
        ref = refs.get(enemy_id, {})
        try:
            level_no = int(ref.get("level", 0))
        except (TypeError, ValueError):
            level_no = 0
        overwritten = ref.get("overwrittenData")
        data = _stage_specific_enemy_data(enemy_id, level_no, overwritten)
        name = _overwritten_enemy_name(overwritten) or _handbook_name(enemy_id)
        enemy_entries.append({
            "enemy_id": enemy_id,
            "name": name,
            "count": count,
            "level": level_no,
            "overwritten": bool(overwritten),
            # Stats kept as the compact rendered text (the same string the
            # markdown emits); structured per-stat extraction is deferred.
            "stats_text": _format_stats(data),
        })

    return {
        "stage_id": stage_id,
        "stage_label": _stage_label(stage, stage_id),
        "total": len(enemy_entries),
        "enemies": enemy_entries,
    }


def render_stage_enemies(data: dict) -> str:
    """Render a stage-enemies payload dict to markdown.

    Pure renderer; the inverse of ``build_stage_enemies``'s success path.
    """
    if data.get("empty_reason") == "no_match":
        return f"关卡 {data['stage_id']!r} 未解析到实际出怪。"

    lines = [f"# {data['stage_label']} — 敌人列表"]
    for e in data["enemies"]:
        lines.append(f"\n## {e['name']}（{e['enemy_id']}）")
        lines.append(f"- **出场数量**：{e['count']}")
        lines.append(f"- **敌人等级**：{e['level']}")
        if e["overwritten"]:
            lines.append("- **关卡覆盖**：是")
        lines.append(f"- **战斗属性**：{e['stats_text']}")
    return "\n".join(lines)


def get_stage_enemies(stage_id: str) -> str:
    """Return enemies actually spawned by a stage, using stage-specific levels."""
    data = build_stage_enemies(stage_id)
    if isinstance(data, str):
        return data
    return render_stage_enemies(data)


def _find_enemy_appearances(enemy_id: str) -> list[tuple[str, int]]:
    return _enemy_appearance_index().get(enemy_id, [])


def _enemy_appearance_index_impl() -> dict[str, list[tuple[str, int]]]:
    appearances: dict[str, list[tuple[str, int]]] = {}
    store = levels_store()
    for stage_id, stage in _load_stage_table().items():
        level_id = stage.get("levelId")
        if not level_id:
            continue
        path = _level_path(str(level_id))
        if not store.exists(path):
            continue
        level = store.read_json(path)
        if not isinstance(level, dict):
            continue
        for enemy_id, count in _spawn_counts(level).items():
            appearances.setdefault(enemy_id, []).append((stage_id, count))
    return appearances


_access = define_dataset(DatasetSpec(
    name="stage_enemy",
    loaders={
        "stage_table": LoaderSpec(load=_load_stage_table_impl),
        "enemy_handbook": LoaderSpec(load=_load_enemy_handbook_impl),
        "enemy_database": LoaderSpec(load=_load_enemy_database_impl),
        "enemy_name_to_id": LoaderSpec(load=_build_enemy_name_to_id_impl),
        "enemy_appearance_index": LoaderSpec(load=_enemy_appearance_index_impl),
    },
    store=excel_store,
    available=lambda: _get_config().has_levels_data,
    missing_message=levels_missing_message("关卡战斗"),
))

_load_stage_table = _access.cached("stage_table")
_load_enemy_handbook = _access.cached("enemy_handbook")
_load_enemy_database = _access.cached("enemy_database")
_build_enemy_name_to_id = _access.cached("enemy_name_to_id")
_enemy_appearance_index = _access.cached("enemy_appearance_index")


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count}}`` for instrumentation (#104)."""
    return _access.stats()


def build_enemy_appearances(name: str, limit: int = 50, offset: int = 0) -> dict | str:
    """Build the structured payload for where an enemy actually spawns.

    Returns the dict payload on success, or a markdown error string on a
    validation / missing-data / not-found / empty path.
    """
    if message := validate_bounds("limit", limit, minimum=1, maximum=200):
        return message
    if message := validate_bounds("offset", offset, minimum=0):
        return message
    if not _get_config().has_levels_data:
        return _missing_levels_message()

    try:
        enemy_id = _build_enemy_name_to_id().get(name) or (name if name in _load_enemy_handbook() else None)
        if enemy_id is None:
            return f"未找到敌人：{name!r}。"
        appearances = _find_enemy_appearances(enemy_id)
        stages = _load_stage_table()
    except Exception as exc:  # noqa: BLE001
        return f"读取敌人出场关卡失败：{exc}"

    total = len(appearances)
    page = appearances[offset : offset + limit]
    enemy_name = _handbook_name(enemy_id)
    # Legitimate-but-empty (no appearances / offset past end) is a normal
    # structured payload, not an error (P2b plan §3.4).
    if not page:
        empty_reason = "no_match" if total == 0 else "offset_out_of_range"
        return {
            "enemy_id": enemy_id,
            "enemy_name": enemy_name,
            "total": total,
            "offset": offset,
            "limit": limit,
            "stages": [],
            "empty_reason": empty_reason,
        }

    stage_entries = []
    for stage_id, count in page:
        stage = stages.get(stage_id, {})
        stage_entries.append({
            "stage_id": stage_id,
            "stage_name": stage.get("name") or "（无名）",
            "code": stage.get("code") or stage_id,
            "count": count,
        })

    return {
        "enemy_id": enemy_id,
        "enemy_name": enemy_name,
        "total": total,
        "offset": offset,
        "limit": limit,
        "stages": stage_entries,
    }


def render_enemy_appearances(data: dict) -> str:
    """Render an enemy-appearances payload dict to markdown.

    Pure renderer; the inverse of ``build_enemy_appearances``'s success path.
    """
    empty_reason = data.get("empty_reason")
    if empty_reason == "no_match":
        return f"未找到 {data['enemy_name']}（{data['enemy_id']}）的实际出场关卡。"
    if empty_reason == "offset_out_of_range":
        return f"offset {data['offset']} 超出范围（共 {data['total']} 条）。"

    enemy_name = data["enemy_name"]
    enemy_id = data["enemy_id"]
    total = data["total"]
    offset = data["offset"]
    limit = data["limit"]
    stages = data["stages"]

    lines = [f"# {enemy_name}（{enemy_id}）— 出场关卡（共 {total} 个）"]
    for s in stages:
        lines.append(f"- **{s['stage_name']}** {s['code']}（{s['stage_id']}）：{s['count']} 个")
    start = offset + 1
    end = min(offset + limit, total)
    lines.append(f"\n（显示第 {start}–{end} 条，共 {total} 条。使用 offset={offset + limit} 查看下一页）")
    return "\n".join(lines)


def get_enemy_appearances(name: str, limit: int = 50, offset: int = 0) -> str:
    """Return stages where an enemy actually spawns."""
    data = build_enemy_appearances(name, limit=limit, offset=offset)
    if isinstance(data, str):
        return data
    return render_enemy_appearances(data)


def get_enemy_stage_info(name: str, stage_id: str) -> str:
    """Return a single enemy's stage-specific stats for a stage."""
    if not _get_config().has_levels_data:
        return _missing_levels_message()
    try:
        enemy_id = _build_enemy_name_to_id().get(name) or (name if name in _load_enemy_handbook() else None)
        if enemy_id is None:
            return f"未找到敌人：{name!r}。"
        stages = _load_stage_table()
        stage = stages.get(stage_id)
        if not stage:
            return f"未找到关卡：{stage_id!r}。"
        level = _load_level_json(stage)
        if isinstance(level, str):
            return level
        counts = _spawn_counts(level)
        refs = _enemy_refs(level)
        ref = refs.get(enemy_id)
    except Exception as exc:  # noqa: BLE001
        return f"读取关卡敌人失败：{exc}"

    if enemy_id not in counts:
        return f"{_handbook_name(enemy_id)}（{enemy_id}）未在关卡 {stage_id!r} 实际出场。"
    if ref is None:
        return f"关卡 {stage_id!r} 缺少 {enemy_id} 的 enemyDbRefs。"

    try:
        level_no = int(ref.get("level", 0))
    except (TypeError, ValueError):
        level_no = 0
    data = _stage_specific_enemy_data(enemy_id, level_no, ref.get("overwrittenData"))
    enemy_name = _overwritten_enemy_name(ref.get("overwrittenData")) or _handbook_name(enemy_id)
    lines = [f"# {enemy_name}（{enemy_id}）@ {_stage_label(stage, stage_id)}"]
    lines.append(f"- **出场数量**：{counts[enemy_id]}")
    lines.append(f"- **敌人等级**：{level_no}")
    if ref.get("overwrittenData"):
        lines.append("- **关卡覆盖**：是")
    lines.append(f"- **战斗属性**：{_format_stats(data)}")
    return "\n".join(lines)
