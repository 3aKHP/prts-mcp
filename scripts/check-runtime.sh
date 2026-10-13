#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
case "${1:-}" in
  ""|--full) ;;
  *) echo 'Usage: scripts/check-runtime.sh [--full]' >&2; exit 2 ;;
esac
command -v cargo >/dev/null
command -v rustc >/dev/null
command -v cc >/dev/null
cargo --version
rustc --version
cc --version | head -n 1
cargo metadata --locked --no-deps --format-version 1 >/dev/null
if [[ "${1:-}" == --full ]]; then
  command -v node >/dev/null
  command -v npm >/dev/null
  command -v bun >/dev/null
  node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
  node tools/prepare-validation.mjs
  cargo fmt --all -- --check
  cargo clippy --locked --all-targets -- -D warnings
  cargo test --locked
  cargo build --locked --release --bins
  node tools/verify.mjs --all
  node tools/verify-p8-lifecycle.mjs --images-volume .runtime/fixtures/ts-images-v1
  node tools/check-native-regexp.mjs
fi
