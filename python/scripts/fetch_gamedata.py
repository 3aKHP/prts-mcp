"""Fetch the latest game data archive from GitHub Releases into data/gamedata/.

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
_PYTHON_DIR = Path(__file__).resolve().parents[1]   # python/
_REPO_ROOT = _PYTHON_DIR.parent                     # repo root
_SRC_DIR = _PYTHON_DIR / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from prts_mcp.data.datasets import GAMEDATA_EXCEL  # noqa: E402
from prts_mcp.data.sync import SyncResult, sync_release_archive  # noqa: E402

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
)
_logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch the latest ArknightsGameData excel archive from GitHub Releases."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore the cached commit SHA and re-download all files unconditionally.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_REPO_ROOT / "data" / "gamedata",
        help="Local root directory for cached game data. Default: data/gamedata",
    )
    parser.add_argument(
        "--archive-cache",
        type=Path,
        default=None,
        help="Local path for the downloaded release zip. Default: <output>/archives/zh_CN-excel.zip",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    spec = GAMEDATA_EXCEL.archive_spec(
        local_zip=(args.archive_cache or args.output / "archives" / "zh_CN-excel.zip").resolve(),
        local_root=args.output.resolve(),
    )

    if args.force:
        # Wipe release metadata so sync_release_archive always downloads
        cache_path = spec.local_zip.parent / "release_meta.json"
        if cache_path.exists():
            cache_path.unlink()
            _logger.info("--force: removed release_meta.json to trigger full re-download.")

    _logger.info("Syncing %s/%s:%s → %s", spec.owner, spec.repo, spec.asset_name, spec.local_root)
    result: SyncResult = sync_release_archive(spec)

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
