from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from prts_mcp.data.stores import DirectoryStore, ZipStore
from prts_mcp.data.story import (
    ChapterSummary,
    StoryChapter,
    list_stories_from_store,
    list_story_events_from_store,
    read_activity_from_store,
    read_story,
    read_story_from_store,
)


STORY_REVIEW_PATH = "zh_CN/gamedata/excel/story_review_table.json"
FIRST_STORY_KEY = "activities/act_test/level_act_test_01_beg"
SECOND_STORY_KEY = "activities/act_test/level_act_test_02_end"


def story_path(story_key: str) -> str:
    return f"zh_CN/gamedata/story/{story_key}.json"


def story_files() -> dict[str, object]:
    return {
        STORY_REVIEW_PATH: {
            "act_test": {
                "name": "测试活动",
                "entryType": "ACTIVITY",
                "infoUnlockDatas": [
                    {
                        "storyTxt": SECOND_STORY_KEY,
                        "storyCode": "TEST-2",
                        "storyName": "终章",
                        "avgTag": "END",
                        "storySort": 2,
                    },
                    {
                        "storyTxt": FIRST_STORY_KEY,
                        "storyCode": "TEST-1",
                        "storyName": "开端",
                        "avgTag": "BEG",
                        "storySort": 1,
                    },
                ],
            },
            "main_test": {
                "name": "测试主线",
                "entryType": "MAINLINE",
                "infoUnlockDatas": [],
            },
        },
        story_path(FIRST_STORY_KEY): {
            "storyCode": "TEST-1",
            "storyName": "开端",
            "avgTag": "BEG",
            "eventName": "测试活动",
            "storyInfo": "测试简介",
            "storyList": [
                {"prop": "name", "attributes": {"name": "阿米娅", "content": "你好，{@nickname}。"}},
                {"prop": "sticker", "attributes": {"content": "<b>场景描述</b>"}},
                {"prop": "decision", "attributes": {"options": ["选项一"]}},
            ],
        },
        story_path(SECOND_STORY_KEY): {
            "storyCode": "TEST-2",
            "storyName": "终章",
            "avgTag": "END",
            "eventName": "测试活动",
            "storyInfo": "",
            "storyList": [
                {"prop": "name", "attributes": {"name": "博士", "content": "结束。"}},
            ],
        },
    }


def write_story_dir(root: Path) -> None:
    for path, data in story_files().items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def write_story_zip(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for inner_path, data in story_files().items():
            zf.writestr(inner_path, json.dumps(data, ensure_ascii=False))


@pytest.mark.parametrize("store_kind", ["directory", "zip"])
def test_story_tools_read_from_store(tmp_path, store_kind):
    if store_kind == "directory":
        write_story_dir(tmp_path)
        store = DirectoryStore(tmp_path)
    else:
        zip_path = tmp_path / "zh_CN.zip"
        write_story_zip(zip_path)
        store = ZipStore(zip_path)

    events = list_story_events_from_store(store, category="activities")
    assert [(ev.event_id, ev.name, ev.entry_type, ev.story_count) for ev in events] == [
        ("act_test", "测试活动", "ACTIVITY", 2)
    ]

    chapters = list_stories_from_store(store, "act_test")
    assert chapters == [
        ChapterSummary(
            story_key=FIRST_STORY_KEY,
            story_code="TEST-1",
            story_name="开端",
            avg_tag="BEG",
            sort_order=1,
        ),
        ChapterSummary(
            story_key=SECOND_STORY_KEY,
            story_code="TEST-2",
            story_name="终章",
            avg_tag="END",
            sort_order=2,
        ),
    ]

    chapter = read_story_from_store(store, FIRST_STORY_KEY)
    assert isinstance(chapter, StoryChapter)
    assert chapter.story_name == "开端"
    assert [line.text for line in chapter.lines] == ["你好，博士。", "场景描述", "选项一"]

    dialogs_only = read_story_from_store(store, FIRST_STORY_KEY, include_narration=False)
    assert [line.type for line in dialogs_only.lines] == ["dialog", "choice"]

    activity = read_activity_from_store(store, "act_test", page=1, page_size=1)
    assert activity.event_name == "测试活动"
    assert activity.total_chapters == 2
    assert activity.has_more is True
    assert [chapter.story_key for chapter in activity.chapters] == [FIRST_STORY_KEY]


def test_public_zip_path_api_still_reads_zip(tmp_path):
    zip_path = tmp_path / "zh_CN.zip"
    write_story_zip(zip_path)

    chapter = read_story(zip_path, FIRST_STORY_KEY)

    assert chapter.story_code == "TEST-1"
    assert chapter.lines[0].text == "你好，博士。"


def test_missing_story_raises_key_error(tmp_path):
    write_story_dir(tmp_path)
    store = DirectoryStore(tmp_path)

    with pytest.raises(KeyError):
        read_story_from_store(store, "activities/act_test/missing")

