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
from prts_mcp.data.story_search import story_search_index, StorySearchChapter


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _classify_chapter(chapter: StorySearchChapter, name_lower: str) -> tuple[bool, bool]:
    """Return (speaks, mentioned) flags for one indexed chapter.

    Args:
        chapter: a ``StorySearchChapter`` from the search index.
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
        if speaks and mentioned:
            break
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


def build_character_appearances(
    zip_path: Path,
    name: str,
    scope: str | None = None,
    max_events: int = 50,
) -> dict:
    """Build the structured payload for character appearance lookup."""
    with story_store(zip_path) as store:
        return build_character_appearances_from_store(
            store, name, scope=scope, max_events=max_events,
        )


def render_character_appearances(data: dict) -> str:
    """Render a character appearance payload to markdown."""
    appearances = data["appearances"]
    if not appearances:
        scope = data.get("filters", {}).get("scope")
        scope_note = f"（限定活动：{scope!r}）" if scope else ""
        return f"未找到「{data['name']}」的出场记录。{scope_note}"

    parts = [f"# 「{data['name']}」的出场（共 {data['total']} 章）"]
    for ap in appearances:
        tags = []
        if ap["speaks"]:
            tags.append("speaks")
        if ap["mentioned"]:
            tags.append("mentioned")
        tag = "+".join(tags)
        name_disp = f"{ap['story_code']} {ap['story_name']}".strip()
        parts.append(
            f"- [{tag}] {ap['event_id']} / {name_disp}（key: {ap['story_key']}）"
        )
    return "\n".join(parts)


def find_speakers_in(zip_path: Path, event_id: str) -> list[SpeakerCount]:
    """List every speaker in an event, with dialog line counts.

    Convenience wrapper around :func:`find_speakers_in_from_store`.
    """
    with story_store(zip_path) as store:
        return find_speakers_in_from_store(store, event_id)


def build_speakers_in_event(zip_path: Path, event_id: str) -> dict:
    """Build the structured payload for speakers in one event."""
    with story_store(zip_path) as store:
        return build_speakers_in_event_from_store(store, event_id)


def render_speakers_in_event(data: dict) -> str:
    """Render an event speaker-count payload to markdown."""
    speakers = data["speakers"]
    if not speakers:
        return f"活动 {data['event_id']!r} 暂无对话发言者数据。"

    parts = [f"# {data['event_id']} 的发言角色（共 {data['total']} 位）"]
    for sp in speakers:
        parts.append(f"- {sp['name']}（{sp['line_count']} 句）")
    return "\n".join(parts)


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

    index = story_search_index(store)

    if scope is not None and scope not in index.event_ids:
        raise KeyError(f'未找到匹配的活动："{scope}"。')

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


def build_character_appearances_from_store(
    store: JsonStore,
    name: str,
    scope: str | None = None,
    max_events: int = 50,
) -> dict:
    """Build a character appearance payload using a JSON store."""
    result = find_character_appearances_from_store(
        store, name, scope=scope, max_events=max_events,
    )
    return {
        "name": result.name,
        "total": result.total_chapters,
        "filters": {"scope": scope},
        "appearances": [
            {
                "event_id": ap.event_id,
                "story_code": ap.story_code,
                "story_name": ap.story_name,
                "story_key": ap.story_key,
                "speaks": ap.speaks,
                "mentioned": ap.mentioned,
            }
            for ap in result.appearances
        ],
    }


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
    index = story_search_index(store)

    if event_id not in index.event_ids:
        raise KeyError(f'未找到匹配的活动："{event_id}"。')

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


def build_speakers_in_event_from_store(store: JsonStore, event_id: str) -> dict:
    """Build an event speaker-count payload using a JSON store."""
    speakers = find_speakers_in_from_store(store, event_id)
    return {
        "event_id": event_id,
        "total": len(speakers),
        "speakers": [
            {
                "name": sp.name,
                "line_count": sp.line_count,
            }
            for sp in speakers
        ],
    }
