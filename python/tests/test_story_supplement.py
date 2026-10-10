"""Consumer-side tests for the roguelike story supplement catalog.

The supplement (zh_CN/story_supplement.json) is projected into the review
table's shape by load_event_table so listing/search/character tools treat
rogue chapters like regular ones — without changing any existing output
when the file is absent.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from prts_mcp.data.stores import DirectoryStore, ZipStore
from prts_mcp.data.story import (
    list_stories_from_store,
    list_story_events_from_store,
    read_activity_from_store,
)
from prts_mcp.data.story_search import _story_store_descriptor, search_stories_from_store

STORY_REVIEW_PATH = "zh_CN/gamedata/excel/story_review_table.json"
STORY_SUPPLEMENT_PATH = "zh_CN/story_supplement.json"
ROGUE_KEY = "Obt/Rogue/rogue_6/MonthRecord/month_record_rogue_6_4_1"
ROGUE_ENDING_KEY = "Obt/Roguelike/RO6/level_rogue6_ending_1"


def _files(with_supplement: bool = True) -> dict[str, object]:
    files: dict[str, object] = {
        STORY_REVIEW_PATH: {
            "act_test": {
                "name": "测试活动",
                "entryType": "ACTIVITY",
                "infoUnlockDatas": [{
                    "storyTxt": "activities/act_test/level_act_test_01_beg",
                    "storyCode": "TEST-1", "storyName": "开端",
                    "avgTag": "BEG", "storySort": 1,
                }],
            },
        },
        "zh_CN/gamedata/story/activities/act_test/level_act_test_01_beg.json": {
            "storyCode": "TEST-1", "storyName": "开端", "eventName": "测试活动",
            "storyList": [{"prop": "name", "attributes": {"name": "阿米娅", "content": "你好。"}}],
        },
    }
    if with_supplement:
        files[STORY_SUPPLEMENT_PATH] = {
            "version": 1,
            "generated_from": {"tables": [], "source_version": "v-test"},
            "events": [{
                "event_id": "rogue_6",
                "name": "沉沦者的黑流树海",
                "entry_type": "ROGUELIKE",
                "sort": 6,
                "chapters": [
                    {"key": ROGUE_ENDING_KEY, "name": "强制重启", "code": "RO6-E1",
                     "avg_tag": "结局", "sort": 110, "group": "ending",
                     "source": "topic:endbook.avgId"},
                    {"key": ROGUE_KEY, "name": "南方往事·1", "code": "RO6-M4-1",
                     "avg_tag": "月度记录·南方往事", "sort": 10401, "group": "month",
                     "source": "topic:chat.chatStoryId"},
                ],
            }],
        }
        files[f"zh_CN/gamedata/story/{ROGUE_KEY}.json"] = {
            "storyCode": "RO6-M4-1", "storyName": "南方往事·1",
            "eventName": "沉沦者的黑流树海",
            "storyList": [
                {"prop": "name", "attributes": {"name": "", "content": "独特旁白词项xyz。"}},
                {"prop": "name", "attributes": {"name": "帕尤卡卡", "content": "蛋糕烤好了。"}},
            ],
        }
        files[f"zh_CN/gamedata/story/{ROGUE_ENDING_KEY}.json"] = {
            "storyCode": "RO6-E1", "storyName": "强制重启",
            "eventName": "沉沦者的黑流树海",
            "storyInfo": "官方梗概。",
            "storyList": [
                {"prop": "name", "attributes": {"name": "卡德霍", "content": "落幕。"}},
            ],
        }
    return files


def _make_store(tmp_path: Path, kind: str, with_supplement: bool = True):
    files = _files(with_supplement)
    if kind == "directory":
        for rel, data in files.items():
            p = tmp_path / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return DirectoryStore(tmp_path)
    zip_path = tmp_path / "zh_CN.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        for rel, data in files.items():
            zf.writestr(rel, json.dumps(data, ensure_ascii=False))
    return ZipStore(zip_path)


@pytest.mark.parametrize("kind", ["directory", "zip"])
def test_supplement_events_listed(tmp_path, kind):
    store = _make_store(tmp_path, kind)
    events = list_story_events_from_store(store)
    ids = {ev.event_id: (ev.name, ev.entry_type, ev.story_count) for ev in events}
    assert ids["rogue_6"] == ("沉沦者的黑流树海", "ROGUELIKE", 2)
    assert "act_test" in ids  # review content unaffected


@pytest.mark.parametrize("kind", ["directory", "zip"])
def test_supplement_category_filter(tmp_path, kind):
    store = _make_store(tmp_path, kind)
    rogue_only = list_story_events_from_store(store, category="roguelike")
    assert [ev.event_id for ev in rogue_only] == ["rogue_6"]
    activities = list_story_events_from_store(store, category="activities")
    assert [ev.event_id for ev in activities] == ["act_test"]
    memoirs = list_story_events_from_store(store, category="memoirs")
    assert memoirs == []


@pytest.mark.parametrize("kind", ["directory", "zip"])
def test_supplement_chapters_ordered_and_projected(tmp_path, kind):
    store = _make_store(tmp_path, kind)
    chapters = list_stories_from_store(store, "rogue_6")
    assert [(c.story_key, c.story_code, c.story_name, c.avg_tag) for c in chapters] == [
        (ROGUE_ENDING_KEY, "RO6-E1", "强制重启", "结局"),
        (ROGUE_KEY, "RO6-M4-1", "南方往事·1", "月度记录·南方往事"),
    ]


@pytest.mark.parametrize("kind", ["directory", "zip"])
def test_supplement_read_activity(tmp_path, kind):
    store = _make_store(tmp_path, kind)
    activity = read_activity_from_store(store, "rogue_6")
    texts = [line.text for ch in activity.chapters for line in ch.lines]
    assert any("独特旁白词项xyz" in t for t in texts)
    assert any("落幕。" in t for t in texts)


@pytest.mark.parametrize("kind", ["directory", "zip"])
def test_supplement_searchable(tmp_path, kind):
    store = _make_store(tmp_path, kind)
    result = search_stories_from_store(store, "独特旁白词项xyz", max_results=5)
    assert "rogue_6" in result
    # review content still searchable
    assert "你好" in search_stories_from_store(store, "你好", max_results=5)


def test_supplement_speakers_via_character_index(tmp_path):
    from prts_mcp.data.story_character import find_speakers_in_from_store

    store = _make_store(tmp_path, "directory")
    speakers = find_speakers_in_from_store(store, "rogue_6")
    names = {s.name for s in speakers}
    assert "帕尤卡卡" in names and "卡德霍" in names


@pytest.mark.parametrize("kind", ["directory", "zip"])
def test_no_supplement_keeps_old_behavior(tmp_path, kind):
    store = _make_store(tmp_path, kind, with_supplement=False)
    events = list_story_events_from_store(store)
    assert [ev.event_id for ev in events] == ["act_test"]
    with pytest.raises(KeyError):
        list_stories_from_store(store, "rogue_6")
    result = search_stories_from_store(store, "独特旁白词项xyz", max_results=5)
    assert "rogue_6" not in result


def test_directory_descriptor_tracks_supplement(tmp_path):
    store = _make_store(tmp_path, "directory", with_supplement=True)
    d1 = _story_store_descriptor(store)
    assert d1 is not None
    # touching only the supplement file must invalidate the cached index
    supp = tmp_path / STORY_SUPPLEMENT_PATH
    supp.write_text(supp.read_text(encoding="utf-8") + " ", encoding="utf-8")
    d2 = _story_store_descriptor(store)
    assert d2 is not None and d2 != d1


def test_invalid_supplement_degrades_to_review(tmp_path):
    store = _make_store(tmp_path, "directory")
    (tmp_path / STORY_SUPPLEMENT_PATH).write_text("{not json", encoding="utf-8")
    events = list_story_events_from_store(store)
    assert [ev.event_id for ev in events] == ["act_test"]


def test_malformed_supplement_fields_degrade(tmp_path):
    """Wrong-typed fields degrade to defaults, mirroring TS typeof checks."""
    store = _make_store(tmp_path, "directory")
    bad = {
        "version": 1,
        "events": [
            {"event_id": 123, "chapters": []},              # non-string id: skipped
            {"event_id": "rogue_9", "chapters": 5},         # non-list: event with 0 chapters
            {"event_id": "rogue_7", "name": None, "entry_type": 7, "chapters": [
                {"key": ROGUE_KEY, "name": None, "code": None, "avg_tag": 3,
                 "sort": None},
            ]},
        ],
    }
    (tmp_path / STORY_SUPPLEMENT_PATH).write_text(
        json.dumps(bad, ensure_ascii=False), encoding="utf-8")

    events = list_story_events_from_store(store)
    by_id = {ev.event_id: ev for ev in events}
    assert "rogue_9" in by_id and by_id["rogue_9"].story_count == 0
    assert "rogue_7" in by_id
    assert by_id["rogue_7"].entry_type == "ROGUELIKE"
    assert not any(not isinstance(ev.event_id, str) for ev in events)

    chapters = list_stories_from_store(store, "rogue_7")  # sort=None must not raise
    assert [(c.story_code, c.story_name, c.avg_tag, c.sort_order) for c in chapters] == [
        ("", "", None, 0)
    ]
    # search index build must survive the malformed event too
    assert "你好" in search_stories_from_store(store, "你好", max_results=5)
