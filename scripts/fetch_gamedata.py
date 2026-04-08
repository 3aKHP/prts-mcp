"""Fetch the latest operator data files from GitHub into data/gamedata/.

Used by CI during Docker image build to bake fresh data into the image.
Can also be run manually during local development.

Usage:
    python scripts/fetch_gamedata.py [--force]

Options:
    --force   Ignore the commit SHA cache and always re-download all files.

Exit codes:
    0   Data fetched successfully, already up to date, or network failed with valid cached data.
    1   Download failed and no usable data is available.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

# Make the src/ package importable when running this script directly.
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_SRC_DIR = _PROJECT_ROOT / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from prts_mcp.data.sync import (  # noqa: E402
    GAMEDATA_FILES,
    RepoSpec,
    SyncResult,
    sync_repo,
)

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
)
_logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch the latest ArknightsGameData operator files from GitHub."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore the cached commit SHA and re-download all files unconditionally.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_PROJECT_ROOT / "data" / "gamedata",
        help="Local root directory for cached game data. Default: data/gamedata",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    spec = RepoSpec(
        owner="Kengxxiao",
        repo="ArknightsGameData",
        branch="master",
        files=GAMEDATA_FILES,
        local_root=args.output.resolve(),
    )

    if args.force:
        # Wipe cache metadata so sync_repo always downloads
        cache_path = spec.local_root / "cache_meta.json"
        if cache_path.exists():
            cache_path.unlink()
            _logger.info("--force: removed cache_meta.json to trigger full re-download.")

    _logger.info("Syncing %s/%s → %s", spec.owner, spec.repo, spec.local_root)
    result: SyncResult = sync_repo(spec)

    sha_short = result.commit_sha[:8] if result.commit_sha else "unknown"

    if result.status == "updated":
        _logger.info("Done. Data updated to %s @ %s.", spec.repo, sha_short)
        return 0
    elif result.status == "up_to_date":
        _logger.info("Data is already up to date (%s @ %s).", spec.repo, sha_short)
        return 0
    elif result.status == "offline_fallback":
        _logger.warning(
            "Network error; using existing cached data (%s @ %s). Error: %s",
            spec.repo,
            sha_short,
            result.error,
        )
        return 0
    else:  # no_data
        _logger.error(
            "Failed to obtain data for %s. No usable files available. Error: %s",
            spec.repo,
            result.error,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
