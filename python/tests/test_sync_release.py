"""Tests for ReleaseSpec / sync_release in prts_mcp.data.sync."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from prts_mcp.data.sync import (
    ReleaseSpec,
    ReleaseArchiveSpec,
    SyncResult,
    check_latest_release,
    sync_release_archive,
    sync_release,
    _archive_activation_lock,
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


def _active_archive_root(spec: ReleaseArchiveSpec) -> Path:
    meta = json.loads(
        (spec.local_zip.parent / "extract_meta.json").read_text(encoding="utf-8")
    )
    return spec.local_root / meta["data_root"]


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
    def test_concurrent_release_checks_are_serialized(self, tmp_path):
        spec = _make_spec(tmp_path)
        _write_zip(spec.local_zip)
        guard = threading.Lock()
        active_checks = 0
        max_active_checks = 0

        def check_release(_spec):
            nonlocal active_checks, max_active_checks
            with guard:
                active_checks += 1
                max_active_checks = max(max_active_checks, active_checks)
            time.sleep(0.05)
            with guard:
                active_checks -= 1
            return None

        with patch(
            "prts_mcp.data.sync.check_latest_release",
            side_effect=check_release,
        ):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(
                    pool.map(
                        lambda _: sync_release(spec, force_check=True),
                        range(2),
                    )
                )

        assert max_active_checks == 1
        assert {result.status for result in results} == {"offline_fallback"}

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
        assert result.commit_sha == "newsha1234"
        mock_dl.assert_called_once_with(spec, tag, asset_url)

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

    def test_forced_check_bypasses_fresh_cache(self, tmp_path):
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

        with patch(
            "prts_mcp.data.sync.check_latest_release",
            return_value=(f"upstream-{sha}", "http://x"),
        ) as mock_check:
            result = sync_release(spec, force_check=True)

        mock_check.assert_called_once_with(spec)
        assert result.status == "up_to_date"
        assert result.commit_sha == sha


# ---------------------------------------------------------------------------
# sync_release_archive
# ---------------------------------------------------------------------------

class TestSyncReleaseArchive:
    def test_reclaims_abandoned_ownerless_lock(self, tmp_path):
        archive_dir = tmp_path / "archives"
        archive_dir.mkdir()
        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name="zh_CN-excel.zip",
            local_zip=archive_dir / "zh_CN-excel.zip",
            local_root=tmp_path / "gamedata",
            required_files=(),
        )
        lock = archive_dir / ".activation.lock"
        lock.mkdir()
        abandoned = time.time() - 11
        os.utime(lock, (abandoned, abandoned))

        with _archive_activation_lock(spec):
            assert (lock / "owner").is_file()

        assert not lock.exists()

    def test_stale_lock_owner_cannot_remove_successor_lock(self, tmp_path):
        archive_dir = tmp_path / "archives"
        archive_dir.mkdir()
        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name="zh_CN-excel.zip",
            local_zip=archive_dir / "zh_CN-excel.zip",
            local_root=tmp_path / "gamedata",
            required_files=(),
        )
        first = _archive_activation_lock(spec)
        first.__enter__()
        lock = archive_dir / ".activation.lock"
        old = time.time() - 31 * 60
        os.utime(lock, (old, old))
        second = _archive_activation_lock(spec)
        second.__enter__()
        try:
            first.__exit__(None, None, None)
            assert lock.is_dir()
        finally:
            second.__exit__(None, None, None)
        assert not lock.exists()

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
        active_root = _active_archive_root(spec)
        assert (active_root / "zh_CN/gamedata/excel/character_table.json").is_file()
        assert (active_root / "zh_CN/gamedata/excel/handbook_info_table.json").is_file()
        meta = json.loads(
            (spec.local_zip.parent / "extract_meta.json").read_text(encoding="utf-8")
        )
        assert meta["commit_sha"] == "abc123"

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

        assert result.status == "updated"
        assert (
            _active_archive_root(spec)
            / "zh_CN/gamedata/excel/character_table.json"
        ).is_file()

    def test_retries_activation_after_extraction_failure(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-excel.zip"
        zip_path.parent.mkdir(parents=True)
        required = "zh_CN/gamedata/excel/character_table.json"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr(required, '{"version":"new"}')

        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name="zh_CN-excel.zip",
            local_zip=zip_path,
            local_root=tmp_path / "gamedata",
            required_files=(required,),
        )
        old_file = spec.local_root / required
        old_file.parent.mkdir(parents=True)
        old_file.write_text('{"version":"old"}', encoding="utf-8")
        release_result = SyncResult(
            spec=ReleaseSpec(
                owner=spec.owner,
                repo=spec.repo,
                asset_name=spec.asset_name,
                local_zip=spec.local_zip,
            ),
            status="up_to_date",
            commit_sha="abc123",
            error=None,
        )

        with (
            patch("prts_mcp.data.sync.sync_release", return_value=release_result),
            patch(
                "prts_mcp.data.sync._safe_extract_zip",
                side_effect=RuntimeError("interrupted extraction"),
            ),
        ):
            first = sync_release_archive(spec)

        assert first.status == "offline_fallback"
        assert not (spec.local_zip.parent / "extract_meta.json").exists()

        with patch("prts_mcp.data.sync.sync_release", return_value=release_result):
            second = sync_release_archive(spec)

        assert second.status == "updated"
        assert old_file.read_text(encoding="utf-8") == '{"version":"old"}'
        active_file = _active_archive_root(spec) / required
        assert active_file.read_text(encoding="utf-8") == '{"version":"new"}'
        meta = json.loads(
            (spec.local_zip.parent / "extract_meta.json").read_text(encoding="utf-8")
        )
        assert meta["commit_sha"] == "abc123"

    def test_offline_recovery_activates_and_reports_updated(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-excel.zip"
        zip_path.parent.mkdir(parents=True)
        required = "zh_CN/gamedata/excel/character_table.json"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr(required, '{"version":"new"}')
        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name="zh_CN-excel.zip",
            local_zip=zip_path,
            local_root=tmp_path / "gamedata",
            required_files=(required,),
        )
        old_file = spec.local_root / required
        old_file.parent.mkdir(parents=True)
        old_file.write_text('{"version":"old"}', encoding="utf-8")
        release_result = SyncResult(
            spec=ReleaseSpec(
                owner=spec.owner,
                repo=spec.repo,
                asset_name=spec.asset_name,
                local_zip=spec.local_zip,
            ),
            status="offline_fallback",
            commit_sha="abc123",
            error="network down",
        )

        with patch("prts_mcp.data.sync.sync_release", return_value=release_result):
            result = sync_release_archive(spec)

        assert result.status == "updated"
        assert (_active_archive_root(spec) / required).read_text(
            encoding="utf-8"
        ) == '{"version":"new"}'
        assert old_file.read_text(encoding="utf-8") == '{"version":"old"}'

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

    def test_rejects_release_directory_symlink(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-excel.zip"
        zip_path.parent.mkdir(parents=True)
        required = "zh_CN/gamedata/excel/character_table.json"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr(required, "{}")
        outside = tmp_path / "outside"
        outside.mkdir()
        local_root = tmp_path / "gamedata"
        local_root.mkdir()
        (local_root / ".releases").symlink_to(outside, target_is_directory=True)
        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name=zip_path.name,
            local_zip=zip_path,
            local_root=local_root,
            required_files=(required,),
        )
        release_result = SyncResult(
            spec=spec,
            status="updated",
            commit_sha="abc123",
            error=None,
        )

        with patch("prts_mcp.data.sync.sync_release", return_value=release_result):
            result = sync_release_archive(spec)

        assert result.status == "no_data"
        assert "Unsafe release directory symlink" in (result.error or "")
        assert list(outside.iterdir()) == []

    def test_concurrent_activation_keeps_authoritative_tree(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-excel.zip"
        zip_path.parent.mkdir(parents=True)
        required = "zh_CN/gamedata/excel/character_table.json"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr(required, "{}")
        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name=zip_path.name,
            local_zip=zip_path,
            local_root=tmp_path / "gamedata",
            required_files=(required,),
        )
        release_result = SyncResult(
            spec=spec,
            status="updated",
            commit_sha="abc123",
            error=None,
        )
        publication_guard = threading.Lock()
        active_publications = 0
        max_active_publications = 0

        def publish_release(*_args, **_kwargs):
            nonlocal active_publications, max_active_publications
            with publication_guard:
                active_publications += 1
                max_active_publications = max(
                    max_active_publications,
                    active_publications,
                )
            time.sleep(0.05)
            with publication_guard:
                active_publications -= 1
            return release_result

        with patch("prts_mcp.data.sync.sync_release", side_effect=publish_release):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: sync_release_archive(spec), range(2)))

        assert max_active_publications == 1
        assert {result.status for result in results} == {"updated", "up_to_date"}
        active_root = _active_archive_root(spec)
        assert (active_root / required).is_file()
        assert not (spec.local_zip.parent / ".activation.lock").exists()

    def test_cross_process_activation_keeps_authoritative_tree(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-excel.zip"
        zip_path.parent.mkdir(parents=True)
        required = "zh_CN/gamedata/excel/character_table.json"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr(required, "{}")
        local_root = tmp_path / "gamedata"
        script = """
import sys
from pathlib import Path
import prts_mcp.data.sync as sync

zip_path = Path(sys.argv[1])
local_root = Path(sys.argv[2])
required = sys.argv[3]
spec = sync.ReleaseArchiveSpec(
    owner="3aKHP",
    repo="ArknightsGameData",
    asset_name=zip_path.name,
    local_zip=zip_path,
    local_root=local_root,
    required_files=(required,),
)
sync.sync_release = lambda *args, **kwargs: sync.SyncResult(
    spec=sync.RepoSpec(
        owner=spec.owner,
        repo=spec.repo,
        branch="releases",
        files=spec.required_files,
        local_root=spec.local_root,
    ),
    status="updated",
    commit_sha="abc123",
    error=None,
)
print(sync.sync_release_archive(spec).status)
"""
        processes = [
            subprocess.Popen(
                [sys.executable, "-c", script, str(zip_path), str(local_root), required],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for _ in range(2)
        ]
        outputs = [process.communicate(timeout=20) for process in processes]

        assert all(process.returncode == 0 for process in processes), outputs
        assert {stdout.strip() for stdout, _ in outputs} == {"updated", "up_to_date"}
        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name=zip_path.name,
            local_zip=zip_path,
            local_root=local_root,
            required_files=(required,),
        )
        assert (_active_archive_root(spec) / required).is_file()

    def test_retention_uses_deactivation_time_and_removes_stale_staging(self, tmp_path):
        zip_path = tmp_path / "archives" / "zh_CN-excel.zip"
        zip_path.parent.mkdir(parents=True)
        required = "zh_CN/gamedata/excel/character_table.json"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr(required, "{}")
        spec = ReleaseArchiveSpec(
            owner="3aKHP",
            repo="ArknightsGameData",
            asset_name=zip_path.name,
            local_zip=zip_path,
            local_root=tmp_path / "gamedata",
            required_files=(required,),
        )

        def release_result(sha: str) -> SyncResult:
            return SyncResult(
                spec=spec,
                status="updated",
                commit_sha=sha,
                error=None,
            )

        with patch("prts_mcp.data.sync.sync_release", return_value=release_result("one")):
            assert sync_release_archive(spec).status == "updated"
        previous = _active_archive_root(spec)
        old = time.time() - 25 * 60 * 60
        os.utime(previous, (old, old))
        orphan = spec.local_root / ".releases" / ".orphan.tmp"
        orphan.mkdir()
        os.utime(orphan, (old, old))

        with patch("prts_mcp.data.sync.sync_release", return_value=release_result("two")):
            assert sync_release_archive(spec).status == "updated"

        assert previous.is_dir()
        assert previous.stat().st_mtime > old
        assert not orphan.exists()
