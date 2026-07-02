"""Full-text search across operator data tables."""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

from prts_mcp.config import Config
from prts_mcp.data.operator import (
    _build_name_to_id,
    _load_character_table,
    _load_charword_table,
    _load_handbook_table,
)
from prts_mcp.utils.sanitizer import strip_wikitext


@dataclass(frozen=True)
class _OperatorSearchRecord:
    operator: str
    category: str
    field: str
    text: str


def clear_search_caches() -> None:
    """Clear cached cross-table search records."""
    _operator_search_records.cache_clear()


def search_operator_data(pattern: str, max_results: int = 30) -> str:
    """Search operator names, archive texts, and voice lines by regex.

    Case-insensitive.  Returns a formatted multi-block string.
    """
    data = build_operator_search(pattern, max_results=max_results)
    if isinstance(data, str):
        return data
    return render_operator_search(data)


def build_operator_search(pattern: str, max_results: int = 30) -> dict | str:
    """Build the structured payload for operator-data search."""
    if max_results < 1:
        return "max_results 必须 >= 1。"
    if max_results > 100:
        return "max_results 必须 <= 100。"

    config = Config.load()
    if not config.has_operator_data:
        return (
            "干员数据暂不可用。"
            "容器启动时的 auto-sync 可能仍在进行中，请稍后重试；"
            "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。"
            f"（当前同步目标路径：{config.excel_path}）"
        )

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return f"正则表达式无效：{exc}"

    results: list[_OperatorSearchRecord] = []
    for record in _operator_search_records():
        if regex.search(record.text):
            results.append(record)
            if len(results) >= max_results:
                break

    return {
        "scope": "operators",
        "pattern": pattern,
        "total": len(results),
        "results": [
            {
                "operator": r.operator,
                "category": r.category,
                "field": r.field,
                "text": r.text,
            }
            for r in results
        ],
    }


def render_operator_search(data: dict) -> str:
    """Render an operator search payload to markdown."""
    pattern = data["pattern"]
    results = data["results"]
    if not results:
        return f"未找到匹配 '{pattern}' 的干员数据。"

    blocks = [f"# 搜索 \"{pattern}\" 的结果（共 {data['total']} 条）"]
    for r in results:
        blocks.append(
            f"\n---\n\n"
            f"[operators/{r['category']}/{r['operator']}]\n"
            f"匹配：{r['field']}\n"
            f"{r['text']}"
        )
    return "".join(blocks)


def build_search(scope: str, pattern: str, max_results: int = 30) -> dict | str:
    """Build the structured payload for the unified gamedata search tool."""
    if scope == "operators":
        return build_operator_search(pattern, max_results=max_results)
    if scope == "enemies":
        from prts_mcp.data.enemy import build_enemy_search

        return build_enemy_search(pattern, max_results=max_results)
    if scope == "stages":
        from prts_mcp.data.stage import build_stage_search

        return build_stage_search(pattern, max_results=max_results)
    if scope == "items":
        from prts_mcp.data.item import build_item_search

        return build_item_search(pattern, max_results=max_results)
    return f"不支持的搜索域：{scope!r}。可选：operators、enemies、stages、items。"


def render_search(data: dict) -> str:
    """Render a unified gamedata search payload to markdown."""
    scope = data["scope"]
    if scope == "operators":
        return render_operator_search(data)
    if scope == "enemies":
        from prts_mcp.data.enemy import render_enemy_search

        return render_enemy_search(data)
    if scope == "stages":
        from prts_mcp.data.stage import render_stage_search

        return render_stage_search(data)
    if scope == "items":
        from prts_mcp.data.item import render_item_search

        return render_item_search(data)
    raise ValueError(f"不支持的搜索域：{scope!r}。")


@lru_cache(maxsize=1)
def _operator_search_records() -> tuple[_OperatorSearchRecord, ...]:
    ct = _load_character_table()
    handbook = _load_handbook_table().get("handbookDict", {})
    charwords = _load_charword_table().get("charWords", {})
    name_to_id = _build_name_to_id()

    charid_to_voices: dict[str, list[dict]] = {}
    for entry in charwords.values():
        cid = entry.get("charId")
        if cid and entry.get("voiceText"):
            charid_to_voices.setdefault(cid, []).append(entry)

    records: list[_OperatorSearchRecord] = []
    for name, char_id in name_to_id.items():
        info = ct.get(char_id)
        if info is None:
            continue

        records.append(_OperatorSearchRecord(
            operator=name,
            category="basic",
            field="干员名称",
            text=name,
        ))

        desc = info.get("description") or ""
        if desc:
            records.append(_OperatorSearchRecord(
                operator=name,
                category="basic",
                field="攻击属性",
                text=strip_wikitext(desc),
            ))

        hb_entry = handbook.get(char_id)
        if hb_entry:
            for story in hb_entry.get("storyTextAudio", []):
                title = story.get("storyTitle", "")
                for s in story.get("stories", []):
                    text = s.get("storyText", "")
                    if text:
                        records.append(_OperatorSearchRecord(
                            operator=name,
                            category="archives",
                            field=title,
                            text=text,
                        ))

        for v in charid_to_voices.get(char_id, []):
            records.append(_OperatorSearchRecord(
                operator=name,
                category="voicelines",
                field=v.get("voiceTitle", "未知"),
                text=v["voiceText"],
            ))

    return tuple(records)
