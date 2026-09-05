"""Story chapter summary reader.

Split from story.py. Provides per-chapter summary with a three-tier fallback
chain: LLM long summary → official one-liner → chapter storyInfo field.
"""
from __future__ import annotations

from pathlib import Path

from prts_mcp.data.stores import JsonStore
from prts_mcp.data.story_reader import (
    chapter_summary_from_store,
    load_chapter_summaries_from_store,
    story_store,
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
    1. zh_CN/summaries.json — LLM-generated long summary
    2. zh_CN/storyinfo.json — official one-line summary
    3. Chapter JSON ``storyInfo`` field — identical to #2, last resort
    """
    text = chapter_summary_from_store(store, story_key, load_chapter_summaries_from_store(store))
    return text or f"未找到剧情章节 '{story_key}' 的梗概。"
