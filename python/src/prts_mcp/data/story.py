"""Story data reader for PRTS-MCP.

This module is now a compatibility re-export shim. The implementation has
been split into focused submodules for clarity (see STYLE.md file-size
guidelines):

- story_reader: types, constants, and chapter/event parsing
- story_search: full-text search index and search_stories
- story_memoir: operator memoir discovery via chardict.json
- story_summary: event and per-chapter summaries

All public symbols are re-exported here so existing
``from prts_mcp.data.story import ...`` imports continue to work unchanged.
"""
from __future__ import annotations

from prts_mcp.data.story_reader import (
    ActivityResult,
    ChapterSummary,
    CharacterAppearance,
    CharacterAppearanceResult,
    EventInfo,
    MemoirChapter,
    OperatorMemoirResult,
    SpeakerCount,
    StoryChapter,
    StoryLine,
    _clean_text,
    _parse_story_list,
    list_story_events,
    list_story_events_from_store,
    list_stories,
    list_stories_from_store,
    read_activity,
    read_activity_from_store,
    read_story,
    read_story_from_store,
)
from prts_mcp.data.story_search import (
    search_stories,
    search_stories_from_store,
)
from prts_mcp.data.story_memoir import (
    get_operator_memoirs,
    get_operator_memoirs_from_store,
)
from prts_mcp.data.story_summary import (
    get_event_summary,
    get_event_summary_from_store,
    get_story_summary,
    get_story_summary_from_store,
)
from prts_mcp.data.story_character import (
    find_character_appearances,
    find_character_appearances_from_store,
    find_speakers_in,
    find_speakers_in_from_store,
)
from prts_mcp.data.story_search import clear_search_cache as _clear_search_cache
from prts_mcp.data.story_memoir import clear_chardict_cache as _clear_chardict_cache


def clear_story_caches() -> None:
    """Clear cached story search indexes after story data changes."""
    _clear_search_cache()
    _clear_chardict_cache()


__all__ = [
    # Types
    "StoryLine",
    "StoryChapter",
    "EventInfo",
    "ChapterSummary",
    "ActivityResult",
    "MemoirChapter",
    "OperatorMemoirResult",
    "CharacterAppearance",
    "CharacterAppearanceResult",
    "SpeakerCount",
    # Reader
    "list_story_events",
    "list_story_events_from_store",
    "list_stories",
    "list_stories_from_store",
    "read_story",
    "read_story_from_store",
    "read_activity",
    "read_activity_from_store",
    # Search
    "search_stories",
    "search_stories_from_store",
    # Memoir
    "get_operator_memoirs",
    "get_operator_memoirs_from_store",
    # Summary
    "get_event_summary",
    "get_event_summary_from_store",
    "get_story_summary",
    "get_story_summary_from_store",
    # Character tracking
    "find_character_appearances",
    "find_character_appearances_from_store",
    "find_speakers_in",
    "find_speakers_in_from_store",
    # Cache management
    "clear_story_caches",
]
