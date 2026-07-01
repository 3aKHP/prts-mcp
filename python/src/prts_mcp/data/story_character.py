"""Story character tracking — who appears where, and who speaks in an event.

Split from story.py. Reuses the lazily-cached search index built by
``story_search`` (which already walks every chapter and line), so this module
performs no file IO of its own and needs no separate cache. Two questions are
answered:

- *Where does a character show up?* — chapters/events where the character
  **speaks** (dialog ``role`` exact match, consistent with the ``character``
  filter of ``search_stories``) or is **mentioned** (name appears as a
  substring in any line's text).
- *Who speaks in an event?* — distinct speakers with their dialog line counts.
"""
from __future__ import annotations

from pathlib import Path

from prts_mcp.data.stores import JsonStore
from prts_mcp.data.story_reader import (
    CharacterAppearance,
    CharacterAppearanceResult,
    SpeakerCount,
    story_store,
)
from prts_mcp.data.story_search import _story_search_index


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _classify_chapter(chapter, name_lower: str) -> tuple[bool, bool]:
    """Return (speaks, mentioned) flags for one indexed chapter.

    Args:
        chapter: a ``_StorySearchChapter`` from the search index.
        name_lower: the lowercased character name to look for.

    ``speaks`` is True when any dialog line's ``role`` equals *name_lower*
    (case-insensitive), mirroring the ``character`` filter of
    :func:`search_stories`. ``mentioned`` is True when *name_lower* occurs as a
    substring in any line's text.
    """
    speaks = False
    mentioned = False
    for line in chapter.lines:
        if line.type == "dialog" and (line.role or "").lower() == name_lower:
            speaks = True
        if name_lower in line.text.lower():
            mentioned = True
    return speaks, mentioned


# ---------------------------------------------------------------------------
# Public API — zip-path wrappers
# ---------------------------------------------------------------------------


def find_character_appearances(
    zip_path: Path,
    name: str,
    scope: str | None = None,
    max_events: int = 50,
) -> CharacterAppearanceResult:
    """Find chapters/events where *name* speaks or is mentioned.

    Convenience wrapper around :func:`find_character_appearances_from_store`
    that auto-creates a ZipStore from *zip_path*.
    """
    with story_store(zip_path) as store:
        return find_character_appearances_from_store(
            store, name, scope=scope, max_events=max_events,
        )


def find_speakers_in(zip_path: Path, event_id: str) -> list[SpeakerCount]:
    """List every speaker in an event, with dialog line counts.

    Convenience wrapper around :func:`find_speakers_in_from_store`.
    """
    with story_store(zip_path) as store:
        return find_speakers_in_from_store(store, event_id)


# ---------------------------------------------------------------------------
# Public API — store-based variants
# ---------------------------------------------------------------------------


def find_character_appearances_from_store(
    store: JsonStore,
    name: str,
    scope: str | None = None,
    max_events: int = 50,
) -> CharacterAppearanceResult:
    """Find chapters/events where *name* speaks or is mentioned.

    Args:
        store: JsonStore (ZipStore or DirectoryStore) for story data.
        name: Character name (e.g. 「阿米娅」). ``speaks`` uses case-insensitive
            exact match on dialog ``role``; ``mentioned`` uses substring match
            on any line's text. Use the full name to avoid substring false
            positives (e.g. 「阿」 matches 「阿米娅」).
        scope: Optional event_id filter (e.g. "act31side").
        max_events: Cap on returned chapters (default 50, max 200).

    Returns:
        Aggregated appearance report ordered by the index's chapter order.
    """
    if not name:
        raise ValueError("name 不能为空。")
    if max_events < 1:
        raise ValueError("max_events 必须 >= 1。")
    if max_events > 200:
        raise ValueError("max_events 必须 <= 200。")

    index = _story_search_index(store)

    if scope is not None and scope not in index.event_ids:
        raise KeyError(f"未找到匹配的活动：{scope!r}。")

    name_lower = name.lower()
    appearances: list[CharacterAppearance] = []

    for chapter in index.chapters:
        if scope is not None and chapter.event_id != scope:
            continue
        speaks, mentioned = _classify_chapter(chapter, name_lower)
        if not speaks and not mentioned:
            continue
        appearances.append(CharacterAppearance(
            event_id=chapter.event_id,
            story_key=chapter.story_key,
            story_code=chapter.story_code,
            story_name=chapter.story_name,
            speaks=speaks,
            mentioned=mentioned,
        ))
        if len(appearances) >= max_events:
            break

    return CharacterAppearanceResult(
        name=name,
        total_chapters=len(appearances),
        appearances=appearances,
    )


def find_speakers_in_from_store(
    store: JsonStore,
    event_id: str,
) -> list[SpeakerCount]:
    """List every speaker in an event, with dialog line counts.

    Iterates the cached search index, collecting distinct dialog ``role``
    values (dropping ``None``/empty — those are narration placeholders) and
    counting their lines. Results are sorted by line count descending, then by
    name for a stable order.

    Args:
        store: JsonStore (ZipStore or DirectoryStore) for story data.
        event_id: Event to restrict the scan to (e.g. "act31side").

    Returns:
        Speakers with their dialog line counts, most prolific first.
    """
    index = _story_search_index(store)

    if event_id not in index.event_ids:
        raise KeyError(f"未找到匹配的活动：{event_id!r}。")

    counts: dict[str, int] = {}
    for chapter in index.chapters:
        if chapter.event_id != event_id:
            continue
        for line in chapter.lines:
            if line.type == "dialog" and line.role:
                counts[line.role] = counts.get(line.role, 0) + 1

    speakers = [
        SpeakerCount(name=name, line_count=count)
        for name, count in counts.items()
    ]
    speakers.sort(key=lambda s: (-s.line_count, s.name))
    return speakers
