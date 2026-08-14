from __future__ import annotations

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
from prts_mcp.data.enemy import (
    build_enemy_name_to_id,
    load_enemy_handbook,
    load_enemy_levels,
)
from prts_mcp.data.enemy_stats import (
    format_stats as _format_stats,
    overwritten_enemy_name as _overwritten_enemy_name,
    stage_specific_enemy_data as _stage_specific_enemy_data,
)
from prts_mcp.data.level_parser import (
    enemy_refs as _enemy_refs,
    level_path as _level_path,
    parse_level,
    spawn_counts as _spawn_counts,
)
from prts_mcp.data.messages import levels_missing_message, validate_bounds
from prts_mcp.data.stage import load_stage_table


def _get_config() -> Config:
    return Config.load()


def _missing_levels_message() -> str:
    return _access.missing_message()


def clear_stage_enemy_caches() -> None:
    _access.clear()


register_activation_listener(clear_stage_enemy_caches)


def _load_enemy_handbook() -> dict[str, dict[str, Any]]:
    """Inner ``enemyData`` view over enemy.py's cached whole-JSON handbook."""
    data = load_enemy_handbook().get("enemyData")
    if not isinstance(data, dict):
        raise TypeError("enemy_handbook_table.json missing 'enemyData' dict")
    return data


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


def _handbook_name(enemy_id: str) -> str:
    info = _load_enemy_handbook().get(enemy_id) or {}
    return str(info.get("name") or enemy_id)


def _stage_label(stage: dict[str, Any], stage_id: str) -> str:
    name = stage.get("name") or "（无名）"
    code = stage.get("code") or stage_id
    return f"{name} {code}（{stage_id}）"


def build_stage_enemies(stage_id: str) -> dict | str:
    """Build the structured payload for enemies actually spawned by a stage.

    Returns the dict payload on success, or a markdown error string on a
    missing-data / not-found / empty path.
    """
    if not _get_config().has_levels_data:
        return _missing_levels_message()
    try:
        stages = load_stage_table()
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
        level_no = parse_level(ref.get("level", 0))
        overwritten = ref.get("overwrittenData")
        data = _stage_specific_enemy_data(load_enemy_levels(), enemy_id, level_no, overwritten)
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
    for stage_id, stage in load_stage_table().items():
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
        "enemy_appearance_index": LoaderSpec(load=_enemy_appearance_index_impl),
    },
    store=excel_store,
    available=lambda: _get_config().has_levels_data,
    missing_message=levels_missing_message("关卡战斗"),
))

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
        enemy_id = build_enemy_name_to_id().get(name) or (name if name in _load_enemy_handbook() else None)
        if enemy_id is None:
            return f"未找到敌人：{name!r}。"
        appearances = _find_enemy_appearances(enemy_id)
        stages = load_stage_table()
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
        enemy_id = build_enemy_name_to_id().get(name) or (name if name in _load_enemy_handbook() else None)
        if enemy_id is None:
            return f"未找到敌人：{name!r}。"
        stages = load_stage_table()
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

    level_no = parse_level(ref.get("level", 0))
    data = _stage_specific_enemy_data(load_enemy_levels(), enemy_id, level_no, ref.get("overwrittenData"))
    enemy_name = _overwritten_enemy_name(ref.get("overwrittenData")) or _handbook_name(enemy_id)
    lines = [f"# {enemy_name}（{enemy_id}）@ {_stage_label(stage, stage_id)}"]
    lines.append(f"- **出场数量**：{counts[enemy_id]}")
    lines.append(f"- **敌人等级**：{level_no}")
    if ref.get("overwrittenData"):
        lines.append("- **关卡覆盖**：是")
    lines.append(f"- **战斗属性**：{_format_stats(data)}")
    return "\n".join(lines)
