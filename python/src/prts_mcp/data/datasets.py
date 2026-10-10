from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from prts_mcp.data.sync import GAMEDATA_FILES, ReleaseArchiveSpec, ReleaseSpec


STORYJSON_REQUIRED_FILES: tuple[str, ...] = (
    "zh_CN/gamedata/excel/story_review_table.json",
    "zh_CN/storyinfo.json",
)
STORYJSON_REVIEW_TABLE = "zh_CN/gamedata/excel/story_review_table.json"
STORYJSON_SUPPLEMENT = "zh_CN/story_supplement.json"
LEVELS_REQUIRED_FILES: tuple[str, ...] = (
    "zh_CN/gamedata/levels/enemydata/enemy_database.json",
)


@dataclass(frozen=True)
class ReleaseDatasetSpec:
    dataset_id: str
    owner: str
    repo: str
    asset_name: str
    required_files: tuple[str, ...]
    verify_manifest: bool = True

    def release_spec(self, local_zip: Path) -> ReleaseSpec:
        return ReleaseSpec(
            owner=self.owner,
            repo=self.repo,
            asset_name=self.asset_name,
            local_zip=local_zip,
            validate_zip=self.validate_zip,
            verify_manifest=self.verify_manifest,
        )

    def archive_spec(self, *, local_zip: Path, local_root: Path) -> ReleaseArchiveSpec:
        return ReleaseArchiveSpec(
            owner=self.owner,
            repo=self.repo,
            asset_name=self.asset_name,
            local_zip=local_zip,
            local_root=local_root,
            required_files=self.required_files,
            verify_manifest=self.verify_manifest,
        )

    def validate_zip(self, zip_path: Path) -> list[str]:
        """Return missing or invalid zip entries for this dataset."""
        try:
            with ZipFile(zip_path) as zf:
                return validate_storyjson_zip(zf) if self is STORY_ZH_CN else _missing_entries(zf, self.required_files)
        except BadZipFile:
            return [f"{zip_path} is not a valid zip"]


def _missing_entries(zf: ZipFile, required_files: tuple[str, ...]) -> list[str]:
    names = set(zf.namelist())
    return [path for path in required_files if path not in names]


def _story_path(story_key: str) -> str:
    return f"zh_CN/gamedata/story/{story_key}.json"


def validate_storyjson_zip(zf: ZipFile) -> list[str]:
    """Validate story metadata and referenced chapter JSON entries.

    Review-table references are always checked; when the optional
    story_supplement.json (roguelike catalog) is present, its chapter keys
    are checked too — a pack carrying a catalog that points at missing
    chapters is broken and should be rejected like any review gap. Old
    packs without the file are unaffected.
    """
    missing = _missing_entries(zf, STORYJSON_REQUIRED_FILES)
    if STORYJSON_REVIEW_TABLE in missing:
        return missing

    try:
        table = json.loads(zf.read(STORYJSON_REVIEW_TABLE).decode("utf-8"))
    except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        return [*missing, f"{STORYJSON_REVIEW_TABLE} is unreadable: {exc}"]

    names = set(zf.namelist())
    story_paths = {
        _story_path(story_key)
        for entry in table.values()
        for data in (entry.get("infoUnlockDatas") or [])
        if (story_key := data.get("storyTxt"))
    }
    if STORYJSON_SUPPLEMENT in names:
        try:
            supplement = json.loads(zf.read(STORYJSON_SUPPLEMENT).decode("utf-8"))
            supp_events = supplement.get("events") if isinstance(supplement, dict) else None
            if not isinstance(supp_events, list):
                raise ValueError("events is not a list")
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            return [*missing, f"{STORYJSON_SUPPLEMENT} is unreadable: {exc}"]
        story_paths |= {
            _story_path(chapter_key)
            for event in supp_events
            if isinstance(event, dict)
            for chapter in (event.get("chapters") or [])
            if isinstance(chapter, dict)
            and isinstance(chapter.get("key"), str)
            and (chapter_key := chapter["key"])
        }
    missing.extend(path for path in sorted(story_paths) if path not in names)
    return missing


GAMEDATA_EXCEL = ReleaseDatasetSpec(
    dataset_id="gamedata.excel",
    owner="3aKHP",
    repo="arknights-data-pipeline",
    asset_name="zh_CN-excel.zip",
    required_files=GAMEDATA_FILES,
)

STORY_ZH_CN = ReleaseDatasetSpec(
    dataset_id="story.zh_CN",
    owner="3aKHP",
    repo="arknights-data-pipeline",
    asset_name="zh_CN.zip",
    required_files=STORYJSON_REQUIRED_FILES,
)

GAMEDATA_LEVELS = ReleaseDatasetSpec(
    dataset_id="gamedata.levels",
    owner="3aKHP",
    repo="arknights-data-pipeline",
    asset_name="zh_CN-levels.zip",
    required_files=LEVELS_REQUIRED_FILES,
)
