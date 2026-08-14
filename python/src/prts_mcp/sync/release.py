"""Release sync: zip download + manifest verify + the release state machine.

Extracted from ``data/sync`` in P2.B.1. Owns ``CacheMeta``, the release-asset
download, the optional factory-manifest verification, and ``sync_release``
(the release-level state machine). ``data/sync`` re-exports these during the
P2.B migration; the archive/pair state machine still lives there until P2.B.2.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from prts_mcp.sync._types import RepoSpec, SyncResult
from prts_mcp.sync.release_activation import _archive_activation_lock
from prts_mcp.sync.release_discovery import (
    ReleaseSpec,
    _TAG_PREFIX,
    check_latest_release,
)
from prts_mcp.sync.transport import (
    _AssetNotFoundError,
    _get_cascading,
    _github_headers,
    _parse_mirrors,
)

_logger = logging.getLogger(__name__)

# Must match the factory manifest contract. Older releases without a manifest
# remain readable during the migration to the self-built pipeline.
DATA_CONTRACT_VERSION = "prts-mcp-data/v1"

# Skip the upstream SHA check if cached data is fresher than this many seconds.
_CACHE_TTL_SECONDS = 3600


@dataclass
class CacheMeta:
    """Persisted metadata about the last successful sync."""

    repo: str
    branch: str
    commit_sha: str
    fetched_at: str  # ISO 8601 UTC, e.g. "2025-01-01T00:00:00Z"
    files: list[str]

    @classmethod
    def load(cls, path: Path) -> CacheMeta | None:
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            commit_sha = data.get("commit_sha", data.get("commitSha"))
            fetched_at = data.get("fetched_at", data.get("fetchedAt"))
            files = data.get("files")
            if (
                not isinstance(commit_sha, str)
                or not commit_sha
                or not isinstance(fetched_at, str)
                or not fetched_at
                or not isinstance(files, list)
                or not all(isinstance(file, str) for file in files)
            ):
                return None
            return cls(
                repo=data["repo"],
                branch=data["branch"],
                commit_sha=commit_sha,
                fetched_at=fetched_at,
                files=files,
            )
        except (json.JSONDecodeError, TypeError, KeyError, AttributeError):
            return None

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        tmp.write_text(
            json.dumps({
                "repo": self.repo,
                "branch": self.branch,
                "commit_sha": self.commit_sha,
                "fetched_at": self.fetched_at,
                "files": self.files,
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)


def _cache_is_fresh(cache: CacheMeta) -> bool:
    """Return True if the cache was written within the TTL window."""
    try:
        ts = datetime.fromisoformat(cache.fetched_at.rstrip("Z")).replace(tzinfo=timezone.utc)
        age = (datetime.now(tz=timezone.utc) - ts).total_seconds()
        return age < _CACHE_TTL_SECONDS
    except (ValueError, AttributeError):
        return False


def _release_cache_path(spec: ReleaseSpec) -> Path:
    return spec.local_zip.parent / "release_meta.json"


def _release_cache_is_fresh(cache: CacheMeta) -> bool:
    return _cache_is_fresh(cache)


def download_release_asset(spec: ReleaseSpec, tag: str, url: str, timeout: float = 120.0) -> None:
    """Download a release asset zip atomically, then write cache metadata."""
    spec.local_zip.parent.mkdir(parents=True, exist_ok=True)
    tmp = spec.local_zip.with_name(
        f".{spec.local_zip.name}.{uuid4().hex}.tmp"
    )
    try:
        _logger.debug("Downloading release asset %s", url)
        response = _get_cascading(url, timeout=timeout, headers=_github_headers(), follow_redirects=True)
        tmp.write_bytes(response.content)
        if spec.validate_zip is not None:
            missing = spec.validate_zip(tmp)
            if missing:
                raise ValueError("Downloaded release asset is invalid: " + "; ".join(missing[:10]))
        if spec.verify_manifest:
            _verify_release_manifest(spec, tag, tmp, timeout=timeout)
        tmp.replace(spec.local_zip)

        # Extract version identifier from tag (format: "data-<versionId>")
        commit_sha = tag[len(_TAG_PREFIX):] if tag.startswith(_TAG_PREFIX) else tag
        CacheMeta(
            repo=f"{spec.owner}/{spec.repo}",
            branch="releases",
            commit_sha=commit_sha,
            fetched_at=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            files=[spec.asset_name],
        ).save(_release_cache_path(spec))
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _verify_release_manifest(
    spec: ReleaseSpec, tag: str, asset_path: Path, *, timeout: float,
) -> None:
    """Verify an asset against the optional factory manifest asset.

    Older releases predate the manifest asset and remain readable during the
    transition; once a release publishes one, mismatches fail closed.
    """
    if tag == "unknown":
        manifest_url = (
            f"https://github.com/{spec.owner}/{spec.repo}/releases/latest/download/manifest.json"
        )
    else:
        manifest_url = (
            f"https://github.com/{spec.owner}/{spec.repo}/releases/download/{tag}/manifest.json"
        )
    try:
        response = _get_cascading(
            manifest_url, timeout=timeout, headers=_github_headers(), follow_redirects=True,
        )
    except _AssetNotFoundError:
        # Direct URL confirmed 404 → release predates the manifest asset.
        return
    except Exception as exc:
        raise ValueError(f"manifest unavailable for {tag}: {exc}") from exc
    try:
        manifest = response.json()
        if not isinstance(manifest, dict):
            raise ValueError("manifest root must be an object")
        if manifest.get("contractVersion") != DATA_CONTRACT_VERSION:
            raise ValueError(
                f"unsupported contractVersion {manifest.get('contractVersion')!r}"
            )
        expected = manifest["assets"][spec.asset_name]
        expected_size = int(expected["size"])
        expected_sha = str(expected["sha256"])
        expected_version = tag.removeprefix("data-")
        source = manifest.get("source", {})
        if not isinstance(source, dict):
            raise ValueError("manifest source must be an object")
        source_version = source.get("versionId")
        if tag.startswith("data-") and source_version != expected_version:
            raise ValueError("manifest source version does not match release tag")
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError(f"manifest for {tag} is invalid: {exc}") from exc
    actual_sha = hashlib.sha256(asset_path.read_bytes()).hexdigest()
    if expected_size != asset_path.stat().st_size or expected_sha != actual_sha:
        raise ValueError(
            f"manifest mismatch for {spec.asset_name}: "
            f"expected {expected_size}/{expected_sha}, "
            f"got {asset_path.stat().st_size}/{actual_sha}"
        )


def _sync_release_locked(spec: ReleaseSpec, *, force_check: bool = False) -> SyncResult:
    """Check latest GitHub Release and download asset if the tag has changed.

    Decision tree mirrors the legacy per-file sync path:
      1. Cache fresh + zip exists → up_to_date
      2. Network failure → offline_fallback / no_data
      3. Tag unchanged + zip exists → up_to_date (refresh fetched_at)
      4. Tag changed or zip missing → download → updated / offline_fallback / no_data
    """
    # Wrap ReleaseSpec in a minimal RepoSpec-like object for SyncResult
    _dummy_spec = RepoSpec(
        owner=spec.owner,
        repo=spec.repo,
        branch="releases",
        files=(spec.asset_name,),
        local_root=spec.local_zip.parent,
    )

    cache = CacheMeta.load(_release_cache_path(spec))
    zip_error = _release_zip_error(spec)
    zip_ok = zip_error is None

    if (
        not force_check
        and cache is not None
        and zip_ok
        and _release_cache_is_fresh(cache)
    ):
        _logger.debug("Release cache is fresh for %s/%s; skipping check.", spec.owner, spec.repo)
        return SyncResult(spec=_dummy_spec, status="up_to_date", commit_sha=cache.commit_sha, error=None)

    result = check_latest_release(spec)

    if result is None:
        if zip_ok:
            return SyncResult(
                spec=_dummy_spec,
                status="offline_fallback",
                commit_sha=cache.commit_sha if cache else None,
                error="Network unavailable",
            )
        # No zip and API unreachable — attempt blind download via releases/latest/download/
        # (does not require the GitHub API; ghproxy and similar mirrors support this URL).
        if _parse_mirrors():
            blind_url = f"https://github.com/{spec.owner}/{spec.repo}/releases/latest/download/{spec.asset_name}"
            try:
                download_release_asset(spec, "unknown", blind_url)
                return SyncResult(spec=_dummy_spec, status="updated", commit_sha="unknown", error=None)
            except Exception as exc:  # noqa: BLE001
                return SyncResult(spec=_dummy_spec, status="no_data", commit_sha=None, error=str(exc))
        error = "Network unavailable and no cached zip"
        if spec.local_zip.is_file() and zip_error:
            error += f"; cached zip invalid: {zip_error}"
        return SyncResult(spec=_dummy_spec, status="no_data", commit_sha=None, error=error)

    tag, asset_url = result
    upstream_sha = tag[len(_TAG_PREFIX):] if tag.startswith(_TAG_PREFIX) else tag

    if cache is not None and cache.commit_sha == upstream_sha and zip_ok:
        CacheMeta(
            repo=cache.repo,
            branch=cache.branch,
            commit_sha=cache.commit_sha,
            fetched_at=datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            files=cache.files,
        ).save(_release_cache_path(spec))
        return SyncResult(spec=_dummy_spec, status="up_to_date", commit_sha=upstream_sha, error=None)

    try:
        download_release_asset(spec, tag, asset_url)
        return SyncResult(spec=_dummy_spec, status="updated", commit_sha=upstream_sha, error=None)
    except Exception as exc:  # noqa: BLE001
        error_msg = str(exc)
        if zip_ok:
            return SyncResult(
                spec=_dummy_spec,
                status="offline_fallback",
                commit_sha=cache.commit_sha if cache else None,
                error=error_msg,
            )
        return SyncResult(spec=_dummy_spec, status="no_data", commit_sha=None, error=error_msg)


def _release_zip_error(spec: ReleaseSpec) -> str | None:
    if not spec.local_zip.is_file():
        return "zip file is missing"
    validator = spec.validate_zip
    if validator is None:
        return None
    try:
        missing = validator(spec.local_zip)
    except Exception as exc:  # noqa: BLE001
        return f"{spec.local_zip.name} is not a valid zip: {exc}"
    if not missing:
        return None
    return "; ".join(str(path) for path in missing[:10])


def sync_release(spec: ReleaseSpec, *, force_check: bool = False) -> SyncResult:
    """Publish a release ZIP and its metadata as one serialized operation."""
    dummy_spec = RepoSpec(
        owner=spec.owner,
        repo=spec.repo,
        branch="releases",
        files=(spec.asset_name,),
        local_root=spec.local_zip.parent,
    )
    try:
        spec.local_zip.parent.mkdir(parents=True, exist_ok=True)
        with _archive_activation_lock(spec, ".release.lock"):
            return _sync_release_locked(spec, force_check=force_check)
    except Exception as exc:  # noqa: BLE001
        cache = CacheMeta.load(_release_cache_path(spec))
        return SyncResult(
            spec=dummy_spec,
            status=(
                "offline_fallback"
                if _release_zip_error(spec) is None
                else "no_data"
            ),
            commit_sha=cache.commit_sha if cache is not None else None,
            error=str(exc),
        )
