"""HTTP transport for GitHub Release sync: mirrors, headers, cascading fetch.

Extracted from ``data/sync`` (P2.A). This is the repo's only HTTP-issuing
tier; the release/archive/pair state machine still in ``data/sync`` consumes
it. ``data/sync`` re-exports these symbols during the P2.A→P2.B migration.
"""
from __future__ import annotations

import os

import httpx

_GITHUB_UA = "PRTS-MCP-Bot/0.1 (Arknights fan-creation helper)"


def _github_headers() -> dict[str, str]:
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


def _url_candidates(url: str) -> list[str]:
    """Return [url, mirror1/url, mirror2/url, ...]."""
    return [url] + [f"{m}/{url}" for m in _parse_mirrors()]


class _AssetNotFoundError(Exception):
    """Direct release URL returned 404 — asset confirmed absent.

    Distinguished from a mirror 404 (mirror lacks the asset; the release
    may still exist upstream) so manifest verification skips only on a
    confirmed upstream 404 and stays fail-closed otherwise (#100).
    """


def _get_cascading(url: str, *, timeout: float, **kwargs: object) -> httpx.Response:
    """httpx.get() wrapper that cascades through URL candidates on failure.

    - HTTP 4xx from the direct URL propagates immediately (resource missing).
    - Network error or HTTP 5xx from any candidate → try the next one.
    """
    candidates = _url_candidates(url)
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
