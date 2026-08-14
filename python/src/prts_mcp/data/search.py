"""Full-text search across operator data tables."""

from __future__ import annotations

import re
from dataclasses import dataclass

from prts_mcp.config import Config
from prts_mcp.data.dataset_access import (
    DatasetSpec,
    LoaderSpec,
    define_dataset,
)
from prts_mcp.data.messages import (
    excel_missing_message,
    regex_error_message,
    validate_bounds,
)
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
    _access.clear()


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
    if message := validate_bounds("max_results", max_results, minimum=1, maximum=100):
        return message

    if not Config.load().has_operator_data:
        return _access.missing_message()

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return regex_error_message(exc)

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


def _operator_search_records_impl() -> tuple[_OperatorSearchRecord, ...]:
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


_access = define_dataset(DatasetSpec(
    name="search",
    loaders={
        "search_records": LoaderSpec(load=_operator_search_records_impl),
    },
    missing_message=excel_missing_message("干员"),
))

_operator_search_records = _access.cached("search_records")


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count}}`` for instrumentation (#104)."""
    return _access.stats()
