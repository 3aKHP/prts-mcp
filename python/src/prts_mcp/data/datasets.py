from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from prts_mcp.data.sync import GAMEDATA_FILES, ReleaseArchiveSpec, ReleaseSpec


STORYJSON_REQUIRED_FILES: tuple[str, ...] = (
    "zh_CN/gamedata/excel/story_review_table.json",
    "zh_CN/storyinfo.json",
)


@dataclass(frozen=True)
class ReleaseDatasetSpec:
    dataset_id: str
    owner: str
    repo: str
    asset_name: str
    required_files: tuple[str, ...]

    def release_spec(self, local_zip: Path) -> ReleaseSpec:
        return ReleaseSpec(
            owner=self.owner,
            repo=self.repo,
            asset_name=self.asset_name,
            local_zip=local_zip,
        )

    def archive_spec(self, *, local_zip: Path, local_root: Path) -> ReleaseArchiveSpec:
        return ReleaseArchiveSpec(
            owner=self.owner,
            repo=self.repo,
            asset_name=self.asset_name,
            local_zip=local_zip,
            local_root=local_root,
            required_files=self.required_files,
        )


GAMEDATA_EXCEL = ReleaseDatasetSpec(
    dataset_id="gamedata.excel",
    owner="3aKHP",
    repo="ArknightsGameData",
    asset_name="zh_CN-excel.zip",
    required_files=GAMEDATA_FILES,
)

STORY_ZH_CN = ReleaseDatasetSpec(
    dataset_id="story.zh_CN",
    owner="3aKHP",
    repo="ArknightsStoryJson",
    asset_name="zh_CN.zip",
    required_files=STORYJSON_REQUIRED_FILES,
)

