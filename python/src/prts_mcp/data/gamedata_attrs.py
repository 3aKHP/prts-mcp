"""Shared GameData attribute helpers.

Holds the ``m_value`` unwrap used by enemy stats and stage-enemy level
parsing; previously duplicated across ``data/enemy`` and ``data/stage_enemy``.
The TS mirror is ``ts/src/data/gamedataAttrs.ts``.
"""
from __future__ import annotations

from typing import Any


def m_value(obj: Any, default: Any = None) -> Any:
    """Unwrap {m_defined, m_value} if present, else return as-is."""
    if isinstance(obj, dict) and "m_value" in obj:
        return obj["m_value"]
    return obj if obj is not None else default
