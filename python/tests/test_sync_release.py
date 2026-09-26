"""Tests for ReleaseSpec / sync_release in prts_mcp.data.sync."""
from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from prts_mcp.data.sync import (
    CacheMeta,
    ReleaseSpec,
    ReleaseArchiveSpec,
    SyncResult,
    check_latest_release,
    download_release_asset,
    sync_release_archive,
    sync_release,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_spec(tmp_path: Path) -> ReleaseSpec:
    return ReleaseSpec(
        owner="3aKHP",
        repo="ArknightsStoryJson",
        asset_name="zh_CN.zip",
        local_zip=tmp_path / "storyjson" / "zh_CN.zip",
    )


def _write_zip(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("zh_CN/storyinfo.json", "{}")


def _mock_release_response(tag: str, asset_name: str, download_url: str) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {
        "tag_name": tag,
        "assets": [{"name": asset_name, "browser_download_url": download_url}],
    }
    return resp


def _mock_asset_response(content: bytes = b"PK\x03\x04") -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.content = content
    return resp


# ---------------------------------------------------------------------------
# check_latest_release
# ---------------------------------------------------------------------------

class TestCheckLatestRelease:
    def test_returns_tag_and_url(self, tmp_path):
        spec = _make_spec(tmp_path)
        tag = "upstream-abc123"
        url = "https://github.com/example/release/zh_CN.zip"

        with patch("httpx.get", return_value=_mock_release_response(tag, "zh_CN.zip", url)):
            result = check_latest_release(spec)

        assert result == (tag, url)

    def test_asset_not_found_returns_none(self, tmp_path):
        spec = _make_spec(tmp_path)
        with patch("httpx.get", return_value=_mock_release_response("upstream-abc", "other.zip", "http://x")):
            result = check_latest_release(spec)
        assert result is None

    def test_network_error_returns_none(self, tmp_path):
        spec = _make_spec(tmp_path)
        with patch("httpx.get", side_effect=Exception("network error")):
            result = check_latest_release(spec)
        assert result is None


# ---------------------------------------------------------------------------
# sync_release
# ---------------------------------------------------------------------------

class TestSyncRelease:
    def test_reads_typescript_release_metadata(self, tmp_path):
        spec = _make_spec(tmp_path)
        _write_zip(spec.local_zip)
        (spec.local_zip.parent / "release_meta.json").write_text(
            json.dumps({
                "repo": "3aKHP/ArknightsStoryJson",
                "branch": "releases",
                "commitSha": "same-sha",
                "fetchedAt": "2099-01-01T00:00:00.000Z",
                "files": [spec.asset_name],
            }),
            encoding="utf-8",
        )

        with patch("prts_mcp.data.sync.check_latest_release") as check:
            result = sync_release(spec)

        check.assert_not_called()
        assert result.status == "up_to_date"
        assert result.commit_sha == "same-sha"

    def test_updated_when_new_tag(self, tmp_path):
        spec = _make_spec(tmp_path)
        tag = "upstream-newsha1234"
        asset_url = "https://example.com/zh_CN.zip"

        with (
            patch("prts_mcp.data.sync.check_latest_release", return_value=(tag, asset_url)),
            patch("prts_mcp.data.sync.download_release_asset") as mock_dl,
        ):
            mock_dl.return_value = None
            result = sync_release(spec)

        assert result.status == "updated"
        mock_dl.assert_called_once()

    def test_up_to_date_when_sha_matches(self, tmp_path):
        spec = _make_spec(tmp_path)
        sha = "abc123def456"
        tag = f"upstream-{sha}"
        _write_zip(spec.local_zip)

        # Write a cache meta that matches
        from prts_mcp.data.sync import CacheMeta
        from datetime import datetime, timezone
        CacheMeta(
            repo="3aKHP/ArknightsStoryJson",
            branch="releases",
            commit_sha=sha,
            fetched_at=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            files=["zh_CN.zip"],
        ).save(spec.local_zip.parent / "release_meta.json")

        with patch("prts_mcp.data.sync.check_latest_release", return_value=(tag, "http://x")):
            result = sync_release(spec)

        assert result.status == "up_to_date"
        assert result.commit_sha == sha

    def test_offline_fallback_when_zip_exists(self, tmp_path):
        spec = _make_spec(tmp_path)
        _write_zip(spec.local_zip)

        with patch("prts_mcp.data.sync.check_latest_release", return_value=None):
            result = sync_release(spec)

        assert result.status == "offline_fallback"

    def test_validator_exception_returns_no_data(self, tmp_path):
        spec = _make_spec(tmp_path)
        _write_zip(spec.local_zip)
        spec = ReleaseSpec(
            owner=spec.owner,
            repo=spec.repo,
            asset_name=spec.asset_name,
            local_zip=spec.local_zip,
            validate_zip=lambda _path: (_ for _ in ()).throw(ValueError("bad zip")),
        )

        with patch("prts_mcp.data.sync.check_latest_release", return_value=None):
            result = sync_release(spec)

        assert result.status == "no_data"
        assert result.error == "Network unavailable and no cached zip; cached zip invalid: zh_CN.zip is not a valid zip: bad zip"

    def test_no_data_when_network_fails_and_no_zip(self, tmp_path):
        spec = _make_spec(tmp_path)

        with patch("prts_mcp.data.sync.check_latest_release", return_value=None):
            result = sync_release(spec)

        assert result.status == "no_data"

    def test_tag_prefix_stripped_for_sha(self, tmp_path):
        spec = _make_spec(tmp_path)
        sha = "c785d88f552fce9bbe2ce9122bd0e9f516810e20"
        tag = f"upstream-{sha}"

        with (
            patch("prts_mcp.data.sync.check_latest_release", return_value=(tag, "http://x")),
            patch("prts_mcp.data.sync.download_release_asset"),
        ):
            result = sync_release(spec)

        assert result.commit_sha == sha

    def test_fresh_cache_skips_api_call(self, tmp_path):
        spec = _make_spec(tmp_path)
        sha = "freshsha"
        _write_zip(spec.local_zip)

        from prts_mcp.data.sync import CacheMeta
        from datetime import datetime, timezone
        CacheMeta(
            repo="3aKHP/ArknightsStoryJson",
            branch="releases",
            commit_sha=sha,
            fetched_at=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            files=["zh_CN.zip"],
        ).save(spec.local_zip.parent / "release_meta.json")

        with patch("prts_mcp.data.sync.check_latest_release") as mock_check:
            result = sync_release(spec)

        mock_check.assert_not_called()
        assert result.status == "up_to_date"


# ---------------------------------------------------------------------------
# CacheMeta cross-runtime interop
# ---------------------------------------------------------------------------

class TestCacheMeta:
    def test_load_accepts_camel_case_keys(self, tmp_path):
        path = tmp_path / "release_meta.json"
        path.write_text(
            json.dumps({
                "repo": "3aKHP/ArknightsStoryJson",
                "branch": "releases",
                "commitSha": "ts-sha",
                "fetchedAt": "2099-01-01T00:00:00.000Z",
                "files": ["zh_CN.zip"],
            }),
            encoding="utf-8",
        )

        meta = CacheMeta.load(path)

        assert meta is not None
        assert meta.repo == "3aKHP/ArknightsStoryJson"
        assert meta.branch == "releases"
        assert meta.commit_sha == "ts-sha"
        assert meta.fetched_at == "2099-01-01T00:00:00.000Z"
        assert meta.files == ["zh_CN.zip"]

    def test_load_ignores_unknown_keys(self, tmp_path):
        path = tmp_path / "release_meta.json"
        path.write_text(
            json.dumps({
                "repo": "r",
                "branch": "b",
                "commit_sha": "sha",
                "fetched_at": "2099-01-01T00:00:00Z",
                "files": [],
                "future_field": {"nested": True},
            }),
            encoding="utf-8",
        )

        meta = CacheMeta.load(path)

        assert meta is not None
        assert meta.commit_sha == "sha"

    def test_load_rejects_wrong_field_types(self, tmp_path):
        path = tmp_path / "release_meta.json"
        path.write_text(
            json.dumps({
                "repo": "r",
                "branch": "b",
                "commit_sha": 123,
                "fetched_at": "2099-01-01T00:00:00Z",
                "files": [],
            }),
            encoding="utf-8",
        )

        assert CacheMeta.load(path) is None

    def test_save_writes_snake_case_keys(self, tmp_path):
        path = tmp_path / "release_meta.json"
        CacheMeta(
            repo="r", branch="b", commit_sha="sha",
            fetched_at="2099-01-01T00:00:00Z", files=["f"],
        ).save(path)

        data = json.loads(path.read_text(encoding="utf-8"))
        assert set(data) == {"repo", "branch", "commit_sha", "fetched_at", "files"}
        assert CacheMeta.load(path) == CacheMeta(
            repo="r", branch="b", commit_sha="sha",
            fetched_at="2099-01-01T00:00:00Z", files=["f"],
        )

    def test_save_uses_unique_tmp_files_and_replaces_atomically(self, tmp_path, monkeypatch):
        replaced: list[Path] = []
        real_replace = Path.replace

        def spy_replace(self: Path, target: Path) -> Path:
            replaced.append(self)
            return real_replace(self, target)

        monkeypatch.setattr(Path, "replace", spy_replace)
        path = tmp_path / "release_meta.json"
        meta = CacheMeta(repo="r", branch="b", commit_sha="sha", fetched_at="t", files=[])
        meta.save(path)
        meta.save(path)

        assert len(replaced) == 2
        assert replaced[0] != replaced[1]
        for tmp in replaced:
            assert tmp.parent == path.parent
            assert re.fullmatch(r"\.release_meta\.json\.[0-9a-f]{32}\.tmp", tmp.name)
        assert json.loads(path.read_text(encoding="utf-8"))["commit_sha"] == "sha"
        assert list(tmp_path.glob("*.tmp")) == []


# ---------------------------------------------------------------------------
# download_release_asset
# ---------------------------------------------------------------------------

class TestDownloadReleaseAsset:
    def test_download_uses_unique_tmp_name(self, tmp_path, monkeypatch):
        seen: list[Path] = []

        def capture_tmp(path: Path) -> list[str]:
            seen.append(path)
            return []

        base = _make_spec(tmp_path)
        spec = ReleaseSpec(
            owner=base.owner,
            repo=base.repo,
            asset_name=base.asset_name,
            local_zip=base.local_zip,
            validate_zip=capture_tmp,
        )
        monkeypatch.setattr(
            "prts_mcp.data.sync.uuid4",
            lambda: MagicMock(hex="ab" * 16),
        )
        response = MagicMock()
        response.content = b"PK\x03\x04fake"

        with patch("prts_mcp.data.sync._get_cascading", return_value=response):
            download_release_asset(spec, "upstream-sha", "https://example.com/z")

        assert len(seen) == 1
        assert seen[0].name == f".{spec.local_zip.name}.{'ab' * 16}.tmp"
        assert seen[0].parent == spec.local_zip.parent
        assert spec.local_zip.is_file()
        assert list(spec.local_zip.parent.glob("*.tmp")) == []


# ---------------------------------------------------------------------------
# sync_release_archive
# ---------------------------------------------------------------------------

class TestSyncReleaseArchive:
    def test_extracts_updated_archive(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-excel.zip"
        zip_path.parent.mkdir(parents=True)
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("zh_CN/gamedata/excel/character_table.json", "{}")
            zf.writestr("zh_CN/gamedata/excel/handbook_info_table.json", "{}")

        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name="zh_CN-excel.zip",
            local_zip=zip_path,
            local_root=tmp_path / "gamedata",
            required_files=(
                "zh_CN/gamedata/excel/character_table.json",
                "zh_CN/gamedata/excel/handbook_info_table.json",
            ),
        )

        with patch(
            "prts_mcp.data.sync.sync_release",
            return_value=SyncResult(
                spec=ReleaseSpec(
                    owner=spec.owner,
                    repo=spec.repo,
                    asset_name=spec.asset_name,
                    local_zip=spec.local_zip,
                ),
                status="updated",
                commit_sha="abc123",
                error=None,
            ),
        ):
            result = sync_release_archive(spec)

        assert result.status == "updated"
        assert (spec.local_root / "zh_CN/gamedata/excel/character_table.json").is_file()
        assert (spec.local_root / "zh_CN/gamedata/excel/handbook_info_table.json").is_file()

    def test_up_to_date_archive_extracts_when_required_files_missing(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-excel.zip"
        zip_path.parent.mkdir(parents=True)
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("zh_CN/gamedata/excel/character_table.json", "{}")

        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name="zh_CN-excel.zip",
            local_zip=zip_path,
            local_root=tmp_path / "gamedata",
            required_files=("zh_CN/gamedata/excel/character_table.json",),
        )

        with patch(
            "prts_mcp.data.sync.sync_release",
            return_value=SyncResult(
                spec=ReleaseSpec(
                    owner=spec.owner,
                    repo=spec.repo,
                    asset_name=spec.asset_name,
                    local_zip=spec.local_zip,
                ),
                status="up_to_date",
                commit_sha="abc123",
                error=None,
            ),
        ):
            result = sync_release_archive(spec)

        assert result.status == "up_to_date"
        assert (spec.local_root / "zh_CN/gamedata/excel/character_table.json").is_file()

    def test_archive_missing_required_zip_entry_returns_no_data(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-levels.zip"
        zip_path.parent.mkdir(parents=True)
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("zh_CN/gamedata/levels/obt/main/level_main_00-01.json", "{}")

        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name="zh_CN-levels.zip",
            local_zip=zip_path,
            local_root=tmp_path / "gamedata-levels",
            required_files=("zh_CN/gamedata/levels/enemydata/enemy_database.json",),
        )

        with patch(
            "prts_mcp.data.sync.check_latest_release",
            return_value=None,
        ):
            result = sync_release_archive(spec)

        assert result.status == "no_data"
        assert "enemy_database.json" in (result.error or "")

    def test_rejects_unsafe_zip_member(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-excel.zip"
        zip_path.parent.mkdir(parents=True)
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("../evil.json", "{}")

        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name="zh_CN-excel.zip",
            local_zip=zip_path,
            local_root=tmp_path / "gamedata",
            required_files=("zh_CN/gamedata/excel/character_table.json",),
        )

        with patch(
            "prts_mcp.data.sync.sync_release",
            return_value=SyncResult(
                spec=ReleaseSpec(
                    owner=spec.owner,
                    repo=spec.repo,
                    asset_name=spec.asset_name,
                    local_zip=spec.local_zip,
                ),
                status="updated",
                commit_sha="abc123",
                error=None,
            ),
        ):
            result = sync_release_archive(spec)

        assert result.status == "no_data"
        assert "Unsafe zip member path" in (result.error or "")
