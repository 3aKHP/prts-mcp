#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PYTHON_DIR="${REPO_ROOT}/python"
TS_DIR="${REPO_ROOT}/ts"

FULL=false
FAILURES=0

usage() {
  cat <<'EOF'
Usage: ./scripts/check-runtime.sh [--full]

Checks the WSL/Linux/macOS Bash toolchain without changing lockfiles or
installing dependencies. Run `uv sync --directory python --locked` and
`npm ci --prefix ts` first when bootstrapping a new checkout.
EOF
}

if (($# > 1)); then
  usage >&2
  exit 2
fi

case "${1:-}" in
  "") ;;
  --full) FULL=true ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

run_required() {
  local name="$1"
  shift

  printf '\n== %s ==\n' "${name}"
  if "$@"; then
    printf '[OK] %s\n' "${name}"
  else
    FAILURES=$((FAILURES + 1))
    printf '[FAIL] %s\n' "${name}" >&2
  fi
}

check_shell() {
  printf 'bash=%s\n' "${BASH_VERSION}"
  printf 'kernel=%s\n' "$(uname -sr)"
}

check_uv() {
  if ! command -v uv >/dev/null 2>&1; then
    echo "uv is missing. Install it from https://docs.astral.sh/uv/." >&2
    return 1
  fi
  uv --version
}

check_python_environment() {
  if [[ ! -f "${PYTHON_DIR}/uv.lock" ]]; then
    echo "Missing python/uv.lock." >&2
    return 1
  fi

  (
    cd "${PYTHON_DIR}" || exit 1
    if ! uv lock --check; then
      echo "python/uv.lock is stale. Refresh it intentionally with uv lock." >&2
      exit 1
    fi
    if ! uv sync --check; then
      echo "Python environment is not synchronized. Run: uv sync --directory python --locked" >&2
      exit 1
    fi
    uv run --frozen --no-sync python - <<'PY'
import importlib.metadata as md
import sys

import mcp
import pydantic
import pytest
from prts_mcp.server import main

print(sys.executable)
print(sys.version.split()[0])
print("mcp=" + md.version("mcp"))
print("pydantic=" + md.version("pydantic"))
print("pytest=" + md.version("pytest"))
print("prts_mcp.server import ok")
PY
  )
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is missing." >&2
    return 1
  fi
  node --version
  node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { throw new Error("Node >=22 is required"); }'
}

check_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is missing." >&2
    return 1
  fi
  npm --version
}

check_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun is missing." >&2
    return 1
  fi

  local version
  version="$(bun --version)" || return 1
  printf 'bun=%s\n' "${version}"
  node - "${version}" <<'JS'
const actual = process.argv[2].split(".").map(Number);
const minimum = [1, 3, 14];
for (let i = 0; i < minimum.length; i += 1) {
  if ((actual[i] ?? 0) > minimum[i]) process.exit(0);
  if ((actual[i] ?? 0) < minimum[i]) {
    throw new Error("Bun >=1.3.14 is required");
  }
}
JS
}

check_ts_dependencies() {
  if [[ ! -f "${TS_DIR}/node_modules/typescript/bin/tsc" ]] ||
     [[ ! -f "${TS_DIR}/node_modules/tsx/dist/cli.mjs" ]]; then
    echo "TypeScript dependencies are missing. Run: npm ci --prefix ts" >&2
    return 1
  fi
  (cd "${TS_DIR}" && npm ls --depth=0)
}

run_python_tests() {
  cd "${PYTHON_DIR}" || return 1
  uv run --frozen --no-sync python -m pytest tests -q
}

run_ts_build() {
  cd "${TS_DIR}" || return 1
  npm run build
}

run_ts_tests() {
  cd "${TS_DIR}" || return 1
  npm test
}

run_ts_typecheck() {
  cd "${TS_DIR}" || return 1
  npm run typecheck
}

run_bun_smoke() {
  cd "${TS_DIR}" || return 1
  npm run smoke:bun
}

printf 'Repo root: %s\n' "${REPO_ROOT}"

run_required "Bash host" check_shell
run_required "uv runtime" check_uv
run_required "Python lock and environment" check_python_environment
run_required "Node runtime" check_node
run_required "npm runtime" check_npm
run_required "Bun runtime" check_bun
run_required "TypeScript dependencies" check_ts_dependencies

if [[ "${FULL}" == true ]]; then
  run_required "Python tests" run_python_tests
  run_required "TypeScript build" run_ts_build
  run_required "TypeScript tests" run_ts_tests
  run_required "TypeScript typecheck" run_ts_typecheck
  run_required "Bun HTTP smoke" run_bun_smoke
fi

printf '\nRuntime check complete: %d failure(s).\n' "${FAILURES}"
if ((FAILURES > 0)); then
  exit 1
fi
