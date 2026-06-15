"""Story chapter and event summary readers.

Split from story.py. Provides event-level overview (get_event_summary)
and per-chapter summary with a three-tier fallback chain:
LLM long summary → official one-liner → chapter storyInfo field.
"""
from __future__ import annotations

from pathlib import Path

from prts_mcp.data.stores import JsonStore
from prts_mcp.data.story_reader import (
    _load_json,
    _story_store,
    _story_zip_path,
    _STORY_REVIEW_TABLE,
    _STORYINFO,
    _SUMMARIES,
    _EVENT_SUMMARIES,
)


# ---------------------------------------------------------------------------
# Event summary (all chapters of an event)
# ---------------------------------------------------------------------------


def get_event_summary(zip_path: Path, event_id: str) -> str:
    """Return a chapter-by-chapter summary overview of an event.

    Convenience wrapper around get_event_summary_from_store.
    """
    with _story_store(zip_path) as store:
        return get_event_summary_from_store(store, event_id)


def get_event_summary_from_store(store: JsonStore, event_id: str) -> str:
    """Return a chapter-by-chapter summary overview of an event.

    Reads story_review_table for chapter ordering and storyinfo.json
    for per-chapter summaries, producing a narrative table of contents
    suitable for getting the big picture of an event at a glance.
    """
    # --- event metadata ---
    try:
        table: dict = _load_json(store, _STORY_REVIEW_TABLE)
    except Exception as exc:
        return f"读取剧情数据索引失败：{exc}"

    entry = table.get(event_id)
    if entry is None:
        return f"未找到活动：{event_id!r}。请先调用 list_story_events 确认活动 ID。"

    event_name = entry.get("name") or event_id
    datas = sorted(
        entry.get("infoUnlockDatas") or [],
        key=lambda x: x.get("storySort", 0),
    )

    if not datas:
        return f"活动 {event_id!r}（{event_name}）暂无剧情章节。"

    # --- load summary index ---
    summaries: dict[str, str] = {}
    if store.exists(_STORYINFO):
        try:
            raw = _load_json(store, _STORYINFO)
            if isinstance(raw, dict):
                summaries = {str(k): str(v) for k, v in raw.items() if v}
        except Exception:
            pass  # storyinfo.json is optional for this tool

    # --- tier 1: LLM event summary ---
    event_summary_text = ""
    if store.exists(_EVENT_SUMMARIES):
        try:
            raw = _load_json(store, _EVENT_SUMMARIES)
            if isinstance(raw, dict):
                event_summary_text = str(raw.get(event_id) or "").strip()
        except Exception:
            pass

    # --- build output ---
    total = len(datas)
    lines = [f"# {event_name} — 共 {total} 章"]
    if event_summary_text:
        lines.append(f"\n{event_summary_text}")
    for d in datas:
        story_key = d.get("storyTxt")
        if not story_key:
            continue
        code = d.get("storyCode", "")
        name = d.get("storyName", "")
        tag = f"[{d['avgTag']}] " if d.get("avgTag") else ""

        summary = summaries.get(story_key, "")
        if summary:
            lines.append(f"\n{code} {tag}{name}\n  {summary}")
        else:
            lines.append(f"\n{code} {tag}{name}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Per-chapter summary
# ---------------------------------------------------------------------------


def get_story_summary(zip_path: Path, story_key: str) -> str:
    """Return a summary for a single story chapter.

    Convenience wrapper around get_story_summary_from_store.
    """
    with _story_store(zip_path) as store:
        return get_story_summary_from_store(store, story_key)


def get_story_summary_from_store(store: JsonStore, story_key: str) -> str:
    """Return a summary for a single story chapter.

    Fallback chain:
    1. zh_CN/summaries.json — LLM-generated long summary (future)
    2. zh_CN/storyinfo.json — official one-line summary
    3. Chapter JSON ``storyInfo`` field — identical to #2, last resort
    """
    # --- tier 1: LLM summaries (future) ---
    if store.exists(_SUMMARIES):
        try:
            raw = _load_json(store, _SUMMARIES)
            if isinstance(raw, dict):
                text = raw.get(story_key)
                if text and isinstance(text, str):
                    return text.strip()
        except Exception:
            pass

    # --- tier 2: storyinfo.json ---
    if store.exists(_STORYINFO):
        try:
            raw = _load_json(store, _STORYINFO)
            if isinstance(raw, dict):
                text = raw.get(story_key)
                if text and isinstance(text, str):
                    return text.strip()
        except Exception:
            pass

    # --- tier 3: chapter JSON storyInfo ---
    story_path = _story_zip_path(story_key)
    if store.exists(story_path):
        try:
            raw = _load_json(store, story_path)
            if isinstance(raw, dict):
                text = raw.get("storyInfo")
                if text and isinstance(text, str):
                    return text.strip()
        except Exception:
            pass

    return f"未找到剧情章节 '{story_key}' 的梗概。"
