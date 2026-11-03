"""Prepare immutable wheels for OIDC upload, then verify registry visibility."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request

from common import ROOT, TAGS, git, inspect_wheel, python_version, read, sha, write


def missing_files(receipts, remote):
    """Reject conflicts across the entire version before any upload starts."""
    expected = {r["filename"]: r for r in receipts}
    if remote is None:
        return sorted(expected)
    info = remote["info"]
    if info["version"] != receipts[0]["version"] or info["requires_python"] != ">=3.11" or info.get("requires_dist"):
        raise ValueError("Published project metadata differs")
    present = set()
    for item in remote["urls"]:
        name = item["filename"]
        if name not in expected or name in present or item.get("yanked") or item["digests"]["sha256"] != expected[name]["sha256"]:
            raise ValueError("Published filename, yanked state or checksum differs")
        present.add(name)
    return sorted(set(expected) - present)


def fetch_version(version):
    url = f"https://pypi.org/pypi/prts-mcp/{version}/json"
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "prts-mcp-release"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def candidate():
    if os.environ.get("RUST_PYPI_PUBLISH_ENABLED") != "true":
        raise ValueError("PyPI publication is disabled")
    if os.environ.get("GITHUB_EVENT_NAME") != "push" or os.environ.get("GITHUB_REF_TYPE") != "tag":
        raise ValueError("PyPI publication requires a tag push event")
    if git("status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("Publication requires clean source")
    subprocess.run(["node", "tools/release/check-version.mjs", "--release"], cwd=ROOT, check=True)
    # Reuse the same complete-snapshot and repository/tag policy as other native publishers.
    subprocess.run(["node", "--input-type=module", "-e",
                    "import {verifiedSnapshot} from './tools/release/verify-snapshot.mjs'; verifiedSnapshot();"], cwd=ROOT, check=True)
    directory = ROOT / "artifacts/release"
    manifest = read(directory / "RELEASE.json")
    receipts = []
    for platform in TAGS:
        receipt = read(directory / f"{platform}-pypi-package.json")
        if receipt["platform"] != platform or receipt["commit"] != manifest["commit"] or receipt["productVersion"] != manifest["version"]:
            raise ValueError("Candidate wheel provenance differs")
        inspect_wheel(directory / receipt["filename"], receipt)
        evidence = read(directory / f"{platform}-pypi-evidence.json")
        if any(evidence.get(key) != value for key, value in receipt.items()) or not evidence.get("native"):
            raise ValueError("Candidate installation evidence differs")
        receipts.append(receipt)
    return directory, manifest, receipts


def prepare(directory, receipts, remote, output):
    missing = missing_files(receipts, remote)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    for name in missing:
        shutil.copy2(directory / name, output / name)
    return missing


def verify(receipts, fetch=fetch_version, timeout=300, sleep=time.sleep):
    deadline = time.monotonic() + timeout
    while True:
        try:
            remote = fetch(receipts[0]["version"])
        except (urllib.error.URLError, TimeoutError):
            remote = None
        if not missing_files(receipts, remote):
            return
        if time.monotonic() >= deadline:
            raise TimeoutError("PyPI visibility timed out; retry using the original candidate snapshot")
        sleep(2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "verify"])
    args = parser.parse_args()
    directory, manifest, receipts = candidate()
    if args.operation == "prepare":
        missing = prepare(directory, receipts, fetch_version(receipts[0]["version"]), ROOT / "artifacts/pypi-upload")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                stream.write(f"count={len(missing)}\n")
        print(f"PYPI_UPLOAD_PREPARED: {len(missing)} missing wheels")
    else:
        verify(receipts)
        write(ROOT / "artifacts/pypi-publication.json", {"schema": "prts-mcp-pypi-publication/v1",
              "version": manifest["version"], "commit": manifest["commit"], "files": receipts})
        print("PYPI_PUBLICATION_PASS")
