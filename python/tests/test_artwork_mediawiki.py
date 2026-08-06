"""Tests for LOCAL_IMAGE=false MediaWiki path.

Covers filename→label parsing (base/plus/building-skip/fashion/multi-form),
the image magic-byte check, and the LRU image cache. Network helpers
(list_allimages / get_imageinfo / download_image_safe) are exercised via the
tool-layer mock in test_images.py and are intentionally not re-mocked here —
the security boundary of download_image_safe is validated through its pure
helpers (magic check) plus the documented #85 constraints.
"""
from __future__ import annotations

from prts_mcp.api.prts_wiki import _image_magic_ok
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
