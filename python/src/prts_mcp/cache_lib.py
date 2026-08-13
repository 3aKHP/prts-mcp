"""Cache instrumentation helpers for activation-aware GameData caches.

Extracted from ``config.py``: ``activation_aware_cache`` (generation-keyed
``lru_cache`` decorator) and ``cache_stat`` (best-effort ``{loaded, count}``
reporter). These are cross-cutting cache utilities consumed by the data
modules, not config concerns. The TS implementation already separates this
into ``cacheStats.ts`` / ``data/cacheMetrics.ts``.
"""
from __future__ import annotations

import logging
from functools import lru_cache, wraps
from typing import Any, Callable

# Public (non-underscore) name imported from ``activation``: keeps this clean
# rather than reaching into a module-private symbol.
from prts_mcp.activation import current_activation_signature

_logger = logging.getLogger(__name__)


def activation_aware_cache(maxsize: int = 1) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Cache GameData reads while checking the active generation on every access."""
    def decorate(func: Callable[..., Any]) -> Callable[..., Any]:
        @lru_cache(maxsize=maxsize)
        def cached(
            _generation: tuple[object, ...],
            *args: Any,
            **kwargs: Any,
        ) -> Any:
            return func(*args, **kwargs)

        @wraps(func)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            generation = current_activation_signature()
            return cached(generation, *args, **kwargs)

        wrapped.cache_clear = cached.cache_clear  # type: ignore[attr-defined]
        wrapped.cache_info = cached.cache_info  # type: ignore[attr-defined]
        return wrapped

    return decorate


def cache_stat(
    cached_func: Callable[..., Any],
    count_fn: Callable[[Any], int] | None = None,
) -> dict[str, Any]:
    """Best-effort ``{loaded, count}`` for an activation_aware_cache function.

    Uses ``cache_info().currsize`` to determine whether the cache is populated.
    When populated, calling the function hits the lru_cache in steady state so
    ``len(result)`` (or *count_fn*) gives the record count.  If the activation
    signature changed between the check and the call, the try/except catches
    any reload failure.

    *count_fn* overrides the default ``len()`` for caches whose top-level
    structure is nested (e.g. a JSON wrapper whose record count lives in a
    sub-dict).
    """
    info = cached_func.cache_info()
    if info.currsize == 0:
        return {"loaded": False, "count": 0}
    try:
        result = cached_func()
        if result is None:
            return {"loaded": False, "count": 0}
        if count_fn is not None:
            return {"loaded": True, "count": count_fn(result)}
        return {"loaded": True, "count": len(result) if hasattr(result, "__len__") else 1}
    except Exception:  # noqa: BLE001
        _logger.debug("cache_stat: failed to read cached value", exc_info=True)
        return {"loaded": False, "count": 0}
