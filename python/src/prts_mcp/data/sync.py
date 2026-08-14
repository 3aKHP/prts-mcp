"""GitHub-backed data sync for PRTS-MCP.

The full sync state machine — HTTP transport, release discovery,
release-archive activation, the release state machine, and the GameData-pair
state machine — now lives in the ``sync/`` tier. This module is a re-export
barrel that preserves the ``prts_mcp.data.sync.*`` import paths for callers
that have not yet migrated to importing from ``prts_mcp.sync.*`` directly.
"""
from __future__ import annotations

from prts_mcp.sync.transport import (  # noqa: F401  (re-exported to preserve the data/sync namespace)
    _AssetNotFoundError,
    _GITHUB_UA,
    _parse_mirrors,
    get_cascading,
    github_headers,
    stream_cascading,
    url_candidates,
)
from prts_mcp.sync.release_discovery import (  # noqa: F401
    ReleaseSpec,
    _TAG_PREFIX,
    asset_url,
    check_latest_release,
    latest_release_by_prefix,
    list_releases,
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
    _ActivationLockTimeoutError,
    _RELEASE_RETENTION_SECONDS,
    _active_archive_root,
    _archive_activation_sha,
    _archive_files_present,
    _archive_missing_files,
    _extract_meta_path,
    _load_extract_meta,
    _prune_release_trees,
    _releases_path,
    _save_extract_meta,
    _stage_release_tree,
    _validate_archive_zip,
    safe_extract_zip,
    with_archive_activation_lock,
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
from prts_mcp.sync.gamedata_pair import (  # noqa: F401
    sync_release_archive,
    sync_release_archive_pair,
)

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
