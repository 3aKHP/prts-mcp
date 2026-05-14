from __future__ import annotations

import asyncio
import html as _html
import re

import httpx

from prts_mcp.config import PRTS_API_ENDPOINT, USER_AGENT, RATE_LIMIT_INTERVAL
from prts_mcp.utils.sanitizer import strip_wikitext

_last_request_time: float = 0.0

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


async def _rate_limit() -> None:
    global _last_request_time
    now = asyncio.get_event_loop().time()
    elapsed = now - _last_request_time
    if elapsed < RATE_LIMIT_INTERVAL:
        await asyncio.sleep(RATE_LIMIT_INTERVAL - elapsed)
    _last_request_time = asyncio.get_event_loop().time()


async def search_prts(query: str, limit: int = 5) -> list[dict]:
    """Search PRTS wiki and return a list of {title, snippet} dicts."""
    await _rate_limit()
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srlimit": limit,
        "srnamespace": "0",
        "format": "json",
    }
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=15) as client:
        resp = await client.get(PRTS_API_ENDPOINT, params=params)
        resp.raise_for_status()
    data = resp.json()
    results = []
    for item in data.get("query", {}).get("search", []):
        snippet = strip_wikitext(item.get("snippet", ""))
        snippet = _html.unescape(snippet)
        snippet = _clean_snippet(snippet)
        results.append({
            "title": item["title"],
            "snippet": snippet,
        })
    return results


async def read_page(title: str) -> str:
    """Fetch rendered plain-text content for a PRTS wiki page."""
    await _rate_limit()
    params = {
        "action": "parse",
        "page": title,
        "prop": "text",
        "format": "json",
    }
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=15) as client:
        resp = await client.get(PRTS_API_ENDPOINT, params=params)
        resp.raise_for_status()
    data = resp.json()

    error = data.get("error", {}).get("info", "")
    if error:
        return f"页面 '{title}' 未找到或内容为空。"

    html_text = data.get("parse", {}).get("text", {}).get("*", "")
    if not html_text:
        return f"页面 '{title}' 未找到或内容为空。"

    # Remove CSS rules and inline JS that survive HTML stripping as noise
    text = _CSS_JS_RE.sub("", html_text)
    # Strip HTML tags
    text = _HTML_TAG_RE.sub("", text)
    # Decode remaining HTML entities
    text = _HTML_ENTITY_RE.sub(lambda m: _html.unescape(m.group(0)), text)
    # Collapse whitespace
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _clean_snippet(snippet: str) -> str:
    """Remove residual wikitext artifacts from a search snippet."""
    # Remove JSON key-value fragments from technical data pages
    snippet = re.sub(r'\s*"[^"]*"\s*:\s*"[^"]*"\s*,?\s*', " ", snippet)
    # Remove isolated pipe-value artifacts with Chinese keys
    snippet = re.sub(r"\|[一-鿿\w]+\s*=[^\n]*", "", snippet)
    snippet = re.sub(r"#重定向|#REDIRECT", "", snippet)
    # Collapse whitespace
    snippet = re.sub(r"[ \t]+", " ", snippet)
    snippet = re.sub(r",{2,}", "", snippet)
    snippet = re.sub(r"\n{2,}", "\n", snippet)
    return snippet.strip(" ,\n")
