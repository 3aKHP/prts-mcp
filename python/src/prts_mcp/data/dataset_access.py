"""Dataset access contract: parameterized scaffold for gamedata domains.

Every gamedata domain module used to hand-copy the same ~6-piece scaffold
(config prologue, store construction, missing-data message, cached loaders,
clear function, stats + activation listener). This contract parameterizes
that scaffold: :func:`define_dataset` builds a named
:class:`DatasetAccess` holding activation-aware cached loaders and registers
it in a module-level registry that ``server``/``startup_sync`` read instead
of hand-enumerated module lists.

Composition: ``access.cached(key)`` applies the existing
:func:`prts_mcp.cache_stats.activation_aware_cache` engine (generation-keyed
``lru_cache``), so cache semantics, ``cache_clear`` and
:func:`prts_mcp.cache_stats.cache_stat` compatibility are inherited.

The registry is keyed by dataset name and re-registration REPLACES the
previous entry (keeping first-insertion position), mirroring TS ``Map.set``
— re-importing a module (the TS test ``?cacheBust=`` pattern) re-registers
cleanly instead of leaking stale instances. ``define_dataset`` never
auto-registers an activation listener; each domain module keeps exactly one
explicit ``register_activation_listener(clear_x_caches)`` call.

The TS mirror is ``ts/src/data/datasetAccess.ts`` (1:1 symbol mapping:
``define_dataset``↔``defineDataset``, ``cached``↔``loader``, …).
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import wraps
from types import MappingProxyType
from typing import Any, Callable, Mapping

from prts_mcp.cache_stats import activation_aware_cache, cache_stat
from prts_mcp.config import Config
from prts_mcp.data.stores import DirectoryStore

OnErrorMode = str  # "throw" | "cacheFailure" | "null" | "empty"


@dataclass(frozen=True)
class LoaderSpec:
    """One cached loader of a dataset.

    ``on_error`` modes:
      - ``"throw"`` (default): exceptions propagate; nothing is cached, so
        the next call retries (the mid-process data-appearance behavior).
      - ``"cacheFailure"``: the first exception propagates but is remembered;
        subsequent calls re-raise the same exception until ``clear()``.
      - ``"null"`` / ``"empty"``: exceptions are swallowed and ``None``/``{}``
        is cached as a loaded value.
    Absence-as-null/empty is expressed by ``load`` itself returning
    ``None``/``{}`` (a loaded value), not by these modes.
    """

    load: Callable[[], Any]
    count: Callable[[Any], int] | None = None
    on_error: OnErrorMode = "throw"


@dataclass(frozen=True)
class DatasetSpec:
    """Declarative description of one gamedata domain."""

    name: str  # registry key == /debug/cache module key
    loaders: Mapping[str, LoaderSpec]  # keys == cache_stats() inner keys
    store: Callable[[], DirectoryStore] | None = None
    available: Callable[[], bool] | None = None
    missing_message: Callable[[], str] | None = None
    on_clear: Callable[[], None] | None = None


class DatasetAccess:
    """The wired-up per-domain scaffold produced by :func:`define_dataset`."""

    def __init__(self, spec: DatasetSpec) -> None:
        self.name = spec.name
        self._spec = spec
        self._loaders: dict[str, Callable[[], Any]] = {
            key: self._build_loader(loader_spec)
            for key, loader_spec in spec.loaders.items()
        }

    @staticmethod
    def _build_loader(loader: LoaderSpec) -> Callable[[], Any]:
        if loader.on_error == "throw":
            return activation_aware_cache(maxsize=1)(loader.load)

        failure: dict[str, BaseException | None] = {"exc": None}

        @wraps(loader.load)
        def guarded() -> Any:
            if loader.on_error == "cacheFailure" and failure["exc"] is not None:
                raise failure["exc"]
            try:
                return loader.load()
            except Exception as exc:  # noqa: BLE001
                if loader.on_error == "cacheFailure":
                    failure["exc"] = exc
                    raise
                if loader.on_error == "null":
                    return None
                return {}

        wrapped = activation_aware_cache(maxsize=1)(guarded)
        if loader.on_error == "cacheFailure":
            inner_clear = wrapped.cache_clear

            def clear_with_failure() -> None:
                failure["exc"] = None
                inner_clear()

            wrapped.cache_clear = clear_with_failure  # type: ignore[attr-defined]
        return wrapped

    def cached(self, key: str) -> Callable[[], Any]:
        """Return the activation-aware cached loader registered under *key*."""
        return self._loaders[key]

    def clear(self) -> None:
        """Clear every loader cache, then run the post-clear hook."""
        for fn in self._loaders.values():
            fn.cache_clear()
        if self._spec.on_clear is not None:
            self._spec.on_clear()

    def stats(self) -> dict[str, dict[str, Any]]:
        """``{loader_key: {loaded, count}}`` via :func:`cache_stat`."""
        return {
            key: cache_stat(fn, self._spec.loaders[key].count)
            for key, fn in self._loaders.items()
        }

    def store(self) -> DirectoryStore:
        if self._spec.store is None:
            raise RuntimeError(f"dataset {self.name!r} has no store factory")
        return self._spec.store()

    def available(self) -> bool:
        """True when no availability probe is registered."""
        if self._spec.available is None:
            return True
        return self._spec.available()

    def missing_message(self) -> str:
        if self._spec.missing_message is None:
            return ""
        return self._spec.missing_message()


_REGISTRY: dict[str, DatasetAccess] = {}


def define_dataset(spec: DatasetSpec) -> DatasetAccess:
    """Build a :class:`DatasetAccess` and register it under ``spec.name``.

    Re-registration replaces the previous entry (keeping first-insertion
    position) so module re-imports do not leak stale instances.
    """
    access = DatasetAccess(spec)
    _REGISTRY[spec.name] = access
    return access


def dataset_registry() -> Mapping[str, DatasetAccess]:
    """Read-only view of the registered datasets."""
    return MappingProxyType(_REGISTRY)


def dataset_cache_stats() -> dict[str, dict[str, dict[str, Any]]]:
    """``{dataset_name: {loader_key: {loaded, count}}}`` for /debug/cache."""
    return {name: access.stats() for name, access in _REGISTRY.items()}


def excel_store() -> DirectoryStore:
    """Store rooted at the effective excel path (RuntimeError when unset)."""
    ep = Config.load().effective_excel_path
    if ep is None:
        raise RuntimeError("effective_excel_path is None — GAMEDATA_PATH may be unset")
    return DirectoryStore(ep)


def levels_store() -> DirectoryStore:
    """Store rooted at ``<levels>/zh_CN/gamedata/levels`` (callers suffix)."""
    lp = Config.load().effective_levels_path
    if lp is None:
        raise RuntimeError("effective_levels_path is None — levels data may be unsynced")
    return DirectoryStore(lp / "zh_CN" / "gamedata" / "levels")
