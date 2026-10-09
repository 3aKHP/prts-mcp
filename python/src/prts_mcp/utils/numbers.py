"""Shared numeric rounding semantics for cross-implementation parity.

Single home for numeric behavior that must stay byte-identical between
the Python and TypeScript implementations (skill blackboard rendering,
stat-panel interpolation). Mirrors ts/src/utils/numbers.ts.
"""
from __future__ import annotations

import math


def round_half_away(value: float, decimals: int = 0) -> float:
    """Round midpoints away from zero (.NET numeric format semantics).

    ``round()`` / ``Math.round()`` differ across the two runtimes
    (banker's rounding vs half-up), so both sides share this explicit
    formula instead. A result of zero is normalized to ``+0.0`` so
    formatting never emits ``-0`` / ``-0%`` (Python ``copysign`` would
    preserve the sign where ECMAScript ``toFixed`` drops it).
    """
    factor = 10 ** decimals
    rounded = math.floor(abs(value) * factor + 0.5) / factor
    if rounded == 0:
        return 0.0
    return math.copysign(rounded, value)
