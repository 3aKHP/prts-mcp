"""Pure parsing of zh_CN-levels per-stage level JSON files.

Extracted from ``data/stage_enemy`` (P3.A): path derivation, SPAWN action
counting, enemyDbRefs keying, and the level-number parse (previously
duplicated inline twice in stage_enemy). Store access stays in
``data/stage_enemy`` — this module is pure dict/JSON-shape logic only.
The TS mirror is ``ts/src/data/levelParser.ts``.
"""
from __future__ import annotations

from collections import Counter
from typing import Any


def level_path(level_id: str) -> str:
    return level_id.lower().replace("\\", "/") + ".json"


def parse_level(value: Any) -> int:
    """Best-effort int conversion for level numbers (bad values → 0)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def spawn_counts(level: dict[str, Any]) -> Counter[str]:
    """Count SPAWN actions per enemy key across waves→fragments→actions."""
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


def enemy_refs(level: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Key ``enemyDbRefs`` entries by enemy id."""
    refs: dict[str, dict[str, Any]] = {}
    for ref in level.get("enemyDbRefs", []) or []:
        key = ref.get("id")
        if key:
            refs[str(key)] = ref
    return refs
