"""Operator memoir discovery via chardict.json reverse lookup.

Split from story.py. Resolves an operator Chinese name to its internal
code, then finds all memoir events (story_{code}_set_N) and their chapters.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from prts_mcp.data.stores import DirectoryStore, JsonStore, ZipStore
from prts_mcp.data.story_reader import (
    CHARDICT,
    STORY_REVIEW_TABLE,
    MemoirChapter,
    OperatorMemoirResult,
    load_json,
    story_store,
)

# ---------------------------------------------------------------------------
# Chardict loading + caching
# ---------------------------------------------------------------------------


def _load_chardict(store: JsonStore) -> dict[str, dict[str, object]]:
    """Load chardict.json from the story store."""
    descriptor = _chardict_store_descriptor(store)
    if descriptor is not None:
        return _cached_chardict(descriptor)
    if not store.exists(CHARDICT):
        return {}
    return _read_chardict_from_store(store)


def _read_chardict_from_store(store: JsonStore) -> dict[str, dict[str, object]]:
    try:
        data: dict = load_json(store, CHARDICT)  # type: ignore[assignment]
        return {str(k): v for k, v in data.items() if isinstance(v, dict)}
    except (KeyError, FileNotFoundError, json.JSONDecodeError):
        return {}


def _chardict_store_descriptor(store: JsonStore) -> tuple[str, str, int, int] | None:
    if isinstance(store, ZipStore):
        path = store.zip_path.resolve()
        if not path.is_file():
            return None
        stat = path.stat()
        return ("zip", str(path), stat.st_size, stat.st_mtime_ns)
    if isinstance(store, DirectoryStore):
        root = store.root.resolve()
        chardict = root / CHARDICT
        if not chardict.is_file():
            return None
        stat = chardict.stat()
        return ("directory", str(root), stat.st_size, stat.st_mtime_ns)
    return None


@lru_cache(maxsize=4)
def _cached_chardict(
    descriptor: tuple[str, str, int, int],
) -> dict[str, dict[str, object]]:
    kind, source, _size, _mtime_ns = descriptor
    store: JsonStore
    if kind == "zip":
        store = ZipStore(source)
    else:
        store = DirectoryStore(source)
    try:
        return _read_chardict_from_store(store)
    finally:
        store.close()


def clear_chardict_cache() -> None:
    """Clear the cached chardict."""
    _cached_chardict.cache_clear()


# ---------------------------------------------------------------------------
# Code resolution
# ---------------------------------------------------------------------------


def _resolve_operator_code(
    chardict: dict[str, dict[str, object]],
    operator_name: str,
) -> str | None:
    """Reverse lookup: operator display name -> internal code (e.g. '能天使' -> 'angel')."""
    for code, info in chardict.items():
        if info.get("name") == operator_name:
            return code
    return None


# ---------------------------------------------------------------------------
# Public API — zip-path wrapper
# ---------------------------------------------------------------------------


def get_operator_memoirs(
    zip_path: Path,
    operator_name: str,
) -> OperatorMemoirResult:
    """Return all memoir chapters for an operator by Chinese name.

    Raises:
        KeyError: If the operator is not found in chardict or has no memoirs.
    """
    with story_store(zip_path) as store:
        return get_operator_memoirs_from_store(store, operator_name)


# ---------------------------------------------------------------------------
# Public API — store-based
# ---------------------------------------------------------------------------


def get_operator_memoirs_from_store(
    store: JsonStore,
    operator_name: str,
) -> OperatorMemoirResult:
    """Return all memoir chapters for an operator by Chinese name using a JSON store."""
    chardict = _load_chardict(store)
    if not chardict:
        raise KeyError("chardict.json 未在 story zip 中找到。")

    code = _resolve_operator_code(chardict, operator_name)
    if code is None:
        raise KeyError(
            f"未找到干员名称 '{operator_name}' 对应的内部代码。请使用游戏内中文名称。"
        )

    char_info = chardict[code]
    operator_id = char_info.get("id", "")

    table: dict = load_json(store, STORY_REVIEW_TABLE)  # type: ignore[assignment]
    prefix = f"story_{code}_set_"
    memoir_events = sorted(
        (eid for eid in table if eid.startswith(prefix)),
        key=lambda eid: int(eid.rsplit("_", 1)[-1]) if eid.rsplit("_", 1)[-1].isdigit() else 0,
    )

    if not memoir_events:
        raise KeyError(f"干员 '{operator_name}' (code={code}) 暂无密录数据。")

    chapters: list[MemoirChapter] = []
    for event_id in memoir_events:
        entry = table[event_id]
        datas = sorted(
            entry.get("infoUnlockDatas") or [],
            key=lambda x: x.get("storySort", 0),
        )
        for d in datas:
            story_key = d.get("storyTxt")
            if not story_key:
                continue
            chapters.append(MemoirChapter(
                event_id=event_id,
                story_key=story_key,
                story_code=d.get("storyCode", ""),
                story_name=d.get("storyName", ""),
            ))

    return OperatorMemoirResult(
        operator_name=operator_name,
        internal_code=code,
        operator_id=operator_id,
        total_chapters=len(chapters),
        chapters=chapters,
    )
