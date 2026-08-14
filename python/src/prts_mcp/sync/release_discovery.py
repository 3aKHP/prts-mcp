"""GitHub Release discovery: tag-prefix-filtered list / latest / asset_url.

Extracted from ``data/sync`` (P2.A). The arknights-data-pipeline repo hosts
both ``data-*`` and ``images-*`` GitHub Releases; ``/releases/latest`` may
point at an ``images-*`` release if GitHub auto-promotes it, so data sync
filters by tag prefix instead. ``data/sync`` re-exports these and
``ReleaseSpec`` during the P2.A→P2.B migration.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from prts_mcp.sync.transport import get_cascading, github_headers

_logger = logging.getLogger(__name__)

_TAG_PREFIX = "data-"


# ---------------------------------------------------------------------------
# Release discovery (tag-prefix filtered)
#
# The arknights-data-pipeline repo hosts both ``data-*`` and ``images-*``
# GitHub Releases.  ``/releases/latest`` may point at an ``images-*`` release
# if GitHub auto-promotes it, so data sync must filter by tag prefix instead.
# (images_sync reuses these helpers for its own prefix filtering.)
# ---------------------------------------------------------------------------


def list_releases(owner: str, repo: str, *, timeout: float = 10.0) -> list[dict] | None:
    """List all non-draft releases. Returns None on any network/API failure."""
    url = f"https://api.github.com/repos/{owner}/{repo}/releases?per_page=100"
    try:
        response = get_cascading(url, timeout=timeout, headers=github_headers())
        data = response.json()
        return data if isinstance(data, list) else None
    except Exception:  # noqa: BLE001
        return None


def latest_release_by_prefix(
    releases: list[dict],
    prefix: str,
    *,
    exclude_prefix: str | None = None,
) -> dict | None:
    """Pick the newest release whose tag starts with *prefix*.

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


def asset_url(release: dict, asset_name: str) -> str | None:
    """Extract the ``browser_download_url`` for *asset_name* from a release dict."""
    for asset in release.get("assets", []):
        if isinstance(asset, dict) and asset.get("name") == asset_name:
            url = asset.get("browser_download_url")
            if isinstance(url, str):
                return url
    return None


@dataclass(frozen=True)
class ReleaseSpec:
    """Describes a GitHub Release asset to download as a local zip."""

    owner: str
    repo: str
    asset_name: str   # e.g. "zh_CN.zip"
    local_zip: Path   # destination path on disk
    validate_zip: Callable[[Path], list[str]] | None = None
    verify_manifest: bool = False


def check_latest_release(spec: ReleaseSpec, timeout: float = 10.0) -> tuple[str, str] | None:
    """Return ``(tag_name, asset_download_url)`` for the latest ``data-*`` release.

    Uses the releases list API with tag-prefix filtering instead of
    ``/releases/latest``, because the data-pipeline repo also hosts
    ``images-*`` releases that may be promoted to "Latest" on GitHub.
    Returns ``None`` on network failure or when no matching release/asset is found.
    """
    releases = list_releases(spec.owner, spec.repo, timeout=timeout)
    if releases is None:
        return None
    latest = latest_release_by_prefix(releases, _TAG_PREFIX)
    if latest is None:
        _logger.debug("No release with prefix %s in %s/%s", _TAG_PREFIX, spec.owner, spec.repo)
        return None
    tag = latest["tag_name"]
    url = asset_url(latest, spec.asset_name)
    if url is None:
        _logger.debug("Asset %s not found in release %s", spec.asset_name, tag)
        return None
    return tag, url
