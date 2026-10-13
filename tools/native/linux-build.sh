#!/usr/bin/env bash
set -euo pipefail
out="artifacts/native/${PRTS_NATIVE_ID}"
mkdir -p "$out" "$CARGO_HOME" "$RUSTUP_HOME"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/prts-rustup.sh
bash /tmp/prts-rustup.sh -y --no-modify-path --profile minimal --default-toolchain 1.96.1
export PATH="$CARGO_HOME/bin:$PATH"
rustup toolchain install 1.89.0 --profile minimal
cargo +1.89.0 check --locked --bins --target "$PRTS_NATIVE_TARGET"
cargo test --locked --target "$PRTS_NATIVE_TARGET" --lib --test native_text_corpus --test regex_corpus --test story_index
cargo build --locked --release --bins --target "$PRTS_NATIVE_TARGET"
cargo metadata --locked --format-version 1 --filter-platform "$PRTS_NATIVE_TARGET" > "$out/cargo-metadata.json"
rustc --print sysroot > "$out/rust-sysroot.txt"
rustc -vV > "$out/compiler.txt"
gcc --version >> "$out/compiler.txt"
ldd --version >> "$out/compiler.txt"
# The packer runs on the host, where this container's sysroot is not mounted at
# /work. Copy the standard-library notices before leaving the build container.
cp -R "$(rustc --print sysroot)/share/doc/rust" "$out/rust-notices"
