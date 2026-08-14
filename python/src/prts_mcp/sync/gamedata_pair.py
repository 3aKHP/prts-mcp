"""GameData pair state machine: archive extract-and-activate + pair coordination.

Extracted from ``data/sync`` in P2.B.2. Owns ``sync_release_archive`` /
``sync_release_archive_pair`` and the ``.gamedata_pair.json`` pair state
(load/save/init). Carries BOTH #152/#155 idempotency guards verbatim: the
archive-layer "already at activation_sha" short-circuit (in
``_sync_release_archive_locked``) and the pair-layer no-op-write
short-circuit (in ``_save_gamedata_pair``), gated by the pair driver's
"only save when excel/levels shas match". ``data/sync`` re-exports these.
"""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

from prts_mcp.sync._types import ReleaseArchiveSpec, RepoSpec, SyncResult
from prts_mcp.sync.primitives import atomic_write_json
from prts_mcp.sync.release_activation import (
    with_archive_activation_lock,
    _archive_activation_sha,
    _archive_files_present,
    _load_extract_meta,
    _prune_release_trees,
    _releases_path,
    _save_extract_meta,
    _stage_release_tree,
    _validate_archive_zip,
)
from prts_mcp.sync.release import sync_release
from prts_mcp.sync.release_discovery import ReleaseSpec

_GAMEDATA_PAIR_META = ".gamedata_pair.json"


def _sync_release_archive_locked(
    spec: ReleaseArchiveSpec,
    *,
    force_check: bool = False,
) -> SyncResult:
    release_result = sync_release(
        ReleaseSpec(
            owner=spec.owner,
            repo=spec.repo,
            asset_name=spec.asset_name,
            local_zip=spec.local_zip,
            validate_zip=lambda path: _validate_archive_zip(path, spec.required_files),
            verify_manifest=spec.verify_manifest,
        ),
        force_check=force_check,
    )
    dummy_spec = RepoSpec(
        owner=spec.owner,
        repo=spec.repo,
        branch="releases",
        files=spec.required_files,
        local_root=spec.local_root,
    )

    extract_meta = _load_extract_meta(spec)
    active_root = extract_meta[1] if extract_meta is not None else spec.local_root
    _prune_release_trees(spec, {active_root})
    files_ok = all((active_root / f).is_file() for f in spec.required_files)
    if release_result.status == "no_data":
        if files_ok:
            return SyncResult(
                spec=dummy_spec,
                status="offline_fallback",
                commit_sha=release_result.commit_sha,
                error=release_result.error,
            )
        return SyncResult(
            spec=dummy_spec,
            status="no_data",
            commit_sha=release_result.commit_sha,
            error=release_result.error,
        )

    extracted_sha = extract_meta[0] if extract_meta is not None else None
    should_extract = (
        release_result.status == "updated"
        or not files_ok
        or extracted_sha is None
        or (
            release_result.commit_sha is not None
            and extracted_sha != release_result.commit_sha
        )
    )
    if should_extract:
        staging: Path | None = None
        try:
            activation_sha = _archive_activation_sha(spec, release_result.commit_sha)
            staging, activated_root = _stage_release_tree(spec, activation_sha)
            current_meta = _load_extract_meta(spec)
            current_root = (
                current_meta[1] if current_meta is not None else spec.local_root
            )
            if (
                current_meta is not None
                and current_meta[0] == activation_sha
                and all(
                    (current_root / path).is_file()
                    for path in spec.required_files
                )
            ):
                shutil.rmtree(staging, ignore_errors=True)
                staging = None
                return SyncResult(
                    spec=dummy_spec,
                    status="up_to_date",
                    commit_sha=activation_sha,
                    error=None,
                )
            staging.replace(activated_root)
            staging = None
            if current_root.parent == _releases_path(spec):
                os.utime(current_root)
            _save_extract_meta(spec, activation_sha, activated_root)
            _prune_release_trees(spec, {current_root, activated_root})
        except Exception as exc:  # noqa: BLE001
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
            if _archive_files_present(spec):
                return SyncResult(
                    spec=dummy_spec,
                    status="offline_fallback",
                    commit_sha=release_result.commit_sha,
                    error=str(exc),
                )
            return SyncResult(
                spec=dummy_spec,
                status="no_data",
                commit_sha=release_result.commit_sha,
                error=str(exc),
            )
        return SyncResult(
            spec=dummy_spec,
            status="updated",
            commit_sha=activation_sha,
            error=None,
        )

    return SyncResult(
        spec=dummy_spec,
        status=release_result.status,
        commit_sha=release_result.commit_sha,
        error=release_result.error,
    )


def sync_release_archive(
    spec: ReleaseArchiveSpec,
    *,
    force_check: bool = False,
) -> SyncResult:
    """Publish and activate one release archive under a shared-volume lock."""
    dummy_spec = RepoSpec(
        owner=spec.owner,
        repo=spec.repo,
        branch="releases",
        files=spec.required_files,
        local_root=spec.local_root,
    )
    try:
        spec.local_zip.parent.mkdir(parents=True, exist_ok=True)
        with with_archive_activation_lock(spec):
            return _sync_release_archive_locked(spec, force_check=force_check)
    except Exception as exc:  # noqa: BLE001
        return SyncResult(
            spec=dummy_spec,
            status=("offline_fallback" if _archive_files_present(spec) else "no_data"),
            commit_sha=None,
            error=str(exc),
        )


def _gamedata_pair_path(
    excel_spec: ReleaseArchiveSpec,
    levels_spec: ReleaseArchiveSpec,
) -> Path:
    excel_parent = excel_spec.local_root.resolve().parent
    levels_parent = levels_spec.local_root.resolve().parent
    if excel_parent != levels_parent:
        raise ValueError("GameData excel and levels roots must share one parent")
    return excel_parent / _GAMEDATA_PAIR_META


def _load_gamedata_pair(
    excel_spec: ReleaseArchiveSpec,
    levels_spec: ReleaseArchiveSpec,
) -> tuple[str, Path, Path] | None:
    try:
        path = _gamedata_pair_path(excel_spec, levels_spec)
        if not path.is_file() or path.is_symlink():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        commit_sha = value.get("commit_sha")
        excel_data_root = value.get("excel_data_root")
        levels_data_root = value.get("levels_data_root")
        if not all(
            isinstance(item, str) and item
            for item in (commit_sha, excel_data_root, levels_data_root)
        ):
            return None
        excel_root = (excel_spec.local_root / excel_data_root).resolve()
        levels_root = (levels_spec.local_root / levels_data_root).resolve()
        if not excel_root.is_relative_to(excel_spec.local_root.resolve()):
            return None
        if not levels_root.is_relative_to(levels_spec.local_root.resolve()):
            return None
        if not all((excel_root / path).is_file() for path in excel_spec.required_files):
            return None
        if not all((levels_root / path).is_file() for path in levels_spec.required_files):
            return None
        return commit_sha, excel_root, levels_root
    except (OSError, json.JSONDecodeError, AttributeError, ValueError):
        return None


def _save_gamedata_pair(
    excel_spec: ReleaseArchiveSpec,
    levels_spec: ReleaseArchiveSpec,
    commit_sha: str,
    excel_root: Path,
    levels_root: Path,
) -> None:
    path = _gamedata_pair_path(excel_spec, levels_spec)
    current = (
        _load_gamedata_pair(excel_spec, levels_spec)
        if path.is_file() and not path.is_symlink()
        else None
    )
    if current == (commit_sha, excel_root.resolve(), levels_root.resolve()):
        return
    atomic_write_json(
        path,
        {
            "commit_sha": commit_sha,
            "excel_data_root": excel_root.relative_to(
                excel_spec.local_root.resolve()
            ).as_posix(),
            "levels_data_root": levels_root.relative_to(
                levels_spec.local_root.resolve()
            ).as_posix(),
        },
    )


def _initialize_gamedata_pair(
    excel_spec: ReleaseArchiveSpec,
    levels_spec: ReleaseArchiveSpec,
) -> None:
    if _load_gamedata_pair(excel_spec, levels_spec) is not None:
        return
    excel_meta = _load_extract_meta(excel_spec)
    levels_meta = _load_extract_meta(levels_spec)
    if excel_meta is None and levels_meta is None:
        commit_sha = "legacy"
        excel_root = excel_spec.local_root
        levels_root = levels_spec.local_root
    elif (
        excel_meta is not None
        and levels_meta is not None
        and excel_meta[0] == levels_meta[0]
    ):
        commit_sha = excel_meta[0]
        excel_root = excel_meta[1]
        levels_root = levels_meta[1]
    else:
        return
    if not all((excel_root / path).is_file() for path in excel_spec.required_files):
        return
    if not all((levels_root / path).is_file() for path in levels_spec.required_files):
        return
    _save_gamedata_pair(
        excel_spec,
        levels_spec,
        commit_sha,
        excel_root,
        levels_root,
    )


def sync_release_archive_pair(
    excel_spec: ReleaseArchiveSpec,
    levels_spec: ReleaseArchiveSpec,
    *,
    force_check: bool = False,
) -> tuple[SyncResult, SyncResult]:
    """Activate Excel and levels as one cross-process visible generation."""
    pair_path = _gamedata_pair_path(excel_spec, levels_spec)
    pair_path.parent.mkdir(parents=True, exist_ok=True)
    lock_spec = ReleaseSpec(
        owner=excel_spec.owner,
        repo=excel_spec.repo,
        asset_name="gamedata-pair",
        local_zip=pair_path.parent / "gamedata-pair",
    )
    with with_archive_activation_lock(lock_spec, ".gamedata-pair.lock"):
        _initialize_gamedata_pair(excel_spec, levels_spec)
        current_pair = _load_gamedata_pair(excel_spec, levels_spec)
        if current_pair is not None:
            now = time.time()
            for root in current_pair[1:]:
                try:
                    os.utime(root, (now, now))
                except OSError:
                    pass
        excel_result = sync_release_archive(excel_spec, force_check=force_check)
        levels_result = sync_release_archive(levels_spec, force_check=force_check)
        excel_meta = _load_extract_meta(excel_spec)
        levels_meta = _load_extract_meta(levels_spec)
        if (
            excel_meta is not None
            and levels_meta is not None
            and excel_meta[0] == levels_meta[0]
            and all(
                (excel_meta[1] / path).is_file()
                for path in excel_spec.required_files
            )
            and all(
                (levels_meta[1] / path).is_file()
                for path in levels_spec.required_files
            )
        ):
            _save_gamedata_pair(
                excel_spec,
                levels_spec,
                excel_meta[0],
                excel_meta[1],
                levels_meta[1],
            )
        return excel_result, levels_result
