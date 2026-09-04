"""GitHub Release discovery: tag-prefix-filtered list / latest / asset_url.

Extracted from ``data/sync`` (P2.A). The arknights-data-pipeline repo hosts
both ``data-*`` and ``images-*`` GitHub Releases; ``/releases/latest`` may
point at an ``images-*`` release if GitHub auto-promotes it, so data sync
filters by tag prefix instead. ``data/sync`` re-exports these and
``ReleaseSpec`` during the P2.A→P2.B migration.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from prts_mcp.sync.transport import get_cascading, github_headers

_logger = logging.getLogger(__name__)

_TAG_PREFIX = "data-"
_DATAREV_TAG_PREFIX = "datarev-"

#: a data versionId is fixed-width "YY-MM-DD-HH-MM-SS_hash", so lexicographic
#: order is chronological order and (versionId, revision) tuples order
#: without any date parsing
_VID_RE = re.compile(r"^\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}_[0-9a-f]+$")
_DATAREV_TAG_RE = re.compile(r"^datarev-(?P<vid>.+)-r(?P<rev>\d+)$")
_DATAREV_SUFFIX_RE = re.compile(
    r"^(?P<vid>\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}_[0-9a-f]+)-r(?P<rev>\d+)$"
)


def parse_data_tag(tag: str) -> tuple[str, int] | None:
    """Parse a data release tag into ``(versionId, publicationRevision)``.

    ``data-<versionId>`` is a normal release (revision 1);
    ``datarev-<versionId>-r<N>`` is an immutable repair revision published
    by the factory's manual SOP. Anything else (``images-*``, unknown tags)
    is not a data release. Mirrors ``akdp.check.parse_release_tag``.
    """
    match = _DATAREV_TAG_RE.match(tag)
    if match:
        return match.group("vid"), int(match.group("rev"))
    if tag.startswith(_TAG_PREFIX):
        return tag[len(_TAG_PREFIX):], 1
    return None


def tag_suffix(tag: str) -> str:
    """Strip the data/datarev namespace prefix from a release tag.

    ``data-<vid>`` → ``<vid>``; ``datarev-<vid>-r<N>`` → ``<vid>-r<N>``.
    The result is the canonical ``commit_sha`` value persisted in
    release_meta/extract_meta/.gamedata_pair and shown in logs.
    """
    if tag.startswith(_DATAREV_TAG_PREFIX):
        return tag[len(_DATAREV_TAG_PREFIX):]
    if tag.startswith(_TAG_PREFIX):
        return tag[len(_TAG_PREFIX):]
    return tag


def parse_release_suffix(suffix: str) -> tuple[str, int] | None:
    """Parse a stored ``commit_sha`` (tag suffix) into ``(versionId, revision)``.

    ``<vid>-r<N>`` (written for datarev releases) → ``(vid, N)``; a bare
    versionId → ``(vid, 1)``. Sentinel values (``unknown``, ``legacy``,
    ``local-<digest>``) and any future format return ``None`` so callers
    fall back to plain string comparison.
    """
    match = _DATAREV_SUFFIX_RE.match(suffix)
    if match:
        return match.group("vid"), int(match.group("rev"))
    if _VID_RE.match(suffix):
        return suffix, 1
    return None


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


def list_releases_paginated(
    owner: str,
    repo: str,
    *,
    stop: Callable[[dict], bool],
    max_pages: int = 20,
    timeout: float = 10.0,
) -> list[dict] | None:
    """List releases page by page until *stop* matches or history runs out.

    GitHub caps ``per_page`` at 100, so a caller that must see releases
    older than the newest 100 (e.g. images delta-chain enumeration back to
    the baseline release, #179) paginates until *stop* returns True for a
    release in the current page or a short page ends the list. Returns None
    on any network/API failure or when *max_pages* passes without *stop*
    matching — fail closed, because the caller cannot prove its history
    window is complete.
    """
    releases: list[dict] = []
    for page in range(1, max_pages + 1):
        url = (
            f"https://api.github.com/repos/{owner}/{repo}/releases"
            f"?per_page=100&page={page}"
        )
        try:
            response = get_cascading(url, timeout=timeout, headers=github_headers())
            data = response.json()
        except Exception:  # noqa: BLE001
            return None
        if not isinstance(data, list):
            return None
        releases.extend(data)
        if any(stop(r) for r in data if isinstance(r, dict)):
            return releases
        if len(data) < 100:
            return releases
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


def latest_data_release(releases: list[dict]) -> dict | None:
    """Pick the newest data release across the ``data-``/``datarev-`` namespaces.

    Orders by ``(versionId, publicationRevision)`` tuple instead of
    ``created_at``, so a repair revision outranks the release it fixes and a
    re-published older release can no longer win (rollback-by-republication).
    Two releases claiming the same tuple is an upstream integrity violation:
    log loudly and fail closed (returns None), mirroring the images pipeline's
    duplicate-version rejection.
    """
    best: tuple[tuple[str, int], dict] | None = None
    seen: set[tuple[str, int]] = set()
    for release in releases:
        tag = release.get("tag_name")
        if not isinstance(tag, str):
            continue
        parsed = parse_data_tag(tag)
        if parsed is None:
            continue
        if parsed in seen:
            _logger.warning(
                "duplicate data release identity (versionId=%s, revision=%d) "
                "claimed by %r; failing closed", parsed[0], parsed[1], tag,
            )
            return None
        seen.add(parsed)
        if best is None or parsed > best[0]:
            best = (parsed, release)
    return best[1] if best is not None else None


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
    """Return ``(tag_name, asset_download_url)`` for the latest data release.

    Uses the releases list API with tag-prefix filtering instead of
    ``/releases/latest``, because the data-pipeline repo also hosts
    ``images-*`` releases that may be promoted to "Latest" on GitHub, and a
    ``datarev-`` repair revision must outrank the ``data-`` release it fixes
    even though it is never marked latest. Returns ``None`` on network
    failure or when no matching release/asset is found.
    """
    releases = list_releases(spec.owner, spec.repo, timeout=timeout)
    if releases is None:
        return None
    latest = latest_data_release(releases)
    if latest is None:
        _logger.debug("No data release found in %s/%s", spec.owner, spec.repo)
        return None
    tag = latest["tag_name"]
    url = asset_url(latest, spec.asset_name)
    if url is None:
        _logger.debug("Asset %s not found in release %s", spec.asset_name, tag)
        return None
    return tag, url
