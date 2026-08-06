"""AKDP image asset sync for ``LOCAL_IMAGE=true`` mode.

Discovers ``images-*`` GitHub Releases from the arknights-data-pipeline
factory, downloads baseline shard zips + delta zips, and atomically
activates a generation directory of PNG files indexed by ``index.json``.

This module reuses the JSON sync's reliability primitives (cascading mirrors,
atomic activation, cross-process locking, offline fallback) from
:mod:`prts_mcp.data.sync`, but uses an images-specific discovery path:
images Releases are tag-isolated from ``data-*`` Releases and cannot use the
``/releases/latest`` endpoint (see
``arknights-data-pipeline/docs/image-index-schema.md`` §6).
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
import time
from pathlib import Path
from uuid import uuid4

import httpx

from prts_mcp.data.images import SCHEMA_VERSION, parse_index
from prts_mcp.data.sync import (
    ReleaseSpec,
    RepoSpec,
    SyncResult,
    _archive_activation_lock,
    _get_cascading,
    _github_headers,
    _safe_extract_zip,
    _url_candidates,
)

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
_RETENTION_SECONDS = 24 * 60 * 60
_IMAGES_META = ".images_meta.json"
_IMAGES_LOCK = ".images.lock"


def needed_shard_keys(include_original: bool) -> tuple[str, ...]:
    """Return the shard keys to download given the original-variant flag."""
    return _DEFAULT_SHARD_KEYS + (_ORIGINAL_SHARD_KEYS if include_original else ())


# ---------------------------------------------------------------------------
# Discovery (tag-prefix filtered; /releases/latest is not usable — schema §6)
# ---------------------------------------------------------------------------


def _list_releases(owner: str, repo: str, *, timeout: float = 10.0) -> list[dict] | None:
    """List all non-draft releases. Returns None on any network/API failure."""
    url = f"https://api.github.com/repos/{owner}/{repo}/releases?per_page=100"
    try:
        response = _get_cascading(url, timeout=timeout, headers=_github_headers())
        data = response.json()
        return data if isinstance(data, list) else None
    except Exception:  # noqa: BLE001
        return None


def _latest_release_by_prefix(
    releases: list[dict],
    prefix: str,
    *,
    exclude_prefix: str | None = None,
) -> dict | None:
    """Pick the newest release whose tag starts with ``prefix``.

    Sorts by ``created_at`` (GitHub release creation timestamp) descending,
    which is robust across baseline/delta tag formats.
    """
    candidates: list[dict] = []
    for release in releases:
        tag = release.get("tag_name")
        if not isinstance(tag, str) or not tag.startswith(prefix):
            continue
        if exclude_prefix and tag.startswith(exclude_prefix):
            continue
        candidates.append(release)
    if not candidates:
        return None
    candidates.sort(key=lambda r: str(r.get("created_at", "")), reverse=True)
    return candidates[0]


def _asset_url(release: dict, asset_name: str) -> str | None:
    for asset in release.get("assets", []):
        if isinstance(asset, dict) and asset.get("name") == asset_name:
            url = asset.get("browser_download_url")
            if isinstance(url, str):
                return url
    return None


def _release_download_url(tag: str, asset_name: str) -> str:
    """Construct a direct download URL (no API call; ghproxy-friendly)."""
    return (
        f"https://github.com/{IMAGES_REPO_OWNER}/{IMAGES_REPO}"
        f"/releases/download/{tag}/{asset_name}"
    )


# ---------------------------------------------------------------------------
# Downloads
# ---------------------------------------------------------------------------


def _download_small(url: str, *, timeout: float = 30.0) -> bytes | None:
    """Download a small asset (index.json) into memory. None on failure."""
    try:
        response = _get_cascading(
            url, timeout=timeout, headers=_github_headers(), follow_redirects=True,
        )
        return response.content
    except Exception as exc:  # noqa: BLE001
        _logger.debug("Failed to download %s: %s", url, exc)
        return None


def _download_large(url: str, dest: Path, *, timeout: float = 300.0) -> None:
    """Stream-download a large asset (shard zip) to ``dest`` atomically.

    Cascades through mirrors on failure, mirroring :func:`_get_cascading`
    but with chunked writes so multi-hundred-MB shards do not stay resident.
    Raises on total failure; the caller decides whether to fall back.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{uuid4().hex}.tmp")
    last_exc: BaseException = RuntimeError(f"All URL candidates failed for {url}")
    try:
        for i, candidate in enumerate(_url_candidates(url)):
            try:
                with httpx.stream(
                    "GET",
                    candidate,
                    timeout=timeout,
                    headers=_github_headers(),
                    follow_redirects=True,
                ) as response:
                    if not response.is_success:
                        last_exc = RuntimeError(f"HTTP {response.status_code}")
                        # Direct 4xx → resource genuinely missing; stop.
                        if i == 0 and 400 <= response.status_code < 500:
                            raise last_exc
                        continue
                    with tmp.open("wb") as dst:
                        for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                            dst.write(chunk)
                tmp.replace(dest)
                return
            except RuntimeError:
                raise
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                continue
        raise last_exc
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Generation state (.images_meta.json + .releases/<gen>/)
# ---------------------------------------------------------------------------


def _meta_path(root: Path) -> Path:
    return root / _IMAGES_META


def _load_meta(root: Path) -> dict | None:
    try:
        data = json.loads(_meta_path(root).read_text("utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _save_meta(root: Path, meta: dict) -> None:
    path = _meta_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(path)


def _active_generation(image_dir: Path) -> Path | None:
    """Resolve the currently activated generation directory, or None."""
    meta = _load_meta(image_dir)
    if meta is None:
        return None
    rel = meta.get("generation_root")
    if not isinstance(rel, str) or not rel:
        return None
    gen = (image_dir / rel).resolve()
    try:
        if not gen.is_relative_to(image_dir.resolve()):
            return None
    except ValueError:
        return None
    if not gen.is_dir() or not (gen / "index.json").is_file():
        return None
    return gen


def _releases_dir(image_dir: Path) -> Path:
    releases = image_dir / ".releases"
    releases.mkdir(parents=True, exist_ok=True)
    return releases


def _version_hash(version: str) -> str:
    return hashlib.sha256(version.encode("utf-8")).hexdigest()[:16]


def _prune_generations(releases_dir: Path, keep: Path) -> None:
    cutoff = time.time() - _RETENTION_SECONDS
    for candidate in releases_dir.iterdir():
        if candidate == keep or candidate.name.startswith("."):
            continue
        try:
            if candidate.stat().st_mtime >= cutoff:
                continue
        except OSError:
            continue
        if candidate.is_dir():
            shutil.rmtree(candidate, ignore_errors=True)


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
    if _active_generation(image_dir) is not None:
        meta = _load_meta(image_dir)
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

    releases = _list_releases(IMAGES_REPO_OWNER, IMAGES_REPO)
    if releases is None:
        return _offline_or_no_data(image_dir, error="Network unavailable")

    delta_release = _latest_release_by_prefix(
        releases,
        _DELTA_PREFIX,
        exclude_prefix=_BASELINE_PREFIX,
    )
    if delta_release is None:
        return _offline_or_no_data(image_dir, error="No images delta release found")

    delta_tag = str(delta_release.get("tag_name", ""))
    current_version = delta_tag[len(_DELTA_PREFIX):]

    # index.json is a standalone asset on the delta Release (~1.1 MB).
    index_url = _asset_url(delta_release, "index.json")
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

    meta = _load_meta(image_dir)
    gen_dir = _active_generation(image_dir)
    synced = meta.get("shardsSynced") if meta else None
    same_shards = isinstance(synced, list) and set(synced) == set(shard_keys)
    if (
        meta is not None
        and gen_dir is not None
        and meta.get("currentVersion") == current_version
        and meta.get("baselineVersion") == baseline_version
        and same_shards
    ):
        return SyncResult(spec, "up_to_date", current_version, None)

    # --- Rebuild a new generation -----------------------------------------
    releases_dir = _releases_dir(image_dir)
    generation = f"{_version_hash(current_version)}-{uuid4().hex}"
    staging = releases_dir / f".{generation}.tmp"
    activated = releases_dir / generation
    try:
        staging.mkdir(parents=True, exist_ok=False)

        baseline_unchanged = (
            meta is not None
            and gen_dir is not None
            and meta.get("baselineVersion") == baseline_version
            and same_shards
        )
        if baseline_unchanged:
            # Fast path: reuse prior PNGs, overlay only the new delta.
            shutil.copytree(gen_dir, staging, dirs_exist_ok=True)
            for stale in ("index.json", _IMAGES_META):
                (staging / stale).unlink(missing_ok=True)
        else:
            baseline_tag = f"{_BASELINE_PREFIX}{baseline_version}"
            for shard_key in shard_keys:
                shard_file = index.shards.get(shard_key, "")
                if not shard_file:
                    continue
                shard_zip = staging / f".{shard_key}.zip"
                _download_large(
                    _release_download_url(baseline_tag, shard_file),
                    shard_zip,
                )
                _safe_extract_zip(shard_zip, staging)
                shard_zip.unlink(missing_ok=True)

        # Delta: overlay incremental PNGs. A download/extract failure must
        # propagate (not be swallowed) so a half-applied delta never activates
        # — the authoritative index.json would otherwise reference PNGs that
        # are absent. The sentinel delta (empty zip) downloads and extracts
        # without raising, so it passes through cleanly.
        delta_asset = f"{_DELTA_ASSET_PREFIX}{current_version}.zip"
        delta_url = _asset_url(delta_release, delta_asset)
        if delta_url is not None:
            delta_zip = staging / ".delta.zip"
            _download_large(delta_url, delta_zip)
            _safe_extract_zip(delta_zip, staging)
            delta_zip.unlink(missing_ok=True)

        # Authoritative index.json + generation meta.
        (staging / "index.json").write_bytes(index_bytes)
        gen_meta = {
            "schemaVersion": SCHEMA_VERSION,
            "baselineVersion": baseline_version,
            "currentVersion": current_version,
            "shardsSynced": list(shard_keys),
        }
        _save_meta(staging, gen_meta)

        # Atomic activation.
        if activated.exists():
            shutil.rmtree(activated)
        staging.replace(activated)
        staging = None

        # Top-level meta points at the active generation.
        _save_meta(
            image_dir,
            {**gen_meta, "generation_root": str(activated.relative_to(image_dir))},
        )
        _prune_generations(releases_dir, activated)
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
        with _archive_activation_lock(lock_spec, _IMAGES_LOCK):
            return _sync_images_locked(image_dir, shard_keys, force_check=force_check)
    except Exception as exc:  # noqa: BLE001
        return _offline_or_no_data(image_dir, error=str(exc))
