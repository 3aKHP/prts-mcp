from __future__ import annotations

import asyncio
import html as _html
import logging
import re

import xml.etree.ElementTree as ET

import httpx

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


async def get_template_data(title: str) -> dict:
    """Return structured key-value data from template calls on a wiki page.

    Fetches the page's parsetree via action=parse&prop=parsetree and extracts
    key=value parts from every TOP-LEVEL template that uses the <name>kv</name>
    pattern (e.g. {{CharinfoV2}}, {{敌人信息/common2}}, {{道具信息}}).

    Nested templates inside a value (e.g. {{color|...}} inside CharinfoV2's
    特性 field) are stripped from the value text — they are NOT yielded as
    separate top-level entries. This matches the TS implementation.

    Named-positional (index) templates like {{Navigator}} or {{参阅}} are
    included as positional fields in the dict value.
    """
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

    root = ET.fromstring(xml_str)
    templates: dict[str, dict] = {}

    # Only iterate top-level <template> children of <root>, not nested ones.
    for elem in root.findall("template"):
        t_title_elem = elem.find("title")
        if t_title_elem is None:
            continue
        # Strip nested <comment> tags out of title before extracting text.
        comment_text = ""
        for sub in list(t_title_elem):
            if sub.tag == "comment":
                if sub.text:
                    comment_text = sub.text.strip()
                if sub.tail:
                    t_title_elem.text = (t_title_elem.text or "") + sub.tail
                t_title_elem.remove(sub)
        t_name = (t_title_elem.text or "").strip()
        if not t_name:
            continue

        kv: dict[str, str] = {}
        positional: list[str] = []

        for part in elem.findall("part"):
            name_el = part.find("name")
            value_el = part.find("value")
            if value_el is None:
                continue

            # Get full text of <value>, stripping any nested <template> children.
            for nested in list(value_el.findall("template")):
                if nested.tail:
                    value_el.text = (value_el.text or "") + nested.tail
                value_el.remove(nested)
            val = (value_el.text or "").strip()
            if not val:
                continue

            if name_el is not None and "index" in name_el.attrib:
                positional.append(val)
            elif name_el is not None and name_el.text:
                key = name_el.text.strip()
                if key:
                    kv[key] = val

        entry: dict = {}
        if kv:
            entry.update(kv)
        if positional:
            entry["_positional"] = positional
        if comment_text:
            entry["_comment"] = comment_text

        if entry:
            templates[t_name] = entry

    return templates


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
