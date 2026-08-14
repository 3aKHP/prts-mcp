"""HTTP transport for GitHub Release sync: mirrors, headers, cascading fetch.

Extracted from ``data/sync`` (P2.A). This is the repo's only HTTP-issuing
tier; the sync state machines (release, pair, images) consume it. The
streaming variant (:func:`stream_cascading`) was lifted out of
``data/images_sync`` in P3.B so the codebase's only streaming download
lives with the rest of the transport.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from uuid import uuid4

import httpx

_GITHUB_UA = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)"


def github_headers() -> dict[str, str]:
    headers: dict[str, str] = {"User-Agent": _GITHUB_UA}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _parse_mirrors() -> list[str]:
    """Parse GITHUB_MIRRORS env var into a list of proxy base URLs.

    Surrounding whitespace is trimmed and all trailing slashes are stripped;
    entries left empty after normalization are dropped. Both implementations
    normalize identically (parity).

    Unset / empty → [] (direct only, no cascade)
    "https://ghproxy.net" → ["https://ghproxy.net"]
    "https://a.example,https://b.example" → ["https://a.example", "https://b.example"]
    " https://a.example/ , https://b.example// " → ["https://a.example", "https://b.example"]
    "https://a,///,https://b" → ["https://a", "https://b"] (slash-only entry dropped)

    Mirror URL format (ghproxy-style): <mirror>/<original_url>
    e.g. "https://ghproxy.net/https://raw.githubusercontent.com/..."
    """
    raw = os.environ.get("GITHUB_MIRRORS", "")
    return [m for m in (part.strip().rstrip("/") for part in raw.split(",")) if m]


def url_candidates(url: str) -> list[str]:
    """Return [url, mirror1/url, mirror2/url, ...]."""
    return [url] + [f"{m}/{url}" for m in _parse_mirrors()]


class _AssetNotFoundError(Exception):
    """Direct release URL returned 404 — asset confirmed absent.

    Distinguished from a mirror 404 (mirror lacks the asset; the release
    may still exist upstream) so manifest verification skips only on a
    confirmed upstream 404 and stays fail-closed otherwise (#100).
    """


def get_cascading(url: str, *, timeout: float, **kwargs: object) -> httpx.Response:
    """httpx.get() wrapper that cascades through URL candidates on failure.

    - HTTP 4xx from the direct URL propagates immediately (resource missing).
    - Network error or HTTP 5xx from any candidate → try the next one.
    """
    candidates = url_candidates(url)
    last_exc: BaseException = RuntimeError("All URL candidates failed")
    for i, candidate in enumerate(candidates):
        try:
            response = httpx.get(candidate, timeout=timeout, **kwargs)  # type: ignore[arg-type]
            if response.is_success:
                return response
            # Direct 404 → asset confirmed absent; record the typed error and
            # stop without trying mirrors. last_exc + break (not raise) so the
            # typed error survives to the caller even with GITHUB_MIRRORS (#100).
            if i == 0 and response.status_code == 404:
                last_exc = _AssetNotFoundError(f"HTTP 404: {candidate}")
                break
            last_exc = Exception(f"HTTP {response.status_code}")
            # Other direct 4xx → resource genuinely missing; mirrors cannot help.
            if i == 0 and 400 <= response.status_code < 500:
                break
        except httpx.HTTPStatusError:
            raise  # only reached for direct 4xx via raise_for_status(); propagate as-is
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
    raise last_exc


def stream_cascading(url: str, dest: Path, *, timeout: float = 1800.0) -> None:
    """Stream-download a large asset (e.g. a shard zip) to ``dest`` atomically.

    Cascades through mirrors on failure, mirroring :func:`get_cascading`
    but with chunked writes so multi-hundred-MB shards do not stay resident.
    ``timeout`` bounds each URL candidate with a fresh budget per mirror
    attempt. It plays a dual role: a progressing download is capped by a
    total-deadline check in the chunk loop, while a connect/read stall is
    bounded by the httpx per-operation timeout of the same value — so a
    mirror that stalls mid-read after a long period of progress can hold the
    attempt for up to ~2× ``timeout`` in total (the TS twin aborts hard at
    its ``AbortSignal.timeout`` deadline instead). The 30-min default covers
    the largest ORIGINAL_IMAGE shard (~3.6 GB) on slow links.
    Raises on total failure; the caller decides whether to fall back.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{uuid4().hex}.tmp")
    last_exc: BaseException = RuntimeError(f"All URL candidates failed for {url}")
    try:
        for i, candidate in enumerate(url_candidates(url)):
            deadline = time.monotonic() + timeout
            try:
                with httpx.stream(
                    "GET",
                    candidate,
                    timeout=timeout,
                    headers=github_headers(),
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
                            if time.monotonic() >= deadline:
                                raise TimeoutError(
                                    f"Download exceeded {timeout:.0f}s total "
                                    f"deadline: {candidate}"
                                )
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
