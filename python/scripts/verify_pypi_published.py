#!/usr/bin/env python3
"""Verify PyPI-published artifacts match the local release build (declared-hash).

Polls the PyPI JSON API until the version document is visible, then compares
each local wheel/sdist sha256 against the digest PyPI recorded at upload
(`urls[].digests.sha256`). It does NOT download the files — the JSON digest is
authoritative for "what PyPI indexed". Lives in cd.yml's github-release job so
a propagation timeout fails only that job (recover with
`gh run rerun <run-id> --failed`). Mirrors the TypeScript verify
(ts/scripts/verify-npm-published.sh) at lower cost, since PyPI exposes the
digest directly and the artifacts are small.

Usage: verify_pypi_published.py [<dist-dir>]
Env: VERSION          required if GITHUB_REF_NAME is unset; e.g. 2.7.0 / 2.7.0a1
     PYPI_NAME        default prts-mcp
     PYPI_BASE        default https://pypi.org
     VERIFY_ATTEMPTS  default 40   (x VERIFY_SLEEP ~= 10 min polling budget)
     VERIFY_SLEEP     default 15
Exit 0: every local file matches its PyPI-declared digest.
Exit 1: not yet indexed (propagation), or a retrievable mismatch.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request


def err(msg: str) -> None:
    print(f"::error::{msg}")


def normalize_version(v: str) -> str:
    # PEP 440 pre-release normalization for the PyPI JSON URL: a git tag spells
    # `2.7.0-alpha.1` but PyPI stores/indexes `2.7.0a1`. Mirrors the version
    # check in cd.yml's `verify` job.
    return re.sub(
        r"-(alpha|beta|rc|a|b)\.?",
        lambda m: {"alpha": "a", "beta": "b"}.get(m.group(1), m.group(1)),
        v,
    )


def local_digests(dist: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for fn in sorted(os.listdir(dist)):
        if fn.endswith(".whl") or fn.endswith(".tar.gz"):
            with open(os.path.join(dist, fn), "rb") as fh:
                out[fn] = hashlib.sha256(fh.read()).hexdigest()
    return out


def main() -> int:
    dist = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DIST", "python/dist")
    name = os.environ.get("PYPI_NAME", "prts-mcp")
    base = os.environ.get("PYPI_BASE", "https://pypi.org").rstrip("/")
    attempts = int(os.environ.get("VERIFY_ATTEMPTS", "40"))
    sleep = int(os.environ.get("VERIFY_SLEEP", "15"))

    version = os.environ.get("VERSION", "").strip()
    if not version:
        ref = os.environ.get("GITHUB_REF_NAME", "")
        if ref.startswith("python/v"):
            version = ref[len("python/v"):]
    if not version:
        err("VERSION could not be determined (set VERSION or run under a python/v* tag)")
        return 1

    if not os.path.isdir(dist):
        err(f"distribution directory not found: {dist}")
        return 1
    local = local_digests(dist)
    if not local:
        err(f"no wheel/sdist found in {dist}")
        return 1

    pypi_version = normalize_version(version)
    url = f"{base}/pypi/{name}/{pypi_version}/json"
    last = "000"
    for attempt in range(1, attempts + 1):
        # Cache-bust so a stale CDN copy cannot hide a version that just landed.
        cachebusted = f"{url}?ts={int(time.time())}"
        try:
            with urllib.request.urlopen(cachebusted, timeout=30) as resp:
                doc = json.load(resp)
            last = str(getattr(resp, "status", 200))
        except urllib.error.HTTPError as e:
            last = str(e.code)
            print(f"Waiting for PyPI JSON (attempt {attempt}/{attempts}, last HTTP {last})...")
            time.sleep(sleep)
            continue
        except Exception as e:  # transient network / parse error
            last = "err"
            print(f"Waiting for PyPI JSON (attempt {attempt}/{attempts}, {e})...")
            time.sleep(sleep)
            continue

        remote = {u["filename"]: u["digests"]["sha256"] for u in doc.get("urls", [])}
        missing = [f for f in local if f not in remote]
        extra = [f for f in remote if f not in local]
        mismatches = [(f, local[f], remote[f]) for f in local if f in remote and local[f] != remote[f]]
        if not missing and not extra and not mismatches:
            print(f"PyPI digests verified for {len(local)} file(s) ({name} {version}).")
            return 0

        # PyPI files are immutable post-publish: any difference is permanent,
        # so fail fast rather than retry.
        if missing:
            err(f"{name} {version}: local artifact(s) not present in PyPI JSON: {missing}")
        if extra:
            err(f"{name} {version}: PyPI JSON lists file(s) absent from local dist: {extra}")
        for fn, got, want in mismatches:
            err(f"{name} {version}: sha256 mismatch for {fn}")
            err(f"  local (built):        {got}")
            err(f"  PyPI digests.sha256:  {want}")
        if mismatches:
            err("Recovery: the published files are the verified content; re-run the ORIGINAL run that published this version with `gh run rerun <run-id> --failed`, or rebuild the GitHub Release from the PyPI assets. A mismatch usually means the local dist drifted on a full rerun.")
        return 1

    err(f"{name} {version}: PyPI JSON not visible after {attempts} attempts (~{attempts*sleep//60} min); last HTTP {last}.")
    err("This is a registry propagation delay, not a byte mismatch.")
    err("Recovery: wait for indexing, then re-run this github-release job (gh run rerun <run-id> --failed).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
