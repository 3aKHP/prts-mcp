from __future__ import annotations

import asyncio
import httpx

from prts_mcp.config import PRTS_API_ENDPOINT, USER_AGENT, RATE_LIMIT_INTERVAL
from prts_mcp.utils.sanitizer import strip_wikitext

_last_request_time: float = 0.0


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
        "format": "json",
    }
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=15) as client:
        resp = await client.get(PRTS_API_ENDPOINT, params=params)
        resp.raise_for_status()
    data = resp.json()
    results = []
    for item in data.get("query", {}).get("search", []):
        results.append({
            "title": item["title"],
            "snippet": strip_wikitext(item.get("snippet", "")),
        })
    return results


async def read_page(title: str) -> str:
    """Fetch plain-text extract for a PRTS wiki page."""
    await _rate_limit()
    params = {
        "action": "query",
        "titles": title,
        "prop": "extracts",
        "explaintext": "1",
        "format": "json",
    }
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=15) as client:
        resp = await client.get(PRTS_API_ENDPOINT, params=params)
        resp.raise_for_status()
    pages = resp.json().get("query", {}).get("pages", {})
    for page in pages.values():
        extract = page.get("extract", "")
        if extract:
            return strip_wikitext(extract)
    return f"页面 '{title}' 未找到或内容为空。"
