"""GitHub-backed data sync for PRTS-MCP.

Downloads GitHub Release zip assets (gamedata excel/levels, storyjson)
only when the release tag has changed. Falls back gracefully to
cached/bundled data when the network is unavailable.

The HTTP transport, release discovery, release-archive activation, and the
release state machine now live in the ``sync/`` tier (``sync.transport``,
``sync.release_discovery``, ``sync.release_activation``, ``sync.release``);
this module re-exports them so existing ``prts_mcp.data.sync.*`` import paths
keep resolving, and retains the GameData-pair state machine
(``sync_release_archive`` / ``sync_release_archive_pair``), which moves to
``sync.gamedata_pair`` in P2.B.2.
"""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from uuid import uuid4

# ---------------------------------------------------------------------------
# sync/ tier re-exports (P2.A: transport + release_discovery; P2.B.1:
# _types + release_activation + release). Re-imported here so the state
# machine below, existing ``prts_mcp.data.sync.*`` import paths, and
# ``mock.patch("prts_mcp.data.sync.*")`` sites keep resolving until each
# symbol's CALLER relocates (see the P2.B caller-timing principle).
# ---------------------------------------------------------------------------
from prts_mcp.sync.transport import (  # noqa: F401
    _AssetNotFoundError,
    _GITHUB_UA,
    _get_cascading,
    _github_headers,
    _parse_mirrors,
    _url_candidates,
)
from prts_mcp.sync.release_discovery import (  # noqa: F401
    ReleaseSpec,
    _TAG_PREFIX,
    _asset_url,
    _latest_release_by_prefix,
    _list_releases,
    check_latest_release,
)
from prts_mcp.sync._types import (  # noqa: F401
    ReleaseArchiveSpec,
    RepoSpec,
    SyncResult,
)
from prts_mcp.sync.release_activation import (  # noqa: F401
    _ACTIVATION_LOCK_HEARTBEAT_SECONDS,
    _ACTIVATION_LOCK_OWNER_GRACE_SECONDS,
    _ACTIVATION_LOCK_STALE_SECONDS,
    _ACTIVATION_LOCK_TIMEOUT_SECONDS,
    _RELEASE_RETENTION_SECONDS,
    _active_archive_root,
    _archive_activation_lock,
    _archive_activation_sha,
    _archive_files_present,
    _archive_missing_files,
    _extract_meta_path,
    _load_extract_meta,
    _prune_release_trees,
    _releases_path,
    _safe_extract_zip,
    _save_extract_meta,
    _stage_release_tree,
    _validate_archive_zip,
)
from prts_mcp.sync.release import (  # noqa: F401
    DATA_CONTRACT_VERSION,
    CacheMeta,
    _CACHE_TTL_SECONDS,
    _cache_is_fresh,
    _release_cache_is_fresh,
    _release_cache_path,
    _release_zip_error,
    _sync_release_locked,
    _verify_release_manifest,
    download_release_asset,
    sync_release,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GAMEDATA_FILES: tuple[str, ...] = (
    "zh_CN/gamedata/excel/character_table.json",
    "zh_CN/gamedata/excel/handbook_info_table.json",
    "zh_CN/gamedata/excel/charword_table.json",
    "zh_CN/gamedata/excel/story_review_table.json",
    "zh_CN/gamedata/excel/enemy_handbook_table.json",
    "zh_CN/gamedata/excel/stage_table.json",
    "zh_CN/gamedata/excel/zone_table.json",
    "zh_CN/gamedata/excel/item_table.json",
)

_GAMEDATA_PAIR_META = ".gamedata_pair.json"


# ===========================================================================
# GameData pair state machine — moves to sync/gamedata_pair in P2.B.2.
# Calls into the relocated release / release_activation helpers via the
# re-exports above (bare-name lookup in this module's namespace).
# ===========================================================================


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
        with _archive_activation_lock(spec):
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
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    tmp.write_text(
        json.dumps(
            {
                "commit_sha": commit_sha,
                "excel_data_root": excel_root.relative_to(
                    excel_spec.local_root.resolve()
                ).as_posix(),
                "levels_data_root": levels_root.relative_to(
                    levels_spec.local_root.resolve()
                ).as_posix(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    tmp.replace(path)


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
    with _archive_activation_lock(lock_spec, ".gamedata-pair.lock"):
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
