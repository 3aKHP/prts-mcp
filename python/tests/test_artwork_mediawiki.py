"""Tests for LOCAL_IMAGE=false MediaWiki path.

Covers filename→label parsing, the image magic-byte check, the LRU cache
eviction, the download_image_safe boundary (URL pre-check + in-stream
rejection paths via httpx MockTransport), and list_allimages pagination.
"""
from __future__ import annotations

import pytest

from prts_mcp.api.prts_wiki import _image_magic_ok, download_image_safe, list_allimages
from prts_mcp.data.artwork_mediawiki import (
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
    import prts_mcp.data.artwork_mediawiki as am

    monkeypatch.setattr(am, "_IMAGE_CACHE_MAX_BYTES", 150)
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


# ---------------------------------------------------------------------------
# download_image_safe: in-stream rejection paths (httpx MockTransport)
# ---------------------------------------------------------------------------


def _mock_image_download(monkeypatch, handler):
    """Patch _rate_limit (no-op) + _get_client (MockTransport); return coroutine."""
    import httpx
    import prts_mcp.api.prts_wiki as pw

    async def _noop():
        pass

    monkeypatch.setattr(pw, "_rate_limit", _noop)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(pw, "_get_client", lambda: client)

    async def _coro():
        try:
            return await pw.download_image_safe("https://media.prts.wiki/img.png")
        finally:
            await client.aclose()

    return _coro()


def test_download_safe_rejects_redirect_to_bad_host(monkeypatch):
    """Post-redirect scheme/host change is caught after the stream opens."""
    import asyncio
    import httpx

    def handler(request):
        if request.url.host == "media.prts.wiki":
            return httpx.Response(302, headers={"location": "http://evil.com/img.png"})
        return httpx.Response(200, content=b"\x89PNG\r\n\x1a\n",
                              headers={"content-type": "image/png"})

    with pytest.raises(ValueError, match="disallowed"):
        asyncio.run(_mock_image_download(monkeypatch, handler))


def test_download_safe_rejects_bad_content_type(monkeypatch):
    """Non-allowlist Content-Type is rejected before reading the body."""
    import asyncio
    import httpx

    def handler(request):
        return httpx.Response(200, content=b"x", headers={"content-type": "text/html"})

    with pytest.raises(ValueError, match="content-type"):
        asyncio.run(_mock_image_download(monkeypatch, handler))


def test_download_safe_rejects_magic_mismatch(monkeypatch):
    """Valid Content-Type but wrong magic bytes → rejection after full read."""
    import asyncio
    import httpx

    def handler(request):
        return httpx.Response(200, content=b"not-an-image",
                              headers={"content-type": "image/png"})

    with pytest.raises(ValueError, match="magic"):
        asyncio.run(_mock_image_download(monkeypatch, handler))


def test_download_safe_rejects_oversized_body(monkeypatch):
    """Body exceeding the 1 MiB cap is rejected mid-stream."""
    import asyncio
    import httpx
    import prts_mcp.api.prts_wiki as pw

    def handler(request):
        body = b"\x89PNG\r\n\x1a\n" + b"\x00" * (pw._MAX_IMAGE_BYTES + 1)
        return httpx.Response(200, content=body, headers={"content-type": "image/png"})

    with pytest.raises(ValueError, match="exceeds"):
        asyncio.run(_mock_image_download(monkeypatch, handler))


# ---------------------------------------------------------------------------
# list_allimages pagination
# ---------------------------------------------------------------------------


def test_list_allimages_paginates(monkeypatch):
    """allimages loops on MediaWiki continue tokens to collect all pages."""
    import asyncio
    import httpx
    import prts_mcp.api.prts_wiki as pw

    async def _noop():
        pass

    monkeypatch.setattr(pw, "_rate_limit", _noop)

    def handler(request):
        if "aicontinue" in str(request.url):
            return httpx.Response(200, json={
                "query": {"allimages": [
                    {"name": "立绘_阿米娅_2.png", "size": 200, "mime": "image/png"},
                ]},
            })
        return httpx.Response(200, json={
            "query": {"allimages": [
                {"name": "立绘_阿米娅_1.png", "size": 100, "mime": "image/png"},
            ]},
            "continue": {"aicontinue": "立绘_阿米娅_2.png", "continue": "-||"},
        })

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(pw, "_get_client", lambda: client)

    async def _run():
        try:
            return await list_allimages("立绘_阿米娅_")
        finally:
            await client.aclose()

    result = asyncio.run(_run())
    assert len(result) == 2
    assert result[0]["name"] == "立绘_阿米娅_1.png"
    assert result[1]["name"] == "立绘_阿米娅_2.png"
