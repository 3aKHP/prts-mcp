from __future__ import annotations

import asyncio
import html as _html
import logging
import re
import secrets

import httpx

from prts_mcp.api.template_renderer import TemplateRenderError, render_template_data
from prts_mcp.config import PRTS_API_ENDPOINT, USER_AGENT, RATE_LIMIT_INTERVAL
from prts_mcp.utils.sanitizer import strip_wikitext

# --- Shared httpx client (connection pooling) ---

_logger = logging.getLogger(__name__)
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(15)
        )
    return _client


# --- Rate limiting (slot-based — thread-safe for asyncio coroutines) ---

_next_allowed_time: float = 0.0


async def _rate_limit() -> None:
    global _next_allowed_time
    now = asyncio.get_event_loop().time()
    slot = max(now, _next_allowed_time)
    _next_allowed_time = slot + RATE_LIMIT_INTERVAL
    wait = slot - now
    if wait > 0:
        await asyncio.sleep(wait)


# --- Wikitext cleanup helpers ---

# MediaWiki parser output contains inline CSS / JS blocks (charinfo font-face,
# RLQ push snippets, etc.) that produce noise after tag stripping.
_CSS_JS_RE = re.compile(
    r"@(font-face|keyframes|media|import|charset|namespace|supports|page)[^{]*\{[^}]*\}|"
    r"\(window\.RLQ\s*\|\|\s*\[\]\)\.push\([^)]*\)|"
    r"<style[^>]*>.*?</style>|"
    r"<script[^>]*>.*?</script>",
    re.DOTALL | re.IGNORECASE,
)

_HTML_TAG_RE = re.compile(r"<[^>]+>")

_HTML_ENTITY_RE = re.compile(r"&#?[a-zA-Z0-9]+;")


_TECHNICAL_PAGE_PATTERNS = (
    re.compile(r"/(?:spine|data|db|lua|json|module)(?:$|[/:._-])", re.IGNORECASE),
    re.compile(r"\.(?:json|lua)$", re.IGNORECASE),
    re.compile(r"^(?:Widget|Template|Module|MediaWiki|模块|模板):", re.IGNORECASE),
)

_REDIRECT_SNIPPET_RE = re.compile(r"#\s*(?:重定向|REDIRECT)", re.IGNORECASE)


def _is_technical_page(title: str) -> bool:
    return any(p.search(title) for p in _TECHNICAL_PAGE_PATTERNS)


def _is_redirect_like(snippet: str) -> bool:
    return bool(_REDIRECT_SNIPPET_RE.search(snippet))


async def _resolve_redirect_title(title: str) -> str | None:
    """Resolve a redirect page title to its target, returning None if unchanged."""
    try:
        await _rate_limit()
        resp = await _get_client().get(
            PRTS_API_ENDPOINT,
            params={
                "action": "query",
                "redirects": "1",
                "titles": title,
                "format": "json",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        redirects = data.get("query", {}).get("redirects", [])
        for item in redirects:
            if item.get("from") == title and item.get("to"):
                return item["to"]
    except Exception as exc:
        _logger.debug("Failed to resolve PRTS redirect title %r: %s", title, exc)
    return None


async def search_prts(
    query: str,
    limit: int = 5,
    search_mode: str = "text",
    filter_technical: bool = True,
) -> dict:
    """Search PRTS wiki.

    Returns:
        {"totalhits": int, "results": list[dict]} where each result has
        "title" and "snippet" keys.

    Raises:
        httpx.HTTPError: If the MediaWiki request fails. Tool wrappers turn
        this into a content-only error rather than misreporting it as no hits.
    """
    await _rate_limit()
    srwhat = "title" if search_mode == "title" else None
    params: dict = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srlimit": str(limit * 2 if filter_technical else limit),
        "srnamespace": "0",
        "srinfo": "totalhits",
        "srprop": "snippet|redirecttitle",
        "format": "json",
    }
    if srwhat:
        params["srwhat"] = srwhat
    resp = await _get_client().get(PRTS_API_ENDPOINT, params=params)
    resp.raise_for_status()
    data = resp.json()
    totalhits = data.get("query", {}).get("searchinfo", {}).get("totalhits", 0)
    results: list[dict] = []
    for item in data.get("query", {}).get("search", []):
        title = item["title"]
        raw_snippet = item.get("snippet", "")
        if not item.get("redirecttitle") and _is_redirect_like(raw_snippet):
            target = await _resolve_redirect_title(title)
            if target:
                title = target
        if filter_technical and _is_technical_page(title):
            continue
        if len(results) >= limit:
            break
        snippet = strip_wikitext(raw_snippet)
        snippet = _html.unescape(snippet)
        snippet = _clean_snippet(snippet)
        results.append({
            "title": title,
            "snippet": snippet,
        })
    return {"totalhits": totalhits, "results": results}


def _strip_html(text: str) -> str:
    """Remove CSS/JS, HTML tags, entities, and collapse whitespace from parsed output."""
    text = _CSS_JS_RE.sub("", text)
    text = _HTML_TAG_RE.sub("", text)
    text = _HTML_ENTITY_RE.sub(lambda m: _html.unescape(m.group(0)), text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


async def read_page(title: str, section_index: int | None = None) -> str:
    """Fetch rendered plain-text content for a PRTS wiki page.

    Args:
        title: Wiki page title.
        section_index: If set, fetch only that section (from prop=sections index).
    """
    await _rate_limit()
    params: dict = {
        "action": "parse",
        "page": title,
        "prop": "text",
        "format": "json",
    }
    if section_index is not None:
        params["section"] = str(section_index)
    try:
        resp = await _get_client().get(PRTS_API_ENDPOINT, params=params)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        return f"读取页面失败：{e}"
    data = resp.json()

    error = data.get("error", {}).get("info", "")
    if error:
        return f"页面 '{title}' 未找到或内容为空。"

    html_text = data.get("parse", {}).get("text", {}).get("*", "")
    if not html_text:
        return f"页面 '{title}' 未找到或内容为空。"

    return _strip_html(html_text)


async def list_sections(title: str) -> list[dict]:
    """Return the table of contents (sections) for a wiki page.

    Each dict has keys: index, level, line, fromtitle.
    Template-transcluded sections have index values like "T-1".
    """
    await _rate_limit()
    params = {
        "action": "parse",
        "page": title,
        "prop": "sections",
        "format": "json",
    }
    resp = await _get_client().get(PRTS_API_ENDPOINT, params=params)
    resp.raise_for_status()
    data = resp.json()
    error = data.get("error", {}).get("info", "")
    if error:
        raise RuntimeError(f"页面 '{title}' 未找到。")
    sections = data.get("parse", {}).get("sections", [])
    return [
        {
            "index": s.get("index", ""),
            "level": s.get("level", ""),
            "line": s.get("line", ""),
            "fromtitle": s.get("fromtitle", ""),
        }
        for s in sections
    ]


async def get_categories(title: str) -> list[str]:
    """Return the category names for a wiki page."""
    await _rate_limit()
    params = {
        "action": "parse",
        "page": title,
        "prop": "categories",
        "format": "json",
    }
    resp = await _get_client().get(PRTS_API_ENDPOINT, params=params)
    resp.raise_for_status()
    data = resp.json()
    error = data.get("error", {}).get("info", "")
    if error:
        raise RuntimeError(f"页面 '{title}' 未找到。")
    return [c["*"] for c in data.get("parse", {}).get("categories", [])]


async def get_links(
    title: str,
    direction: str = "outbound",
    limit: int = 30,
) -> dict:
    """Return outbound or inbound links for a wiki page.

    Returns:
        {"title": str, "links": list[str], "total": int, "has_more": bool}
    """
    await _rate_limit()
    if direction == "outbound":
        params = {
            "action": "parse",
            "page": title,
            "prop": "links",
            "format": "json",
        }
        resp = await _get_client().get(PRTS_API_ENDPOINT, params=params)
        resp.raise_for_status()
        data = resp.json()
        error = data.get("error", {}).get("info", "")
        if error:
            raise RuntimeError(f"页面 '{title}' 未找到。")
        all_links = [l["*"] for l in data.get("parse", {}).get("links", [])]
        return {
            "title": title,
            "links": all_links[:limit],
            "total": len(all_links),
            "has_more": len(all_links) > limit,
        }

    if direction != "inbound":
        raise ValueError(f"无效的 direction 参数：{direction!r}，可选值：outbound、inbound。")

    # inbound: use list=backlinks
    params = {
        "action": "query",
        "list": "backlinks",
        "bltitle": title,
        "bllimit": min(limit, 500),
        "blnamespace": "0",
        "format": "json",
    }
    resp = await _get_client().get(PRTS_API_ENDPOINT, params=params)
    resp.raise_for_status()
    data = resp.json()
    backlinks = data.get("query", {}).get("backlinks", [])
    links = [bl["title"] for bl in backlinks]
    has_more = "continue" in data
    return {
        "title": title,
        "links": links[:limit],
        "total": len(links),
        "has_more": has_more,
    }


async def _render_template_batch(title: str, values: list[str]) -> list[str]:
    """Render nested template values in one MediaWiki POST request."""
    if not values:
        return []

    prefix = f"PRTSMCP_{secrets.token_hex(16)}"
    markers = [
        (f"{prefix}_BEGIN_{index}_", f"{prefix}_END_{index}_")
        for index in range(len(values))
    ]
    text = "\n\n".join(
        f"{begin}\n{value}\n{end}"
        for value, (begin, end) in zip(values, markers, strict=True)
    )

    await _rate_limit()
    try:
        response = await _get_client().post(
            PRTS_API_ENDPOINT,
            data={
                "action": "parse",
                "title": title,
                "text": text,
                "prop": "text",
                "format": "json",
            },
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise TemplateRenderError("模板字段渲染请求失败。") from exc

    try:
        data = response.json()
    except (TypeError, ValueError) as exc:
        raise TemplateRenderError("模板字段渲染请求失败。") from exc
    if not isinstance(data, dict):
        raise TemplateRenderError("模板字段渲染响应格式无效。")

    error = data.get("error")
    if isinstance(error, dict) and error.get("info"):
        raise TemplateRenderError("模板字段渲染请求失败。")

    parse = data.get("parse")
    text = parse.get("text") if isinstance(parse, dict) else None
    html_text = text.get("*") if isinstance(text, dict) else None
    if not isinstance(html_text, str):
        raise TemplateRenderError("模板字段渲染响应格式无效。")

    rendered = _strip_html(html_text)
    if not rendered:
        raise TemplateRenderError("模板字段渲染结果为空。")

    values_out: list[str] = []
    for begin, end in markers:
        if rendered.count(begin) != 1 or rendered.count(end) != 1:
            raise TemplateRenderError("模板字段渲染边界无效。")
        start = rendered.index(begin) + len(begin)
        finish = rendered.index(end, start)
        value = rendered[start:finish].strip()
        values_out.append(value)
    return values_out


async def get_template_data(title: str) -> dict:
    """Return top-level structured template data with readable nested values."""
    await _rate_limit()
    params = {
        "action": "parse",
        "page": title,
        "prop": "parsetree",
        "format": "json",
    }
    resp = await _get_client().get(PRTS_API_ENDPOINT, params=params)
    resp.raise_for_status()
    data = resp.json()

    error = data.get("error", {}).get("info", "")
    if error:
        raise RuntimeError(f"页面 '{title}' 未找到。")

    xml_str = data.get("parse", {}).get("parsetree", {}).get("*", "")
    if not xml_str:
        raise RuntimeError(f"页面 '{title}' 无 parsetree 数据。")

    return await render_template_data(title, xml_str, _render_template_batch)


def _clean_snippet(snippet: str) -> str:
    """Remove residual wikitext artifacts from a search snippet."""
    # Remove JSON key-value fragments from technical data pages
    snippet = re.sub(r'\s*"[^"]*"\s*:\s*"[^"]*"\s*,?\s*', " ", snippet)
    # Remove isolated pipe-value artifacts with Chinese keys
    snippet = re.sub(r"\|[一-鿿\w]+\s*=[^\n]*", "", snippet)
    snippet = _REDIRECT_SNIPPET_RE.sub("", snippet)
    # Collapse whitespace
    snippet = re.sub(r"[ \t]+", " ", snippet)
    snippet = re.sub(r",{2,}", "", snippet)
    snippet = re.sub(r"\n{2,}", "\n", snippet)
    return snippet.strip(" ,\n")


# ---------------------------------------------------------------------------
# Image helpers (LOCAL_IMAGE=false MediaWiki fallback)
#
# These serve operator_artwork when LOCAL_IMAGE=false: discover File: titles
# via allimages, fetch variant URLs via imageinfo, and download the pixel data
# under the full #85 security boundary. Mirrors the python-side path A (local
# AKDP assets) at the tool-contract level but pulls everything from PRTS.
# ---------------------------------------------------------------------------

_ALLOWED_IMAGE_HOSTS: tuple[str, ...] = ("media.prts.wiki",)
_ALLOWED_IMAGE_MIMES: tuple[str, ...] = ("image/png", "image/jpeg", "image/webp")
_MAX_IMAGE_BYTES = 1024 * 1024  # 1 MiB decoded cap (#85)


def _image_magic_ok(data: bytes, mime: str) -> bool:
    """Verify the payload's magic bytes against its declared MIME type."""
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime == "image/webp":
        # RIFF <4 size bytes> WEBP
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


async def list_allimages(prefix: str, limit: int = 50) -> list[dict]:
    """List PRTS ``File:`` titles whose name starts with ``prefix``.

    Returns dicts with ``name``/``size``/``mime``. Used by operator_artwork's
    false-mode list to discover ``立绘_<name>_*`` files. Paginates via
    MediaWiki continuation when results exceed ``limit``.
    """
    params = {
        "action": "query",
        "list": "allimages",
        "aiprefix": prefix,
        "ailimit": str(limit),
        "aiprop": "name|size|mime",
        "format": "json",
    }
    results: list[dict] = []
    pages = 0
    while True:
        if pages >= 50:
            raise RuntimeError("allimages pagination exceeded 50 pages")
        pages += 1
        await _rate_limit()
        resp = await _get_client().get(PRTS_API_ENDPOINT, params=params)
        resp.raise_for_status()
        data = resp.json()
        results.extend(
            {
                "name": a.get("name", ""),
                "size": a.get("size", 0),
                "mime": a.get("mime", ""),
            }
            for a in data.get("query", {}).get("allimages", [])
        )
        cont = data.get("continue")
        if not cont:
            break
        params.update({k: str(v) for k, v in cont.items()})
    return results


async def get_imageinfo(title: str, width: int | None = None) -> dict | None:
    """Fetch image URLs/metadata for a ``File:`` title.

    With ``width`` set, the result carries ``thumburl`` at that pixel width
    (large=1024 / preview=256). Without it only the original ``url`` is set.
    """
    await _rate_limit()
    full_title = title if title.startswith("File:") else f"File:{title}"
    params: dict = {
        "action": "query",
        "titles": full_title,
        "prop": "imageinfo",
        "iiprop": "url|size|mime",
        "format": "json",
    }
    if width is not None:
        params["iiurlwidth"] = str(width)
    resp = await _get_client().get(PRTS_API_ENDPOINT, params=params)
    resp.raise_for_status()
    data = resp.json()
    for page in data.get("query", {}).get("pages", {}).values():
        ii = page.get("imageinfo") or []
        if ii:
            info = ii[0]
            return {
                "url": info.get("url"),
                "thumburl": info.get("thumburl"),
                "width": info.get("width"),
                "height": info.get("height"),
                "mime": info.get("mime"),
                "size": info.get("size"),
            }
    return None


async def download_image_safe(url: str) -> bytes:
    """Download an image under the full #85 security boundary.

    Checks: HTTPS + hostname ``media.prts.wiki`` (re-validated after redirect),
    Content-Type in the MIME allowlist, streaming read capped at 1 MiB, and
    magic-byte verification of the final payload. Raises ``ValueError`` on any
    violation; the tool layer degrades that to a text-only result (no partial
    image is ever returned).
    """
    parsed = httpx.URL(url)
    if parsed.scheme != "https" or parsed.host not in _ALLOWED_IMAGE_HOSTS:
        raise ValueError(f"image URL host not allowed: {parsed.host}")
    await _rate_limit()
    async with _get_client().stream(
        "GET", url, follow_redirects=True, timeout=httpx.Timeout(30.0),
    ) as resp:
        if resp.status_code != 200:
            raise ValueError(f"image fetch HTTP {resp.status_code}")
        final = resp.url
        if final.scheme != "https" or final.host not in _ALLOWED_IMAGE_HOSTS:
            raise ValueError(f"redirected to disallowed host: {final.host}")
        ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        if ctype not in _ALLOWED_IMAGE_MIMES:
            raise ValueError(f"bad content-type: {ctype!r}")
        buf = bytearray()
        async for chunk in resp.aiter_bytes(chunk_size=8192):
            buf.extend(chunk)
            if len(buf) > _MAX_IMAGE_BYTES:
                raise ValueError(f"image exceeds {_MAX_IMAGE_BYTES} byte cap")
        data = bytes(buf)
    if not _image_magic_ok(data, ctype):
        raise ValueError(f"magic bytes mismatch for {ctype!r}")
    return data
