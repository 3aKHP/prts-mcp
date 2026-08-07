"""LOCAL_IMAGE=false path: filename→label parsing and LRU image cache.

Mirrors ts/src/data/artworkMediawiki.ts. Lives in the data layer so
tools_artwork.py stays orchestration-only, matching the true-mode boundary
(data/images.py ↔ tools_artwork.py).
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Mapping

from prts_mcp.data.images import BASE_ILLUST_LABELS

_IMAGE_CACHE_LOCK = threading.Lock()
_image_cache: "OrderedDict[str, bytes]" = OrderedDict()
_IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024  # 256 MiB (#85 §4.2)

VARIANT_WIDTH: Mapping[str, int] = {"large": 1024, "preview": 256}


def _image_cache_key(artwork_id: str, variant: str) -> str:
    return f"{artwork_id}|{variant}"


def image_cache_get(artwork_id: str, variant: str) -> bytes | None:
    key = _image_cache_key(artwork_id, variant)
    with _IMAGE_CACHE_LOCK:
        if key in _image_cache:
            _image_cache.move_to_end(key)
            return _image_cache[key]
    return None


def image_cache_put(artwork_id: str, variant: str, data: bytes) -> None:
    key = _image_cache_key(artwork_id, variant)
    with _IMAGE_CACHE_LOCK:
        _image_cache[key] = data
        _image_cache.move_to_end(key)
        total = sum(len(v) for v in _image_cache.values())
        while total > _IMAGE_CACHE_MAX_BYTES and _image_cache:
            _, evicted = _image_cache.popitem(last=False)
            total -= len(evicted)


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count, bytes}}`` for instrumentation (#104)."""
    with _IMAGE_CACHE_LOCK:
        count = len(_image_cache)
        total = sum(len(v) for v in _image_cache.values())
    return {
        "image_cache": {"loaded": count > 0, "count": count, "bytes": total},
    }


def _mediawiki_base_label(suffix: str) -> str:
    base = suffix.rstrip("+")
    plus = "+" in suffix
    label = BASE_ILLUST_LABELS.get(base)
    if label is None:
        label = f"立绘 {base}" if base else "立绘"
    if plus:
        label += "（变体）"
    return label


def _mediawiki_fashion_label(rest: str, charinfo: Mapping[str, Any]) -> str:
    """rest is like 'skin3' (optionally 'skin2_sp'); leading digits = skin N."""
    num = ""
    for ch in rest[4:]:
        if ch.isdigit():
            num += ch
        else:
            break
    label: str | None = None
    if num:
        val = charinfo.get(f"时装{num}名称")
        if isinstance(val, str) and val:
            label = val
    if label is None:
        label = f"时装 {num}" if num else "时装"
    return label


def label_from_filename(
    filename: str, charinfo: Mapping[str, Any],
) -> str | None:
    """Derive a label from a PRTS filename like ``立绘_阿米娅_2.png``.

    Returns None for files we do not expose (建筑小人 ``_Nb``, non-png, or
    names that don't match the ``立绘_<name>_<suffix>`` shape). Multi-form
    operators carry the form in the name segment: ``立绘_阿米娅(近卫)_2.png``.
    """
    if not filename.endswith(".png"):
        return None
    base = filename[:-4]
    parts = base.split("_", 2)
    if len(parts) < 3:
        return None
    name = parts[1]
    suffix = parts[2]
    form: str | None = None
    if "(" in name:
        b = name.find("(")
        e = name.find(")", b)
        if 0 <= b < e:
            form = name[b + 1:e]
    if suffix.startswith("skin"):
        label = _mediawiki_fashion_label(suffix, charinfo)
    elif suffix.endswith("b"):
        return None  # 建筑小人
    else:
        label = _mediawiki_base_label(suffix)
    if form:
        label += f"（{form}）"
    return label
