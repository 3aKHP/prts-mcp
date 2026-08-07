from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from prts_mcp.config import Config, activation_aware_cache, cache_stat, register_activation_listener
from prts_mcp.data.stores import DirectoryStore


_ITEM_FILE = "item_table.json"

_CLASSIFY_LABELS: dict[str, str] = {
    "MATERIAL": "材料",
    "NORMAL": "普通",
    "CONSUME": "消耗品",
    "NONE": "其他",
}

_OCCURRENCE_LABELS: dict[str, str] = {
    "ALWAYS": "固定",
    "ALMOST": "大概率",
    "USUAL": "常规",
    "OFTEN": "较高概率",
    "SOMETIMES": "小概率",
}

_CATEGORY_ALIASES: dict[str, str] = {
    "MATERIALS": "MATERIAL",
    "材料": "MATERIAL",
    "物资": "MATERIAL",
    "NORMAL": "NORMAL",
    "普通": "NORMAL",
    "CONSUME": "CONSUME",
    "消耗品": "CONSUME",
    "NONE": "NONE",
    "其他": "NONE",
}


@dataclass(frozen=True)
class _ItemSearchRecord:
    item_id: str
    info: dict[str, Any]
    search_text: str


def _get_config() -> Config:
    return Config.load()


def _store() -> DirectoryStore:
    ep = _get_config().effective_excel_path
    if ep is None:
        raise RuntimeError("effective_excel_path is None — GAMEDATA_PATH may be unset")
    return DirectoryStore(ep)


def _missing_data_message() -> str:
    config = _get_config()
    return (
        "物品数据暂不可用。请检查 GAMEDATA_PATH 配置，"
        "或等待服务器自动从 GitHub Release 同步数据完成后重试。"
        f"（当前同步目标路径：{config.excel_path}）"
    )


def _normalize_category(category: str) -> str:
    key = category.strip().upper()
    return _CATEGORY_ALIASES.get(key, _CATEGORY_ALIASES.get(category.strip(), key))


def _rarity_label(raw: str) -> str:
    return raw.replace("TIER_", "T") if raw.startswith("TIER_") else raw


def _classify_label(raw: str) -> str:
    return _CLASSIFY_LABELS.get(raw, raw or "-")


def _occurrence_label(raw: str) -> str:
    return _OCCURRENCE_LABELS.get(raw, raw or "?")


def _short_text(text: str, limit: int = 80) -> str:
    text = " ".join(text.split())
    return text[:limit] + ("..." if len(text) > limit else "")


@activation_aware_cache(maxsize=1)
def _load_items() -> dict[str, dict[str, Any]]:
    store = _store()
    if not store.exists(_ITEM_FILE):
        raise FileNotFoundError(f"物品数据文件不存在：{store.root / _ITEM_FILE}。")
    raw = store.read_json(_ITEM_FILE)
    if not isinstance(raw, dict):
        raise TypeError(f"{_ITEM_FILE} top-level shape mismatch")
    items = raw.get("items")
    if not isinstance(items, dict):
        raise TypeError(f"{_ITEM_FILE} missing 'items' dict")
    return items


@activation_aware_cache(maxsize=1)
def _build_item_lookup() -> dict[str, str]:
    mapping: dict[str, str] = {}
    for item_id, info in _load_items().items():
        mapping[str(item_id)] = str(item_id)
        name = info.get("name")
        if name:
            mapping.setdefault(str(name), str(item_id))
    return mapping


def clear_item_caches() -> None:
    _load_items.cache_clear()
    _build_item_lookup.cache_clear()
    _item_search_records.cache_clear()


register_activation_listener(clear_item_caches)


def get_item_name_by_id(item_id: str) -> str | None:
    """Return an item display name for stage/drop formatting."""
    if not item_id:
        return None
    try:
        item = _load_items().get(item_id)
    except (FileNotFoundError, RuntimeError, TypeError):
        return None
    if not item:
        return None
    name = item.get("name")
    return str(name) if name else None


def _resolve_item_id(name: str) -> str | None:
    return _build_item_lookup().get(name)


def _visible_items() -> list[tuple[str, dict[str, Any]]]:
    return [
        (item_id, info)
        for item_id, info in _load_items().items()
        if not info.get("hideInItemGet") and info.get("name")
    ]


def _format_stage_drops(drop_list: list[dict[str, Any]], max_entries: int = 12) -> str:
    if not drop_list:
        return "（无）"
    parts: list[str] = []
    for entry in sorted(drop_list, key=lambda e: e.get("sortId", 9999))[:max_entries]:
        stage_id = entry.get("stageId") or "?"
        occ = _occurrence_label(str(entry.get("occPer") or ""))
        parts.append(f"- {stage_id}（{occ}）")
    if len(drop_list) > max_entries:
        parts.append(f"- ...另有 {len(drop_list) - max_entries} 个关卡")
    return "\n".join(parts)


def _format_related(label: str, entries: Any) -> list[str]:
    if not isinstance(entries, list) or not entries:
        return []
    lines = [f"\n## {label}"]
    for entry in entries[:10]:
        if isinstance(entry, dict):
            bits = [f"{k}={v}" for k, v in entry.items() if v not in (None, "")]
            lines.append("- " + ("，".join(bits) if bits else "（空）"))
        else:
            lines.append(f"- {entry}")
    if len(entries) > 10:
        lines.append(f"- ...另有 {len(entries) - 10} 条")
    return lines


def build_items_listing(
    category: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict | str:
    """Build the structured payload for an items listing.

    Returns the dict payload on success, or a markdown error string on a
    validation / missing-data / empty-result path.
    """
    if limit < 1:
        return "limit 必须 >= 1。"
    if limit > 200:
        return "limit 必须 <= 200。"
    if offset < 0:
        return "offset 必须 >= 0。"

    try:
        entries = _visible_items()
    except (FileNotFoundError, RuntimeError, TypeError) as exc:
        return _missing_data_message() + f"（{exc}）"

    category_filter = _normalize_category(category) if category else None
    if category_filter:
        entries = [
            (item_id, info)
            for item_id, info in entries
            if info.get("classifyType") == category_filter or info.get("itemType") == category_filter
        ]

    entries.sort(key=lambda kv: (kv[1].get("sortId", 999999), kv[0]))
    total = len(entries)
    page = entries[offset : offset + limit]

    # Legitimate-but-empty results (no match / offset past end) are a normal
    # structured payload, NOT an error — structured consumers can rely on
    # "empty ⇒ {total:0, items:[]}" (P2b plan §3.4). The renderer still emits
    # the original human-readable message, so content is byte-for-byte stable.
    if not page:
        empty_reason = "no_match" if total == 0 else "offset_out_of_range"
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "filters": {"category": category, "category_filter": category_filter},
            "items": [],
            "empty_reason": empty_reason,
        }

    item_entries = []
    for item_id, info in page:
        item_entries.append({
            "item_id": item_id,
            "name": info.get("name") or "（无名）",
            "rarity_raw": str(info.get("rarity") or ""),
            "rarity_label": _rarity_label(str(info.get("rarity") or "")),
            "classify_raw": str(info.get("classifyType") or ""),
            "classify_label": _classify_label(str(info.get("classifyType") or "")),
            "item_type": info.get("itemType") or "-",
            "usage_excerpt": _short_text(str(info.get("usage") or info.get("description") or "")),
        })

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        # `category` is the raw user input (echoed in the title verbatim,
        # matching the pre-refactor behaviour); `category_filter` is the
        # normalized value actually used for filtering.
        "filters": {"category": category, "category_filter": category_filter},
        "items": item_entries,
    }


def render_items_listing(data: dict) -> str:
    """Render an items-listing payload dict to markdown.

    Pure renderer; the inverse of ``build_items_listing``'s success path.
    """
    # Legitimate-but-empty results render as the original human message
    # (byte-for-byte stable content) while the structured payload carries
    # {total:0, items:[]} for capable clients.
    empty_reason = data.get("empty_reason")
    if empty_reason == "no_match":
        return f"没有匹配的物品（category={data['filters']['category'] or 'none'}）。"
    if empty_reason == "offset_out_of_range":
        return f"offset {data['offset']} 超出范围（共 {data['total']} 条）。"

    total = data["total"]
    offset = data["offset"]
    limit = data["limit"]
    category = data["filters"]["category"]
    items = data["items"]

    title = f"# 物品列表：{category}（共 {total} 个）" if category else f"# 物品列表（共 {total} 个）"
    lines = [title]
    for it in items:
        line = (
            f"- **{it['name']}** [{it['classify_label']}/{it['item_type']}] "
            f"{it['rarity_label']}（id: {it['item_id']}）"
        )
        if it["usage_excerpt"]:
            line += f" — {it['usage_excerpt']}"
        lines.append(line)

    start = offset + 1
    end = min(offset + limit, total)
    lines.append(
        f"\n（显示第 {start}–{end} 条，共 {total} 条。"
        f"使用 offset={offset + limit} 查看下一页）"
    )
    return "\n".join(lines)


def list_items(
    category: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> str:
    """List visible items with optional classifyType/itemType filtering."""
    data = build_items_listing(category=category, limit=limit, offset=offset)
    if isinstance(data, str):
        return data
    return render_items_listing(data)


def build_item_info(name: str) -> dict | str:
    """Build the structured payload for a single item's detail.

    Returns the dict payload on success, or a markdown error string on a
    missing-data / not-found path. The dict is the single source of truth
    that ``render_item_info`` consumes.
    """
    try:
        item_id = _resolve_item_id(name)
    except (FileNotFoundError, RuntimeError, TypeError) as exc:
        return _missing_data_message() + f"（{exc}）"
    if item_id is None:
        return f"未找到物品：{name!r}。"

    info = _load_items().get(item_id)
    if info is None:
        return f"物品 {name!r} 暂无详细信息。"

    return {
        "name": info.get("name") or name,
        "item_id": item_id,
        "rarity_raw": str(info.get("rarity") or ""),
        "rarity_label": _rarity_label(str(info.get("rarity") or "")),
        "classify_raw": str(info.get("classifyType") or ""),
        "classify_label": _classify_label(str(info.get("classifyType") or "")),
        "item_type": info.get("itemType") or "-",
        "icon_id": info.get("iconId") or None,
        "obtain_approach": info.get("obtainApproach") or None,
        "description": info.get("description") or None,
        "usage": info.get("usage") or None,
        "stage_drop_list": info.get("stageDropList") or [],
        "building_product_list": info.get("buildingProductList"),
        "shop_relate_list": info.get("shopRelateInfoList"),
        "voucher_relate_list": info.get("voucherRelateList"),
    }


def render_item_info(data: dict) -> str:
    """Render an item-detail payload dict to markdown.

    Pure renderer; the inverse of ``build_item_info``'s success path.
    Reuses ``_format_stage_drops`` / ``_format_related`` for the drop and
    related sections so the output stays byte-for-byte equivalent.
    """
    parts = [f"# {data['name']} — 物品信息", "", "## 基本信息"]
    parts.append(f"- **ID**：{data['item_id']}")
    parts.append(f"- **稀有度**：{data['rarity_label']}")
    parts.append(f"- **分类**：{data['classify_label']}")
    parts.append(f"- **类型**：{data['item_type']}")
    if data["icon_id"]:
        parts.append(f"- **图标**：{data['icon_id']}")
    if data["obtain_approach"]:
        parts.append(f"- **获取方式**：{data['obtain_approach']}")

    if data["description"]:
        parts.extend(["", "## 描述", str(data["description"])])
    if data["usage"]:
        parts.extend(["", "## 用途", str(data["usage"])])

    parts.extend(["", "## 掉落关卡", _format_stage_drops(data["stage_drop_list"])])
    parts.extend(_format_related("基建产出", data["building_product_list"]))
    parts.extend(_format_related("商店关联", data["shop_relate_list"]))
    parts.extend(_format_related("凭证关联", data["voucher_relate_list"]))
    return "\n".join(parts)


def get_item_info(name: str) -> str:
    """Return detailed information for an item by Chinese name or item ID."""
    data = build_item_info(name)
    if isinstance(data, str):
        return data
    return render_item_info(data)


def search_items(pattern: str, max_results: int = 30) -> str:
    """Regex search across item names, descriptions, usage, obtain sources, and types."""
    data = build_item_search(pattern, max_results=max_results)
    if isinstance(data, str):
        return data
    return render_item_search(data)


def build_item_search(pattern: str, max_results: int = 30) -> dict | str:
    """Build the structured payload for item search."""
    if max_results < 1:
        return "max_results 必须 >= 1。"
    if max_results > 100:
        return "max_results 必须 <= 100。"

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return f"正则表达式无效：{exc}"

    results: list[_ItemSearchRecord] = []
    try:
        records = _item_search_records()
    except (FileNotFoundError, RuntimeError, TypeError) as exc:
        return _missing_data_message() + f"（{exc}）"
    for record in records:
        if regex.search(record.search_text):
            results.append(record)
            if len(results) >= max_results:
                break

    return {
        "scope": "items",
        "pattern": pattern,
        "total": len(results),
        "results": [_item_search_entry(record) for record in results],
    }


def render_item_search(data: dict) -> str:
    """Render an item search payload to markdown."""
    pattern = data["pattern"]
    results = data["results"]
    if not results:
        return f"未找到匹配 '{pattern}' 的物品。"

    lines = [f"# 搜索结果：{pattern}（共 {data['total']} 个）"]
    for item in results:
        lines.append(
            f"\n## {item['name']} [{item['classify_label']}/{item['item_type']}] "
            f"{item['rarity_label']}（id: {item['item_id']}）"
        )
        usage = item["usage"]
        if usage:
            lines.append(f"- **用途**：{usage}")
        obtain = item["obtain_approach"]
        if obtain:
            lines.append(f"- **获取方式**：{obtain}")
    return "\n".join(lines)


def _item_search_entry(record: _ItemSearchRecord) -> dict[str, Any]:
    info = record.info
    return {
        "item_id": record.item_id,
        "name": info.get("name") or "（无名）",
        "classify_raw": str(info.get("classifyType") or ""),
        "classify_label": _classify_label(str(info.get("classifyType") or "")),
        "item_type": info.get("itemType") or "-",
        "rarity_raw": str(info.get("rarity") or ""),
        "rarity_label": _rarity_label(str(info.get("rarity") or "")),
        "usage": _short_text(str(info.get("usage") or info.get("description") or ""), 120),
        "obtain_approach": info.get("obtainApproach") or "",
    }


@activation_aware_cache(maxsize=1)
def _item_search_records() -> tuple[_ItemSearchRecord, ...]:
    records: list[_ItemSearchRecord] = []
    entries = sorted(_visible_items(), key=lambda kv: (kv[1].get("sortId", 999999), kv[0]))
    for item_id, info in entries:
        search_text = " ".join(
            str(info.get(field) or "")
            for field in ("name", "description", "usage", "obtainApproach", "classifyType", "itemType")
        )
        records.append(_ItemSearchRecord(
            item_id=item_id,
            info=info,
            search_text=f"{search_text} {item_id}",
        ))
    return tuple(records)


def cache_stats() -> dict[str, dict]:
    """Return ``{cache_name: {loaded, count}}`` for instrumentation (#104)."""
    return {
        "items": cache_stat(_load_items),
        "item_lookup": cache_stat(_build_item_lookup),
        "item_search_records": cache_stat(_item_search_records),
    }
