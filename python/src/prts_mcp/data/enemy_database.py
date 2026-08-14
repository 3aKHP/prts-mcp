"""Normalize supported upstream ``enemy_database.json`` archive shapes."""
from __future__ import annotations

from typing import Any


def normalize_enemy_database(raw: Any) -> dict[str, dict[int, dict[str, Any]]]:
    """Return an ``enemy ID -> level -> enemyData`` index for supported input."""
    if not isinstance(raw, dict):
        raise TypeError("enemy_database.json 格式异常：根节点必须是对象。")

    index: dict[str, dict[int, dict[str, Any]]] = {}

    def add_row(enemy_id: str, values: Any) -> None:
        if not isinstance(values, list):
            return
        level_map: dict[int, dict[str, Any]] = {}
        for value in values:
            if not isinstance(value, dict):
                continue
            try:
                level = int(value.get("level", 0))
            except (TypeError, ValueError):
                level = 0
            enemy_data = value.get("enemyData")
            if isinstance(enemy_data, dict):
                level_map[level] = enemy_data
        if level_map:
            index[enemy_id] = level_map

    legacy_rows = raw.get("enemies")
    if isinstance(legacy_rows, list):
        for row in legacy_rows:
            if not isinstance(row, dict):
                continue
            key = row.get("Key")
            if isinstance(key, str) and key:
                add_row(key, row.get("Value"))
        return index

    for enemy_id, values in raw.items():
        add_row(str(enemy_id), values)
    if not index:
        raise TypeError("enemy_database.json 格式异常：未找到敌人等级数据。")
    return index


def level0_index(levels: dict[str, dict[int, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    """Project the raw level map onto the default (level-0) entry per enemy.

    Selection semantics replicate enemy.py's historical projection verbatim
    (truthy-``or``: an empty-dict level-0 entry falls through to the first
    available level); the TS mirror uses nullish ``??`` instead — a known,
    deliberate cross-implementation divergence, do not unify.
    """
    return {
        enemy_id: level_map.get(0) or next(iter(level_map.values()))
        for enemy_id, level_map in levels.items()
        if level_map
    }
