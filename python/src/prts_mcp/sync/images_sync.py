"""AKDP image asset sync for ``LOCAL_IMAGE=true`` mode.

Discovers ``images-*`` GitHub Releases from the arknights-data-pipeline
factory, downloads baseline shard zips + delta zips, and atomically
activates a generation directory of PNG files indexed by ``index.json``.

Moved from ``data/images_sync`` into the ``sync/`` tier in P3.B (it is a
sync state machine, not a data reader). It reuses the shared sync
primitives — cascading transport, atomic activation, cross-process
locking, offline fallback — but keeps an images-specific discovery path:
images Releases are tag-isolated from ``data-*`` Releases and cannot use
the ``/releases/latest`` endpoint (see
``arknights-data-pipeline/docs/image-index-schema.md`` §6).
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
from pathlib import Path
from uuid import uuid4

from prts_mcp.data.images import ImagesIndex, SCHEMA_VERSION, parse_index
from prts_mcp.sync._types import RepoSpec, SyncResult
from prts_mcp.sync.generation_store import (
    IMAGES_META,
    active_generation,
    load_meta,
    prune_generations,
    releases_dir,
    save_meta,
    version_hash,
)
from prts_mcp.sync.release_activation import safe_extract_zip, with_archive_activation_lock
from prts_mcp.sync.release_discovery import (
    ReleaseSpec,
    asset_url,
    latest_release_by_prefix,
    list_releases,
    list_releases_paginated,
)
from prts_mcp.sync.transport import get_cascading, github_headers, stream_cascading

_logger = logging.getLogger(__name__)

IMAGES_REPO_OWNER = "3aKHP"
IMAGES_REPO = "arknights-data-pipeline"

_DELTA_PREFIX = "images-"
_BASELINE_PREFIX = "images-baseline-"
_DELTA_ASSET_PREFIX = "images-delta-"

# Default shard set: large + preview. original variants are added only when
# ORIGINAL_IMAGE=true, to avoid pulling ~3.6 GB of full-res assets that most
# deployments never read.
_DEFAULT_SHARD_KEYS: tuple[str, ...] = (
    "chararts-large",
    "chararts-preview",
    "skinpack-large",
    "skinpack-preview",
)
_ORIGINAL_SHARD_KEYS: tuple[str, ...] = (
    "chararts-original",
    "skinpack-original",
)
_IMAGES_LOCK = ".images.lock"


def _shard_variant_names(shard_keys: tuple[str, ...]) -> set[str]:
    """Map shard keys (e.g. ``chararts-large``) to variant names (e.g. ``large``)."""
    return {key.rsplit("-", 1)[-1] for key in shard_keys}


def _sha256_file(path: Path) -> str:
    """Stream-hash a file so large PNGs do not stay resident (#100 CR)."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _verify_variant_hashes(
    staging: Path, index: ImagesIndex, shard_keys: tuple[str, ...],
) -> None:
    """Verify each synced variant PNG matches its index sha256 (#100).

    Only variants whose shard was downloaded are checked. A corrupted,
    tampered, or incomplete shard (a wanted variant whose PNG is absent)
    raises so activation never happens on bad data.
    """
    wanted = _shard_variant_names(shard_keys)
    checked = 0
    mismatches = 0
    for skin_id, entry in index.artworks.items():
        for vname, variant in entry.variants.items():
            if vname not in wanted:
                continue
            png_path = staging / variant.file
            if not png_path.is_file():
                # Incomplete shard: a wanted variant's file is absent.
                mismatches += 1
                checked += 1
                if mismatches <= 3:
                    _logger.warning(
                        "images sha256 mismatch: %s/%s file missing: %s",
                        skin_id, vname, variant.file,
                    )
                continue
            actual = _sha256_file(png_path)
            checked += 1
            if actual != variant.sha256:
                mismatches += 1
                if mismatches <= 3:
                    _logger.warning(
                        "images sha256 mismatch: %s/%s expected %s got %s",
                        skin_id, vname, variant.sha256[:12], actual[:12],
                    )
    if mismatches:
        raise ValueError(
            f"images sha256 verification failed: {mismatches} of {checked} variants mismatch"
        )


def needed_shard_keys(include_original: bool) -> tuple[str, ...]:
    """Return the shard keys to download given the original-variant flag."""
    return _DEFAULT_SHARD_KEYS + (_ORIGINAL_SHARD_KEYS if include_original else ())


# ---------------------------------------------------------------------------
# Discovery helpers (list_releases, latest_release_by_prefix, asset_url)
# are imported from sync.release_discovery — data and images releases share
# the same pattern.
# ---------------------------------------------------------------------------


def _release_download_url(tag: str, asset_name: str) -> str:
    """Construct a direct download URL (no API call; ghproxy-friendly)."""
    return (
        f"https://github.com/{IMAGES_REPO_OWNER}/{IMAGES_REPO}"
        f"/releases/download/{tag}/{asset_name}"
    )


def _images_tag_version(tag: object) -> str | None:
    """Extract the version from any ``images-*`` tag (baseline or delta)."""
    if not isinstance(tag, str):
        return None
    if tag.startswith(_BASELINE_PREFIX):
        return tag[len(_BASELINE_PREFIX):]
    if tag.startswith(_DELTA_PREFIX):
        return tag[len(_DELTA_PREFIX):]
    return None


def _enumerate_delta_chain(
    releases: list[dict],
    baseline_version: str,
    current_version: str,
) -> list[tuple[str, dict]] | None:
    """Enumerate ``(version, release)`` deltas with baseline < v <= current.

    Version strings are fixed-width (``YY-MM-DD-HH-MM-SS_hash``), so
    lexicographic order is chronological — do not trust ``created_at``.
    Duplicate versions fail closed (None). Versions the pipeline never
    published as a Release cannot be enumerated here; the final sha256
    verification remains the authoritative completeness gate (#179).
    """
    chain: list[tuple[str, dict]] = []
    for release in releases:
        tag = release.get("tag_name")
        if not isinstance(tag, str) or not tag.startswith(_DELTA_PREFIX):
            continue
        if tag.startswith(_BASELINE_PREFIX):
            continue
        version = tag[len(_DELTA_PREFIX):]
        if baseline_version < version <= current_version:
            chain.append((version, release))
    versions = [version for version, _ in chain]
    if len(set(versions)) != len(versions):
        return None
    chain.sort(key=lambda item: item[0])
    return chain


# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------


def _download_small(url: str, *, timeout: float = 30.0) -> bytes | None:
    """Download a small asset (index.json) into memory. None on failure."""
    try:
        response = get_cascading(
            url, timeout=timeout, headers=github_headers(), follow_redirects=True,
        )
        return response.content
    except Exception as exc:  # noqa: BLE001
        _logger.debug("Failed to download %s: %s", url, exc)
        return None


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------


def _dummy_spec(image_dir: Path) -> RepoSpec:
    return RepoSpec(
        owner=IMAGES_REPO_OWNER,
        repo=IMAGES_REPO,
        branch="releases",
        files=("images",),
        local_root=image_dir,
    )


def _offline_or_no_data(image_dir: Path, *, error: str) -> SyncResult:
    """Return offline_fallback if cached images exist, else no_data."""
    spec = _dummy_spec(image_dir)
    if active_generation(image_dir) is not None:
        meta = load_meta(image_dir)
        ver = meta.get("currentVersion") if meta else None
        return SyncResult(
            spec,
            "offline_fallback",
            ver if isinstance(ver, str) else None,
            error,
        )
    return SyncResult(spec, "no_data", None, error)


def _sync_images_locked(
    image_dir: Path,
    shard_keys: tuple[str, ...],
    *,
    force_check: bool,
) -> SyncResult:
    spec = _dummy_spec(image_dir)

    releases = list_releases(IMAGES_REPO_OWNER, IMAGES_REPO)
    if releases is None:
        return _offline_or_no_data(image_dir, error="Network unavailable")

    delta_release = latest_release_by_prefix(
        releases,
        _DELTA_PREFIX,
        exclude_prefix=_BASELINE_PREFIX,
    )
    if delta_release is None:
        return _offline_or_no_data(image_dir, error="No images delta release found")

    delta_tag = str(delta_release.get("tag_name", ""))
    tag_version = delta_tag[len(_DELTA_PREFIX):]

    meta = load_meta(image_dir)
    gen_dir = active_generation(image_dir)
    synced = meta.get("shardsSynced") if meta else None
    same_shards = isinstance(synced, list) and set(synced) == set(shard_keys)

    # Tag-level shortcut: if the release tag's currentVersion and the shard
    # set already match the active generation, skip the ~1.1 MB index.json
    # download. baselineVersion rides in index.json but cannot change without
    # a new delta tag, so tag equality implies baseline equality. force_check
    # still drives a real GitHub API call here; a TTL freshness skip like
    # sync.py's _cache_is_fresh is deferred (the API call is cheap; only the
    # index.json download is avoided when the tag is unchanged).
    if (
        meta is not None
        and gen_dir is not None
        and meta.get("currentVersion") == tag_version
        and same_shards
    ):
        return SyncResult(spec, "up_to_date", tag_version, None)

    # Tag differs (or first sync) → download index.json and rebuild.
    index_url = asset_url(delta_release, "index.json")
    index_bytes = _download_small(index_url) if index_url else None
    if index_bytes is None:
        return _offline_or_no_data(image_dir, error="Failed to download index.json")

    try:
        index_data = json.loads(index_bytes.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return SyncResult(spec, "no_data", None, "index.json is unreadable")

    index = parse_index(index_data)
    if index is None:
        return SyncResult(spec, "no_data", None, "index.json schema mismatch")

    baseline_version = index.baseline_version

    # The index is authoritative for currentVersion; the latest delta tag is
    # only a discovery hint. A drift between the two would pick the wrong
    # chain endpoint and delta asset names — fail closed (#179).
    current_version = index.current_version
    if not current_version or current_version != tag_version:
        return _offline_or_no_data(
            image_dir,
            error="index.json currentVersion does not match the latest images delta tag",
        )

    # Fast path is only valid when the prior generation sits on the same
    # baseline, syncs the same shards, and is not ahead of the authoritative
    # index. A rollback (prior current > index current) drops the fast path
    # and rebuilds from baseline + the full chain (#179).
    prior_current = meta.get("currentVersion") if meta else None
    baseline_unchanged = (
        meta is not None
        and gen_dir is not None
        and meta.get("baselineVersion") == baseline_version
        and same_shards
        and isinstance(prior_current, str)
        and prior_current <= current_version
    )
    apply_after = (
        prior_current
        if baseline_unchanged and isinstance(prior_current, str)
        else baseline_version
    )

    # Delta-chain enumeration must see every images release back to
    # apply_after; the newest-100 page may not reach that far (#179).
    def _covers_chain_start(release: dict) -> bool:
        version = _images_tag_version(release.get("tag_name"))
        return version is not None and version <= apply_after

    if not any(_covers_chain_start(r) for r in releases):
        paged = list_releases_paginated(
            IMAGES_REPO_OWNER, IMAGES_REPO, stop=_covers_chain_start,
        )
        if paged is None:
            return _offline_or_no_data(
                image_dir,
                error="Release history does not cover the images baseline",
            )
        releases = paged

    chain = _enumerate_delta_chain(releases, baseline_version, current_version)
    if chain is None:
        return _offline_or_no_data(
            image_dir, error="images delta chain has duplicate versions",
        )

    pending = [(v, r) for v, r in chain if v > apply_after]
    # Fail fast on a missing delta asset *before* the ~1.5 GB baseline
    # download, so a broken chain never burns the transfer budget (#179).
    for chain_version, chain_release in pending:
        if asset_url(chain_release, f"{_DELTA_ASSET_PREFIX}{chain_version}.zip") is None:
            return _offline_or_no_data(
                image_dir,
                error=f"images delta asset missing: {_DELTA_ASSET_PREFIX}{chain_version}.zip",
            )

    # --- Rebuild a new generation -----------------------------------------
    tree_root = releases_dir(image_dir)
    generation = f"{version_hash(current_version)}-{uuid4().hex}"
    staging = tree_root / f".{generation}.tmp"
    activated = tree_root / generation
    try:
        staging.mkdir(parents=True, exist_ok=False)

        if baseline_unchanged:
            # Fast path: reuse prior PNGs, overlay only the newer deltas.
            shutil.copytree(gen_dir, staging, dirs_exist_ok=True)
            for stale in ("index.json", IMAGES_META):
                (staging / stale).unlink(missing_ok=True)
        else:
            baseline_tag = f"{_BASELINE_PREFIX}{baseline_version}"
            for shard_key in shard_keys:
                shard_file = index.shards.get(shard_key, "")
                if not shard_file:
                    continue
                shard_zip = staging / f".{shard_key}.zip"
                stream_cascading(
                    _release_download_url(baseline_tag, shard_file),
                    shard_zip,
                )
                safe_extract_zip(shard_zip, staging)
                shard_zip.unlink(missing_ok=True)

        # Delta chain: overlay every pending incremental in version order.
        # A download/extract failure must propagate (not be swallowed) so a
        # half-applied chain never activates — the authoritative index.json
        # would otherwise reference PNGs that are absent. Sentinel deltas
        # (empty zips) extract cleanly and pass through.
        for seq, (chain_version, chain_release) in enumerate(pending, 1):
            delta_url = asset_url(
                chain_release, f"{_DELTA_ASSET_PREFIX}{chain_version}.zip",
            )
            if delta_url is None:  # vanished since the pre-download check
                raise ValueError(
                    f"images delta asset missing: "
                    f"{_DELTA_ASSET_PREFIX}{chain_version}.zip"
                )
            delta_zip = staging / ".delta.zip"
            stream_cascading(delta_url, delta_zip)
            safe_extract_zip(delta_zip, staging)
            delta_zip.unlink(missing_ok=True)
            _logger.info(
                "Applied images delta %s (%d/%d)",
                chain_version[:16], seq, len(pending),
            )

        # Verify every synced variant's sha256 against the index before
        # activation (#100): a corrupted or tampered shard must not activate.
        _verify_variant_hashes(staging, index, shard_keys)

        # Authoritative index.json + generation meta.
        (staging / "index.json").write_bytes(index_bytes)
        gen_meta = {
            "schemaVersion": SCHEMA_VERSION,
            "baselineVersion": baseline_version,
            "currentVersion": current_version,
            "shardsSynced": list(shard_keys),
        }
        save_meta(staging, gen_meta)

        # Atomic activation.
        if activated.exists():
            shutil.rmtree(activated)
        staging.replace(activated)
        staging = None

        # Top-level meta points at the active generation.
        save_meta(
            image_dir,
            {**gen_meta, "generation_root": str(activated.relative_to(image_dir))},
        )
        prune_generations(tree_root, activated)
        _logger.info(
            "Images synced: baseline=%s current=%s (%d artworks)",
            baseline_version[:16],
            current_version[:16],
            len(index.artworks),
        )
        return SyncResult(spec, "updated", current_version, None)
    except Exception as exc:  # noqa: BLE001
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
        return _offline_or_no_data(image_dir, error=str(exc))


def sync_images(
    image_dir: Path | str,
    *,
    include_original: bool = False,
    force_check: bool = False,
) -> SyncResult:
    """Discover, download and activate AKDP image assets under ``image_dir``.

    Returns a :class:`SyncResult` compatible with the auto-sync scheduler.
    The ``commit_sha`` field carries the images ``currentVersion``.
    """
    image_dir = Path(image_dir)
    image_dir.mkdir(parents=True, exist_ok=True)
    shard_keys = needed_shard_keys(include_original)
    lock_spec = ReleaseSpec(
        owner=IMAGES_REPO_OWNER,
        repo=IMAGES_REPO,
        asset_name="images-sync",
        local_zip=image_dir / ".images-sync",
    )
    try:
        with with_archive_activation_lock(lock_spec, _IMAGES_LOCK):
            return _sync_images_locked(image_dir, shard_keys, force_check=force_check)
    except Exception as exc:  # noqa: BLE001
        return _offline_or_no_data(image_dir, error=str(exc))
