#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SHARED_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/prts-shared-sync.XXXXXX")"

cleanup() {
  rm -rf -- "${SHARED_ROOT}"
}
trap cleanup EXIT

EXCEL_REQUIRED="zh_CN/gamedata/excel/character_table.json"
LEVELS_REQUIRED="zh_CN/gamedata/levels/enemydata/enemy_database.json"
EXCEL_ROOT="${SHARED_ROOT}/gamedata"
LEVELS_ROOT="${SHARED_ROOT}/gamedata-levels"
EXCEL_ARCHIVE="${EXCEL_ROOT}/archives/zh_CN-excel.zip"
LEVELS_ARCHIVE="${LEVELS_ROOT}/archives/zh_CN-levels.zip"

uv run --directory "${REPO_ROOT}/python" --frozen --no-sync python - \
  "${EXCEL_ARCHIVE}" "${LEVELS_ARCHIVE}" \
  "${EXCEL_REQUIRED}" "${LEVELS_REQUIRED}" <<'PY'
import json
import sys
import zipfile
from pathlib import Path

for archive_arg, required_file in ((sys.argv[1], sys.argv[3]), (sys.argv[2], sys.argv[4])):
    archive = Path(archive_arg)
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(required_file, '{"generation":"shared"}')
    (archive.parent / "release_meta.json").write_text(
        json.dumps(
            {
                "repo": "3aKHP/arknights-data-pipeline",
                "branch": "releases",
                "commit_sha": "shared-volume-test",
                "fetched_at": "2099-01-01T00:00:00Z",
                "files": [archive.name],
            }
        ),
        encoding="utf-8",
    )
PY

uv run --directory "${REPO_ROOT}/python" --frozen --no-sync python - \
  "${EXCEL_ROOT}" "${LEVELS_ROOT}" "${EXCEL_ARCHIVE}" "${LEVELS_ARCHIVE}" \
  "${EXCEL_REQUIRED}" "${LEVELS_REQUIRED}" \
  >"${SHARED_ROOT}/python.status" <<'PY' &
import sys
from pathlib import Path

from prts_mcp.data.sync import ReleaseArchiveSpec, sync_release_archive_pair

excel = ReleaseArchiveSpec(
    owner="3aKHP",
    repo="arknights-data-pipeline",
    asset_name=Path(sys.argv[3]).name,
    local_zip=Path(sys.argv[3]),
    local_root=Path(sys.argv[1]),
    required_files=(sys.argv[5],),
)
levels = ReleaseArchiveSpec(
    owner="3aKHP",
    repo="arknights-data-pipeline",
    asset_name=Path(sys.argv[4]).name,
    local_zip=Path(sys.argv[4]),
    local_root=Path(sys.argv[2]),
    required_files=(sys.argv[6],),
)
results = sync_release_archive_pair(excel, levels)
print(",".join(result.status for result in results))
for result in results:
    if result.error is not None:
        raise RuntimeError(result.error)
PY
PYTHON_PID=$!

(cd "${REPO_ROOT}/ts" && node --import tsx \
  --input-type=module - \
  "${EXCEL_ROOT}" "${LEVELS_ROOT}" "${EXCEL_ARCHIVE}" "${LEVELS_ARCHIVE}" \
  "${EXCEL_REQUIRED}" "${LEVELS_REQUIRED}") \
  >"${SHARED_ROOT}/typescript.status" <<'TS' &
import { basename } from "node:path";
import { syncReleaseArchivePair } from "./src/data/sync.ts";

const [, , excelRoot, levelsRoot, excelArchive, levelsArchive, excelRequired, levelsRequired] = process.argv;
const results = await syncReleaseArchivePair(
  {
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName: basename(excelArchive),
    localZip: excelArchive,
    localRoot: excelRoot,
    requiredFiles: [excelRequired],
  },
  {
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName: basename(levelsArchive),
    localZip: levelsArchive,
    localRoot: levelsRoot,
    requiredFiles: [levelsRequired],
  },
);
console.log(results.map((result) => result.status).join(","));
for (const result of results) {
  if (result.error !== null) throw new Error(result.error);
}
TS
TYPESCRIPT_PID=$!

PYTHON_EXIT=0
TYPESCRIPT_EXIT=0
wait "${PYTHON_PID}" || PYTHON_EXIT=$?
wait "${TYPESCRIPT_PID}" || TYPESCRIPT_EXIT=$?
if ((PYTHON_EXIT != 0 || TYPESCRIPT_EXIT != 0)); then
  echo "Sync process failed: Python=${PYTHON_EXIT}, TypeScript=${TYPESCRIPT_EXIT}" >&2
  exit 1
fi

PYTHON_STATUS="$(<"${SHARED_ROOT}/python.status")"
TYPESCRIPT_STATUS="$(<"${SHARED_ROOT}/typescript.status")"
if [[ ! (
  "${PYTHON_STATUS}" == "updated,updated" && "${TYPESCRIPT_STATUS}" == "up_to_date,up_to_date"
) && ! (
  "${PYTHON_STATUS}" == "up_to_date,up_to_date" && "${TYPESCRIPT_STATUS}" == "updated,updated"
) ]]; then
  echo "Unexpected sync statuses: Python=${PYTHON_STATUS}, TypeScript=${TYPESCRIPT_STATUS}" >&2
  exit 1
fi

PAIR_PATH="${SHARED_ROOT}/.gamedata_pair.json"
PAIR_IDENTITY_BEFORE="$(stat -c '%i:%s:%Y:%Z' "${PAIR_PATH}")"

uv run --directory "${REPO_ROOT}/python" --frozen --no-sync python - \
  "${EXCEL_ROOT}" "${LEVELS_ROOT}" "${EXCEL_ARCHIVE}" "${LEVELS_ARCHIVE}" \
  "${EXCEL_REQUIRED}" "${LEVELS_REQUIRED}" <<'PY'
import sys
from pathlib import Path

from prts_mcp.data.sync import ReleaseArchiveSpec, sync_release_archive_pair

results = sync_release_archive_pair(
    ReleaseArchiveSpec(
        owner="3aKHP",
        repo="arknights-data-pipeline",
        asset_name=Path(sys.argv[3]).name,
        local_zip=Path(sys.argv[3]),
        local_root=Path(sys.argv[1]),
        required_files=(sys.argv[5],),
    ),
    ReleaseArchiveSpec(
        owner="3aKHP",
        repo="arknights-data-pipeline",
        asset_name=Path(sys.argv[4]).name,
        local_zip=Path(sys.argv[4]),
        local_root=Path(sys.argv[2]),
        required_files=(sys.argv[6],),
    ),
)
assert [result.status for result in results] == ["up_to_date", "up_to_date"]
PY

PAIR_IDENTITY_AFTER_PYTHON="$(stat -c '%i:%s:%Y:%Z' "${PAIR_PATH}")"
if [[ "${PAIR_IDENTITY_AFTER_PYTHON}" != "${PAIR_IDENTITY_BEFORE}" ]]; then
  echo "Python rewrote unchanged TypeScript-compatible pair metadata" >&2
  exit 1
fi

(cd "${REPO_ROOT}/ts" && node --import tsx \
  --input-type=module - \
  "${EXCEL_ROOT}" "${LEVELS_ROOT}" "${EXCEL_ARCHIVE}" "${LEVELS_ARCHIVE}" \
  "${EXCEL_REQUIRED}" "${LEVELS_REQUIRED}") <<'TS'
import { basename } from "node:path";
import { syncReleaseArchivePair } from "./src/data/sync.ts";

const [, , excelRoot, levelsRoot, excelArchive, levelsArchive, excelRequired, levelsRequired] = process.argv;
const results = await syncReleaseArchivePair(
  {
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName: basename(excelArchive),
    localZip: excelArchive,
    localRoot: excelRoot,
    requiredFiles: [excelRequired],
  },
  {
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName: basename(levelsArchive),
    localZip: levelsArchive,
    localRoot: levelsRoot,
    requiredFiles: [levelsRequired],
  },
);
if (results.some((result) => result.status !== "up_to_date")) {
  throw new Error(`Unexpected unchanged sync status: ${results.map((result) => result.status).join(",")}`);
}
TS

PAIR_IDENTITY_AFTER_TYPESCRIPT="$(stat -c '%i:%s:%Y:%Z' "${PAIR_PATH}")"
if [[ "${PAIR_IDENTITY_AFTER_TYPESCRIPT}" != "${PAIR_IDENTITY_BEFORE}" ]]; then
  echo "TypeScript rewrote unchanged Python-compatible pair metadata" >&2
  exit 1
fi

uv run --directory "${REPO_ROOT}/python" --frozen --no-sync python - \
  "${SHARED_ROOT}" "${EXCEL_ROOT}" "${LEVELS_ROOT}" \
  "${EXCEL_REQUIRED}" "${LEVELS_REQUIRED}" <<'PY'
import json
import sys
from pathlib import Path

shared = Path(sys.argv[1]).resolve()
excel_root = Path(sys.argv[2]).resolve()
levels_root = Path(sys.argv[3]).resolve()
pair = json.loads((shared / ".gamedata_pair.json").read_text(encoding="utf-8"))
active_excel = (excel_root / pair["excel_data_root"]).resolve()
active_levels = (levels_root / pair["levels_data_root"]).resolve()
active_excel.relative_to(excel_root)
active_levels.relative_to(levels_root)
assert pair["commit_sha"] == "shared-volume-test"
assert (active_excel / sys.argv[4]).is_file()
assert (active_levels / sys.argv[5]).is_file()
assert not (shared / ".gamedata-pair.lock").exists()
for root in (excel_root, levels_root):
    assert not (root / "archives" / ".activation.lock").exists()
    assert not (root / "archives" / ".release.lock").exists()
print("Cross-runtime shared-volume pair sync passed.")
PY
