"""Full-text search across story dialogue, narration, and choice lines.

Split from story.py. Builds a lazily-cached search index over all story
chapters and provides regex search with filtering by speaker, line type,
and event scope.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from prts_mcp.data.stores import DirectoryStore, JsonStore, ZipStore
from prts_mcp.data.story_reader import (
    STORY_REVIEW_TABLE,
    StoryLine,
    is_memoir_event,
    load_json,
    read_story_from_store,
    story_store,
)

# ---------------------------------------------------------------------------
# Internal types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _StorySearchChapter:
    event_id: str
    story_key: str
    story_code: str
    story_name: str
    lines: tuple[StoryLine, ...]


@dataclass(frozen=True)
class _StorySearchRecord:
    chapter_index: int
    line_index: int
    line: StoryLine


@dataclass(frozen=True)
class _StorySearchIndex:
    event_ids: frozenset[str]
    chapters: tuple[_StorySearchChapter, ...]
    records: tuple[_StorySearchRecord, ...]


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------


def _format_story_line(line: StoryLine) -> str:
    """Format a single StoryLine for display in search results."""
    if line.type == "dialog":
        return f"{line.role or '（旁白）'}：{line.text}"
    elif line.type == "narration":
        return f"*{line.text}*"
    else:
        return f"【选项】{line.text}"


_VALID_LINE_TYPES = {"dialog", "narration", "choice"}


# ---------------------------------------------------------------------------
# Public API — zip-path wrapper
# ---------------------------------------------------------------------------


def search_stories(
    zip_path: Path,
    pattern: str,
    character: str | None = None,
    line_type: str | None = None,
    context_lines: int = 1,
    max_results: int = 30,
    event_id: str | None = None,
) -> str:
    """Search story text across all events (or a single event).

    Convenience wrapper around search_stories_from_store that auto-creates
    a ZipStore from *zip_path*.
    """
    with story_store(zip_path) as store:
        return search_stories_from_store(
            store,
            pattern,
            character=character,
            line_type=line_type,
            context_lines=context_lines,
            max_results=max_results,
            event_id=event_id,
        )


# ---------------------------------------------------------------------------
# Public API — store-based
# ---------------------------------------------------------------------------


def search_stories_from_store(
    store: JsonStore,
    pattern: str,
    character: str | None = None,
    line_type: str | None = None,
    context_lines: int = 1,
    max_results: int = 30,
    event_id: str | None = None,
) -> str:
    """Full-text search across story dialogue, narration and choice lines.

    Args:
        store: JsonStore (ZipStore or DirectoryStore) for story data.
        pattern: Case-insensitive regex pattern.
        character: Optional speaker name filter (dialog lines only).
        line_type: Optional line type filter — "dialog", "narration" or "choice".
        context_lines: Number of surrounding lines to include per match.
        max_results: Maximum matches to return.
        event_id: Optional event filter (e.g. "act31side").

    Returns:
        Formatted multi-block search result string.
    """
    if max_results < 1:
        return "max_results 必须 >= 1。"
    if max_results > 100:
        return "max_results 必须 <= 100。"
    if context_lines < 0:
        return "context_lines 必须 >= 0。"
    if context_lines > 5:
        return "context_lines 必须 <= 5。"

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return f"正则表达式无效：{exc}"

    if line_type is not None and line_type not in _VALID_LINE_TYPES:
        return f"无效的 line_type：{line_type!r}，可选值：{', '.join(sorted(_VALID_LINE_TYPES))}"

    try:
        index = _story_search_index(store)
    except Exception as exc:
        return f"读取剧情数据索引失败：{exc}"

    if event_id is not None and event_id not in index.event_ids:
        return f"未找到匹配的活动：{event_id!r}。"

    results: list[dict] = []

    for record in index.records:
        if len(results) >= max_results:
            break

        chapter = index.chapters[record.chapter_index]
        line = record.line
        if event_id is not None and chapter.event_id != event_id:
            continue
        if character is not None:
            if line.type != "dialog" or (line.role or "").lower() != character.lower():
                continue
        if line_type is not None and line.type != line_type:
            continue
        if not regex.search(line.text):
            continue

        start = max(0, record.line_index - context_lines)
        end = min(len(chapter.lines), record.line_index + context_lines + 1)
        ctx_parts: list[str] = []
        for j in range(start, end):
            prefix = ">>> " if j == record.line_index else "    "
            ctx_parts.append(prefix + _format_story_line(chapter.lines[j]))

        results.append({
            "event_id": chapter.event_id,
            "story_code": chapter.story_code,
            "line_number": record.line_index + 1,
            "context": "\n".join(ctx_parts),
        })

    if not results:
        filter_desc = "。".join(
            f for f in [
                f"event_id={event_id!r}" if event_id else "",
                f"character={character!r}" if character else "",
                f"line_type={line_type!r}" if line_type else "",
            ] if f
        )
        filter_suffix = f"（过滤条件：{filter_desc}）" if filter_desc else ""
        return f"未找到匹配 '{pattern}' 的剧情台词。{filter_suffix}"

    parts = [f"# 搜索 \"{pattern}\" 的结果（共 {len(results)} 条）"]
    for r in results:
        parts.append(
            f"\n---\n\n"
            f"[stories/{r['event_id']}/{r['story_code']} L{r['line_number']}]\n"
            f"{r['context']}"
        )

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Index building + caching
# ---------------------------------------------------------------------------


def _story_search_index(store: JsonStore) -> _StorySearchIndex:
    descriptor = _story_store_descriptor(store)
    if descriptor is None:
        return _build_story_search_index(store)
    return _cached_story_search_index(descriptor)


def _story_store_descriptor(store: JsonStore) -> tuple[str, str, int, int] | None:
    if isinstance(store, ZipStore):
        path = store.zip_path.resolve()
        if not path.is_file():
            return None
        stat = path.stat()
        return ("zip", str(path), stat.st_size, stat.st_mtime_ns)
    if isinstance(store, DirectoryStore):
        root = store.root.resolve()
        review = root / STORY_REVIEW_TABLE
        if not review.is_file():
            return None
        stat = review.stat()
        return ("directory", str(root), stat.st_size, stat.st_mtime_ns)
    return None


@lru_cache(maxsize=4)
def _cached_story_search_index(
    descriptor: tuple[str, str, int, int],
) -> _StorySearchIndex:
    kind, source, _size, _mtime_ns = descriptor
    store: JsonStore
    if kind == "zip":
        store = ZipStore(source)
    else:
        store = DirectoryStore(source)
    try:
        return _build_story_search_index(store)
    finally:
        store.close()


def _build_story_search_index(store: JsonStore) -> _StorySearchIndex:
    table: dict = load_json(store, STORY_REVIEW_TABLE)  # type: ignore[assignment]
    event_ids: set[str] = set()
    chapters: list[_StorySearchChapter] = []
    records: list[_StorySearchRecord] = []

    for ev_id, entry in table.items():
        datas = sorted(
            entry.get("infoUnlockDatas") or [],
            key=lambda x: x.get("storySort", 0),
        )
        if not datas:
            continue
        # Only include NONE entries that are operator memoirs
        if entry.get("entryType", "NONE") == "NONE" and not is_memoir_event(ev_id):
            continue
        event_ids.add(ev_id)
        for d in datas:
            story_key = d.get("storyTxt")
            if not story_key:
                continue
            try:
                chapter = read_story_from_store(store, story_key, include_narration=True)
            except (KeyError, FileNotFoundError, json.JSONDecodeError):
                continue
            chapter_index = len(chapters)
            indexed_chapter = _StorySearchChapter(
                event_id=ev_id,
                story_key=d.get("storyTxt", ""),
                story_code=d.get("storyCode", ""),
                story_name=d.get("storyName", ""),
                lines=tuple(chapter.lines),
            )
            chapters.append(indexed_chapter)
            records.extend(
                _StorySearchRecord(chapter_index=chapter_index, line_index=i, line=line)
                for i, line in enumerate(indexed_chapter.lines)
            )

    return _StorySearchIndex(
        event_ids=frozenset(event_ids),
        chapters=tuple(chapters),
        records=tuple(records),
    )


def clear_search_cache() -> None:
    """Clear the cached story search index."""
    _cached_story_search_index.cache_clear()
