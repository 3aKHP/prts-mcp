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
    formula instead.
    """
    factor = 10 ** decimals
    rounded = math.floor(abs(value) * factor + 0.5) / factor
    return math.copysign(rounded, value)
