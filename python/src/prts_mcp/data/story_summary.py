"""Story chapter summary reader.

Split from story.py. Provides per-chapter summary with a three-tier fallback
chain: LLM long summary → official one-liner → chapter storyInfo field.
"""
from __future__ import annotations

from pathlib import Path

from prts_mcp.data.stores import JsonStore
from prts_mcp.data.story_reader import (
    STORYINFO,
    SUMMARIES,
    load_json,
    story_store,
    story_zip_path,
)


# ---------------------------------------------------------------------------
# Per-chapter summary
# ---------------------------------------------------------------------------


def get_story_summary(zip_path: Path, story_key: str) -> str:
    """Return a summary for a single story chapter.

    Convenience wrapper around get_story_summary_from_store.
    """
    with story_store(zip_path) as store:
        return get_story_summary_from_store(store, story_key)


def get_story_summary_from_store(store: JsonStore, story_key: str) -> str:
    """Return a summary for a single story chapter.

    Fallback chain:
    1. zh_CN/summaries.json — LLM-generated long summary (future)
    2. zh_CN/storyinfo.json — official one-line summary
    3. Chapter JSON ``storyInfo`` field — identical to #2, last resort
    """
    # --- tier 1: LLM summaries (future) ---
    if store.exists(SUMMARIES):
        try:
            raw = load_json(store, SUMMARIES)
            if isinstance(raw, dict):
                text = raw.get(story_key)
                if text and isinstance(text, str):
                    return text.strip()
        except Exception:
            pass

    # --- tier 2: storyinfo.json ---
    if store.exists(STORYINFO):
        try:
            raw = load_json(store, STORYINFO)
            if isinstance(raw, dict):
                text = raw.get(story_key)
                if text and isinstance(text, str):
                    return text.strip()
        except Exception:
            pass

    # --- tier 3: chapter JSON storyInfo ---
    story_path = story_zip_path(story_key)
    if store.exists(story_path):
        try:
            raw = load_json(store, story_path)
            if isinstance(raw, dict):
                text = raw.get("storyInfo")
                if text and isinstance(text, str):
                    return text.strip()
        except Exception:
            pass

    return f"未找到剧情章节 '{story_key}' 的梗概。"
