"""Story data reader for PRTS-MCP.

Reads from the bundled/synced zh_CN.zip (ArknightsStoryJson fork release).

Zip internal layout (all paths prefixed with "zh_CN/"):
  zh_CN/storyinfo.json                       — {story_key: summary_text}
  zh_CN/gamedata/excel/story_review_table.json — event metadata + ordered chapter list
  zh_CN/gamedata/story/{story_key}.json       — per-chapter dialogue JSON
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from prts_mcp.data.stores import JsonStore, ZipStore

# ---------------------------------------------------------------------------
# Zip path constants
# ---------------------------------------------------------------------------

_STORY_REVIEW_TABLE = "zh_CN/gamedata/excel/story_review_table.json"

# entryType values → user-facing category strings
_CATEGORY_MAP: dict[str, list[str]] = {
    "main": ["MAINLINE"],
    "activities": ["ACTIVITY", "MINI_ACTIVITY"],
}


def _story_zip_path(story_key: str) -> str:
    return f"zh_CN/gamedata/story/{story_key}.json"


# ---------------------------------------------------------------------------
# Text cleaning
# ---------------------------------------------------------------------------

_RICH_TAG_RE = re.compile(r"<[^>]+>")


def _clean_text(text: str) -> str:
    """Remove rich-text tags and replace {@nickname} with 博士."""
    text = text.replace("{@nickname}", "博士")
    text = _RICH_TAG_RE.sub("", text)
    return text.strip()


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StoryLine:
    type: Literal["dialog", "narration", "choice"]
    role: str | None   # speaker name; None for narration/choice
    text: str


@dataclass(frozen=True)
class StoryChapter:
    story_key: str
    story_code: str
    story_name: str
    avg_tag: str | None
    event_name: str
    story_info: str
    lines: list[StoryLine]


@dataclass(frozen=True)
class EventInfo:
    event_id: str
    name: str
    entry_type: str
    story_count: int


@dataclass(frozen=True)
class ChapterSummary:
    story_key: str
    story_code: str
    story_name: str
    avg_tag: str | None
    sort_order: int


@dataclass(frozen=True)
class ActivityResult:
    event_id: str
    event_name: str
    total_chapters: int
    has_more: bool
    chapters: list[StoryChapter]


# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------


def _parse_story_list(story_list: list[dict]) -> list[StoryLine]:
    """Convert raw storyList entries into cleaned StoryLine objects."""
    lines: list[StoryLine] = []
    for item in story_list:
        prop = item.get("prop", "")
        attrs = item.get("attributes", {})

        prop_lower = prop.lower()
        if prop_lower == "name":
            name = attrs.get("name") or ""
            content = attrs.get("content") or ""
            if content:
                lines.append(StoryLine(
                    type="dialog",
                    role=_clean_text(name) if name else None,
                    text=_clean_text(content),
                ))
        elif prop_lower in ("sticker", "subtitle", "animtext"):
            content = attrs.get("content") or attrs.get("text") or ""
            if content:
                lines.append(StoryLine(type="narration", role=None, text=_clean_text(content)))
        elif prop_lower == "decision":
            options = attrs.get("options") or []
            for opt in options:
                # options elements may be plain strings or dicts with a "text" key
                text = opt if isinstance(opt, str) else (opt.get("text") or "")
                if text:
                    lines.append(StoryLine(type="choice", role=None, text=_clean_text(str(text))))

    return lines


def _story_store(zip_path: Path) -> ZipStore:
    return ZipStore(zip_path)


def _load_json(store: JsonStore, path: str) -> dict | list:
    return store.read_json(path)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_story_events(
    zip_path: Path,
    category: str | None = None,
) -> list[EventInfo]:
    """Return a list of events from story_review_table.json.

    Args:
        zip_path: Path to zh_CN.zip.
        category: Optional filter — "main" or "activities".
                  If None, all events are returned.
    """
    allowed_types: list[str] | None = _CATEGORY_MAP.get(category) if category else None

    return list_story_events_from_store(_story_store(zip_path), category=category)


def list_story_events_from_store(
    store: JsonStore,
    category: str | None = None,
) -> list[EventInfo]:
    """Return a list of events from story_review_table.json using a JSON store."""
    allowed_types: list[str] | None = _CATEGORY_MAP.get(category) if category else None
    table: dict = _load_json(store, _STORY_REVIEW_TABLE)  # type: ignore[assignment]

    events = []
    for event_id, entry in table.items():
        entry_type = entry.get("entryType", "NONE")
        if allowed_types is not None and entry_type not in allowed_types:
            continue
        story_count = len(entry.get("infoUnlockDatas") or [])
        events.append(EventInfo(
            event_id=event_id,
            name=entry.get("name") or event_id,
            entry_type=entry_type,
            story_count=story_count,
        ))

    return events


def list_stories(zip_path: Path, event_id: str) -> list[ChapterSummary]:
    """Return ordered chapter list for an event.

    Args:
        zip_path: Path to zh_CN.zip.
        event_id: Event key, e.g. "act31side".

    Returns:
        Chapters sorted by storySort.

    Raises:
        KeyError: If event_id is not found in story_review_table.
    """
    return list_stories_from_store(_story_store(zip_path), event_id)


def list_stories_from_store(store: JsonStore, event_id: str) -> list[ChapterSummary]:
    """Return ordered chapter list for an event using a JSON store."""
    table: dict = _load_json(store, _STORY_REVIEW_TABLE)  # type: ignore[assignment]

    entry = table.get(event_id)
    if entry is None:
        raise KeyError(f"Event not found: {event_id!r}")

    chapters = []
    for d in sorted(entry.get("infoUnlockDatas") or [], key=lambda x: x.get("storySort", 0)):
        story_key = d.get("storyTxt")
        if not story_key:
            continue
        chapters.append(ChapterSummary(
            story_key=story_key,
            story_code=d.get("storyCode") or "",
            story_name=d.get("storyName") or "",
            avg_tag=d.get("avgTag"),
            sort_order=d.get("storySort", 0),
        ))

    return chapters


def read_story(
    zip_path: Path,
    story_key: str,
    include_narration: bool = True,
) -> StoryChapter:
    """Read and parse a single story chapter.

    Args:
        zip_path: Path to zh_CN.zip.
        story_key: Story key from storyTxt / storyinfo.json, e.g.
                   "activities/act31side/level_act31side_01_beg".
        include_narration: Whether to include narration/scene lines.

    Raises:
        KeyError: If the story file is not found in the zip.
    """
    return read_story_from_store(_story_store(zip_path), story_key, include_narration=include_narration)


def read_story_from_store(
    store: JsonStore,
    story_key: str,
    include_narration: bool = True,
) -> StoryChapter:
    """Read and parse a single story chapter using a JSON store."""
    story_path = _story_zip_path(story_key)
    if not store.exists(story_path):
        raise KeyError(f"Story not found in store: {story_key!r}")
    raw: dict = _load_json(store, story_path)  # type: ignore[assignment]

    all_lines = _parse_story_list(raw.get("storyList") or [])
    if not include_narration:
        all_lines = [
            ln for ln in all_lines
            if ln.type != "narration"
            and not (ln.type == "dialog" and ln.role is None)
        ]

    return StoryChapter(
        story_key=story_key,
        story_code=raw.get("storyCode") or "",
        story_name=raw.get("storyName") or "",
        avg_tag=raw.get("avgTag"),
        event_name=raw.get("eventName") or "",
        story_info=raw.get("storyInfo") or "",
        lines=all_lines,
    )


def read_activity(
    zip_path: Path,
    event_id: str,
    include_narration: bool = True,
    page: int | None = None,
    page_size: int = 5,
) -> ActivityResult:
    """Read all chapters of an activity in official story order.

    Args:
        zip_path: Path to zh_CN.zip.
        event_id: Event key, e.g. "act31side".
        include_narration: Whether to include narration lines.
        page: 1-based page index. None returns all chapters.
        page_size: Chapters per page (used only when page is set).

    Returns:
        ActivityResult with event metadata and (paginated) chapters.

    Raises:
        KeyError: If event_id is not found.
    """
    return read_activity_from_store(
        _story_store(zip_path),
        event_id,
        include_narration=include_narration,
        page=page,
        page_size=page_size,
    )


def read_activity_from_store(
    store: JsonStore,
    event_id: str,
    include_narration: bool = True,
    page: int | None = None,
    page_size: int = 5,
) -> ActivityResult:
    """Read all chapters of an activity in official story order using a JSON store."""
    summaries = list_stories_from_store(store, event_id)
    total = len(summaries)

    if page is not None:
        start = (page - 1) * page_size
        end = start + page_size
        selected = summaries[start:end]
        has_more = end < total
    else:
        selected = summaries
        has_more = False

    chapters = []
    event_name = ""
    for summary in selected:
        try:
            chapter = read_story_from_store(store, summary.story_key, include_narration)
            if not event_name:
                event_name = chapter.event_name
            chapters.append(chapter)
        except KeyError:
            # Story file missing from zip — skip silently
            pass

    return ActivityResult(
        event_id=event_id,
        event_name=event_name,
        total_chapters=total,
        has_more=has_more,
        chapters=chapters,
    )
