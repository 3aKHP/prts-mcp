"""Tests for prts_mcp.data.story — requires local zh_CN.zip (skipped on CI)."""
from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from prts_mcp.data.story import (
    ActivityResult,
    ChapterSummary,
    EventInfo,
    StoryChapter,
    StoryLine,
    _clean_text,
    _parse_story_list,
    list_stories,
    list_story_events,
    read_activity,
    read_story,
)


# ---------------------------------------------------------------------------
# Unit tests — no zip needed
# ---------------------------------------------------------------------------


class TestCleanText:
    def test_nickname_replacement(self):
        assert _clean_text("{@nickname}") == "博士"

    def test_rich_tag_removal(self):
        assert _clean_text("<color=#ff0000>红色文字</color>") == "红色文字"

    def test_bold_tag_removal(self):
        assert _clean_text("<b>粗体</b>") == "粗体"

    def test_combined(self):
        assert _clean_text("你好，{@nickname}<i>！</i>") == "你好，博士！"

    def test_no_change(self):
        assert _clean_text("普通文字") == "普通文字"

    def test_strips_whitespace(self):
        assert _clean_text("  文字  ") == "文字"


class TestParseStoryList:
    def test_dialog_with_speaker(self):
        items = [{"id": 1, "prop": "name", "attributes": {"name": "阿米娅", "content": "博士，你好。"}}]
        lines = _parse_story_list(items)
        assert len(lines) == 1
        assert lines[0] == StoryLine(type="dialog", role="阿米娅", text="博士，你好。")

    def test_dialog_empty_speaker(self):
        items = [{"id": 1, "prop": "name", "attributes": {"name": "", "content": "旁白文字"}}]
        lines = _parse_story_list(items)
        assert lines[0].role is None
        assert lines[0].type == "dialog"

    def test_dialog_empty_content_skipped(self):
        items = [{"id": 1, "prop": "name", "attributes": {"name": "阿米娅", "content": ""}}]
        lines = _parse_story_list(items)
        assert lines == []

    def test_narration_sticker(self):
        items = [{"id": 1, "prop": "sticker", "attributes": {"content": "场景描述"}}]
        lines = _parse_story_list(items)
        assert lines[0] == StoryLine(type="narration", role=None, text="场景描述")

    def test_narration_subtitle(self):
        items = [{"id": 1, "prop": "subtitle", "attributes": {"content": "字幕文字"}}]
        lines = _parse_story_list(items)
        assert lines[0].type == "narration"

    def test_narration_animtext(self):
        items = [{"id": 1, "prop": "animtext", "attributes": {"content": "动画文字"}}]
        lines = _parse_story_list(items)
        assert lines[0].type == "narration"

    def test_non_text_props_skipped(self):
        items = [
            {"id": 1, "prop": "Background", "attributes": {"image": "bg_001"}},
            {"id": 2, "prop": "PlayMusic", "attributes": {"key": "music_001"}},
            {"id": 3, "prop": "Dialog", "attributes": {}},
        ]
        assert _parse_story_list(items) == []

    def test_nickname_cleaned_in_dialog(self):
        items = [{"id": 1, "prop": "name", "attributes": {"name": "角色", "content": "{@nickname}，你好"}}]
        lines = _parse_story_list(items)
        assert lines[0].text == "博士，你好"

    def test_mixed_items(self):
        items = [
            {"id": 1, "prop": "Background", "attributes": {}},
            {"id": 2, "prop": "name", "attributes": {"name": "黍", "content": "你好"}},
            {"id": 3, "prop": "sticker", "attributes": {"content": "某处"}},
            {"id": 4, "prop": "Dialog", "attributes": {}},
        ]
        lines = _parse_story_list(items)
        assert len(lines) == 2
        assert lines[0].type == "dialog"
        assert lines[1].type == "narration"


# ---------------------------------------------------------------------------
# Integration tests — require local zh_CN.zip
# ---------------------------------------------------------------------------


class TestListStoryEvents:
    def test_returns_list(self, story_zip):
        events = list_story_events(story_zip)
        assert isinstance(events, list)
        assert len(events) > 0
        assert all(isinstance(e, EventInfo) for e in events)

    def test_category_main(self, story_zip):
        events = list_story_events(story_zip, category="main")
        assert all(e.entry_type == "MAINLINE" for e in events)
        assert len(events) >= 10

    def test_category_activities(self, story_zip):
        events = list_story_events(story_zip, category="activities")
        assert all(e.entry_type in ("ACTIVITY", "MINI_ACTIVITY") for e in events)
        assert len(events) >= 50

    def test_no_filter_returns_more_than_filtered(self, story_zip):
        all_events = list_story_events(story_zip)
        main_events = list_story_events(story_zip, category="main")
        assert len(all_events) > len(main_events)

    def test_event_fields(self, story_zip):
        events = list_story_events(story_zip, category="main")
        e = events[0]
        assert e.event_id
        assert e.name
        assert e.story_count > 0

    def test_act31side_present(self, story_zip):
        events = list_story_events(story_zip, category="activities")
        ids = {e.event_id for e in events}
        assert "act31side" in ids


class TestListStories:
    def test_act31side_chapters(self, story_zip):
        chapters = list_stories(story_zip, "act31side")
        assert len(chapters) > 0
        assert all(isinstance(c, ChapterSummary) for c in chapters)

    def test_sorted_by_sort_order(self, story_zip):
        chapters = list_stories(story_zip, "act31side")
        orders = [c.sort_order for c in chapters]
        assert orders == sorted(orders)

    def test_chapter_fields(self, story_zip):
        chapters = list_stories(story_zip, "act31side")
        c = chapters[0]
        assert c.story_key
        assert c.story_code
        assert c.story_name

    def test_story_key_format(self, story_zip):
        chapters = list_stories(story_zip, "act31side")
        for c in chapters:
            assert c.story_key.startswith("activities/act31side/")

    def test_unknown_event_raises(self, story_zip):
        with pytest.raises(KeyError):
            list_stories(story_zip, "nonexistent_event_xyz")


class TestReadStory:
    def test_returns_story_chapter(self, story_zip):
        key = "activities/act31side/level_act31side_01_beg"
        chapter = read_story(story_zip, key)
        assert isinstance(chapter, StoryChapter)

    def test_metadata(self, story_zip):
        key = "activities/act31side/level_act31side_01_beg"
        chapter = read_story(story_zip, key)
        assert chapter.event_name == "怀黍离"
        assert chapter.story_name == "赴大荒"
        assert chapter.story_key == key

    def test_has_dialog_lines(self, story_zip):
        key = "activities/act31side/level_act31side_01_beg"
        chapter = read_story(story_zip, key)
        dialogs = [ln for ln in chapter.lines if ln.type == "dialog"]
        assert len(dialogs) > 10

    def test_include_narration_true(self, story_zip):
        # 幕间章节有旁白行
        key = "activities/act31side/level_act31side_st01"
        chapter = read_story(story_zip, key, include_narration=True)
        narrations = [ln for ln in chapter.lines if ln.type == "narration"]
        assert len(narrations) > 0

    def test_include_narration_false(self, story_zip):
        key = "activities/act31side/level_act31side_st01"
        chapter = read_story(story_zip, key, include_narration=False)
        narrations = [ln for ln in chapter.lines if ln.type == "narration"]
        assert narrations == []

    def test_no_raw_tags_in_text(self, story_zip):
        key = "activities/act31side/level_act31side_01_beg"
        chapter = read_story(story_zip, key)
        for ln in chapter.lines:
            assert "<" not in ln.text, f"Raw tag found: {ln.text!r}"
            assert "{@" not in ln.text, f"Raw token found: {ln.text!r}"

    def test_unknown_key_raises(self, story_zip):
        with pytest.raises(KeyError):
            read_story(story_zip, "activities/nonexistent/story")


class TestReadActivity:
    def test_returns_activity_result(self, story_zip):
        result = read_activity(story_zip, "act31side")
        assert isinstance(result, ActivityResult)
        assert hasattr(result, "chapters")
        assert hasattr(result, "total_chapters")

    def test_total_chapters(self, story_zip):
        chapters = list_stories(story_zip, "act31side")
        result = read_activity(story_zip, "act31side")
        assert result.total_chapters == len(chapters)

    def test_no_page_returns_all(self, story_zip):
        result = read_activity(story_zip, "act31side", page=None)
        assert result.has_more is False
        assert len(result.chapters) == result.total_chapters

    def test_pagination_page1(self, story_zip):
        result = read_activity(story_zip, "act31side", page=1, page_size=3)
        assert len(result.chapters) == 3
        assert result.has_more is True

    def test_pagination_last_page(self, story_zip):
        total = read_activity(story_zip, "act31side").total_chapters
        last_page = (total + 4) // 5  # page_size=5
        result = read_activity(story_zip, "act31side", page=last_page, page_size=5)
        assert result.has_more is False

    def test_chapters_are_story_chapters(self, story_zip):
        result = read_activity(story_zip, "act31side", page=1, page_size=2)
        for ch in result.chapters:
            assert isinstance(ch, StoryChapter)

    def test_unknown_event_raises(self, story_zip):
        with pytest.raises(KeyError):
            read_activity(story_zip, "nonexistent_event_xyz")
