"""Tests for LOCAL_IMAGE=false MediaWiki path.

Covers filename→label parsing, the image magic-byte check, the LRU cache
eviction, and the download_image_safe URL pre-check (bad scheme/host). The
streaming-rejection paths inside download_image_safe (post-redirect scheme/
host, Content-Type, magic, 1 MiB cap) require an httpx transport mock and
are deferred — see PR #92 未尽事宜.
"""
from __future__ import annotations

import pytest

from prts_mcp.api.prts_wiki import _image_magic_ok, download_image_safe
from prts_mcp.tools_artwork import (
    _image_cache,
    _image_cache_get,
    _image_cache_put,
    _label_from_filename,
)

_CHARINFO = {"时装1名称": "报童", "时装2名称": "见习联结者", "时装3名称": "播种者"}


def test_label_from_filename():
    cases = {
        "立绘_阿米娅_1.png": "精英零立绘",
        "立绘_阿米娅_1+.png": "精英零立绘（变体）",
        "立绘_阿米娅_2.png": "精英二立绘",
        "立绘_阿米娅_2b.png": None,  # 建筑小人 — not exposed
        "立绘_阿米娅_skin1.png": "报童",
        "立绘_阿米娅_skin2.png": "见习联结者",
        "立绘_阿米娅_skin3.png": "播种者",
        "立绘_阿米娅(近卫)_2.png": "精英二立绘（近卫）",
        "立绘_阿米娅(医疗)_skin1.png": "报童（医疗）",
        "立绘_阿米娅(近卫)_2b.png": None,
    }
    for filename, expected in cases.items():
        assert _label_from_filename(filename, _CHARINFO) == expected, filename


def test_label_fashion_fallback_without_charinfo():
    # No CharinfoV2 → fashion falls back to "时装 N".
    assert _label_from_filename("立绘_阿米娅_skin1.png", {}) == "时装 1"
    assert _label_from_filename("立绘_阿米娅_skin12.png", {}) == "时装 12"


def test_label_rejects_non_png_and_malformed():
    assert _label_from_filename("立绘_阿米娅_2.jpg", _CHARINFO) is None
    assert _label_from_filename("立绘阿米娅", _CHARINFO) is None  # no second underscore


def test_image_magic_ok():
    assert _image_magic_ok(b"\x89PNG\r\n\x1a\n\x00\x00", "image/png")
    assert _image_magic_ok(b"\xff\xd8\xff\xe1\x02", "image/jpeg")
    assert _image_magic_ok(b"RIFF\x00\x00\x00\x00WEBPVP8", "image/webp")
    assert not _image_magic_ok(b"notanimage", "image/png")
    assert not _image_magic_ok(b"\x89PNG\r\n\x1a\n", "image/jpeg")  # wrong mime
    assert not _image_magic_ok(b"RIFF\x00\x00\x00\x00NOTW", "image/webp")


def test_image_cache_lru_round_trip():
    _image_cache.clear()
    try:
        assert _image_cache_get("amiya_2", "large") is None
        _image_cache_put("amiya_2", "large", b"\x00" * 100)
        assert _image_cache_get("amiya_2", "large") == b"\x00" * 100
        # Different variant misses.
        assert _image_cache_get("amiya_2", "preview") is None
        _image_cache_put("amiya_2", "preview", b"\x01" * 50)
        assert _image_cache_get("amiya_2", "preview") == b"\x01" * 50
    finally:
        _image_cache.clear()


def test_image_cache_lru_evicts_by_byte_total(monkeypatch):
    """When total bytes exceed the cap, the oldest entry is evicted."""
    import prts_mcp.tools_artwork as ta

    monkeypatch.setattr(ta, "_IMAGE_CACHE_MAX_BYTES", 150)
    _image_cache.clear()
    try:
        _image_cache_put("a", "large", b"\x00" * 100)
        _image_cache_put("b", "large", b"\x00" * 100)  # total 200 > 150 → evict "a"
        assert _image_cache_get("a", "large") is None
        assert _image_cache_get("b", "large") == b"\x00" * 100
    finally:
        _image_cache.clear()


def test_download_image_safe_rejects_bad_url():
    """The URL pre-check (scheme + host) rejects before any network call."""
    import asyncio

    # http (not https) — rejected pre-stream.
    with pytest.raises(ValueError, match="not allowed"):
        asyncio.run(download_image_safe("http://media.prts.wiki/x.png"))
    # wrong host.
    with pytest.raises(ValueError, match="not allowed"):
        asyncio.run(download_image_safe("https://evil.com/x.png"))
