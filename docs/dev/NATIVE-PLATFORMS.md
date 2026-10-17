# Native Platform Artifacts

This document describes the target platforms, ABI baselines, build scripts, archive layout, and verification probes for PRTS-MCP prebuilt native binaries.

- For client setup and server deployment instructions, see the [Client Quick Start Guide](../user/quick-start.md) and [Server Deployment Guide](../admin/deployment.md).
- For npm packaging of these binaries, see [NPM-DISTRIBUTION.md](NPM-DISTRIBUTION.md).
- For Docker image packaging, see [DOCKER-DISTRIBUTION.md](DOCKER-DISTRIBUTION.md).
- For candidate release aggregation and publishing, see [RELEASE-CANDIDATES.md](RELEASE-CANDIDATES.md).

---

## 1. Supported Platforms and ABI Baselines

Machine-readable target definitions live in [`packaging/native/targets.json`](../../packaging/native/targets.json). Development and release builds use the pinned Rust toolchain (`1.96.1` in `rust-toolchain.toml`), while CI also verifies compatibility against the declared MSRV (`1.89.0` in `Cargo.toml`).

Prebuilt executables statically link the vendored QuickJS regular-expression engine (`vendor/quickjs-regexp/`) and the OS process-memory helper (`native/process_memory.c`). End users do not need a Rust toolchain, C compiler, or language runtime.

| Platform ID | Rust Target & CPU Baseline | Build & ABI Baseline | Runtime Verification |
| --- | --- | --- | --- |
| `linux-x64` | `x86_64-unknown-linux-gnu` (`x86-64` / SSE2) | Pinned `manylinux_2_28` container (`glibc >= 2.28`) | Native Ubuntu CI, WSL2, and minimal AlmaLinux 8 container (`glibc 2.28`) |
| `linux-arm64` | `aarch64-unknown-linux-gnu` (ARMv8-A) | Pinned `manylinux_2_28` container (`glibc >= 2.28`) | Native `ubuntu-24.04-arm` CI and minimal AlmaLinux 8 ARM64 container |
| `windows-x64` | `x86_64-pc-windows-msvc` (`x86-64`) | Static CRT (`+crt-static`), Windows 10 / Server 2016 baseline | Native `windows-2022` CI and local Windows desktop stdio smoke |
| `darwin-arm64` | `aarch64-apple-darwin` (Apple M1 baseline) | `MACOSX_DEPLOYMENT_TARGET=14.0` | Native `macos-14` (Apple Silicon) CI |
| `darwin-x64` | `x86_64-apple-darwin` (`x86-64` / SSE2) | `MACOSX_DEPLOYMENT_TARGET=14.0` | Native `macos-15-intel` CI |

### ABI Audit Rules

Each platform build runs an automated binary header and dynamic-dependency audit before packaging:

- **Linux (`linux-x64`, `linux-arm64`)**: `readelf` verifies that only standard `glibc` / `libgcc` shared libraries are linked and that no symbol requires a version newer than `GLIBC_2.28`. (`musl` / Alpine is not supported by native archives; use the Docker image instead.)
- **Windows (`windows-x64`)**: PE import tables are audited to reject dynamic `vcruntime*`, `msvcp*`, and `ucrtbase*` DLL dependencies so users do not need `vc_redist`. (`BCryptPrimitives.dll` is explicitly permitted as the OS CNG [`ProcessPrng`](https://learn.microsoft.com/en-us/windows/win32/seccng/processprng) provider.)
- **macOS (`darwin-arm64`, `darwin-x64`)**: `otool` and `codesign` verify Mach-O CPU architecture, `14.0` deployment target, system-only library/framework links, and ad-hoc code signatures. (Public Apple Developer ID signing and notarization are not yet configured.)

---

## 2. Building and Probing Native Artifacts

Run the following scripts on a matching native host OS and CPU with `Node.js >= 22` and the platform toolchain installed (Linux builds also require Docker to run the pinned `manylinux_2_28` build container):

```bash
# Replace linux-x64 with any platform ID from packaging/native/targets.json:
node tools/native/build.mjs linux-x64
node tools/native/pack.mjs linux-x64
node tools/native/probe.mjs linux-x64
```

In CI, [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) calls [`.github/workflows/native-platforms.yml`](../../.github/workflows/native-platforms.yml) for PRs targeting `main` or carrying the `ci:full` label. The native workflow executes all five platform builds and probes without requiring publishing credentials, and remains available for manual runs and release workflow calls. Other PRs use the ordinary Linux checks described in [WORKFLOW.md](WORKFLOW.md).

### What the Build and Probe Scripts Verify

1. **MSRV & Unit Tests (`build.mjs`)**: checks compilation against Rust `1.89.0` and runs native library, regex corpus, text normalization, and story-index tests.
2. **Detached Archive Execution (`probe.mjs`)**: extracts the archive outside the repository checkout into a directory path containing spaces and Chinese characters, clears `PATH`, and launches the binaries directly:
   - Verifies all 5 entry point binaries (`prts-mcp`, `prts-mcp-ts`, `prts-mcp-ts-bun`, `prts-mcp-ts-stdio`, `prts-mcp-ghcr`);
   - Verifies both `stdio` and Streamable HTTP transports, plus legacy session-based and modern (`2026-07-28`) protocol envelopes;
   - Verifies `24` tools (`23` with `IMAGES_ENABLED=false`), operator profile/stats rendering, and Chinese regex lookbehind search against the committed smoke fixture ([`tests/fixtures/native-smoke/README.md`](../../tests/fixtures/native-smoke/README.md));
   - On Linux, `probe.mjs <platform> --baseline` additionally runs the extracted binary inside a clean AlmaLinux 8 (`glibc 2.28`) container with no compiler or language runtime installed.

---

## 3. Archive Layout and Metadata

`tools/native/pack.mjs` outputs stage-1 SDK archives under `artifacts/native/<platform>/`, while `tools/release/pack-native.mjs` adds the verified read-only fallback `data/` directory to produce the public candidate archives under `artifacts/candidate/<platform>/`:

- **`bin/`**: the 5 production entry executables (`prts-mcp`, `prts-mcp-ts`, `prts-mcp-ts-bun`, `prts-mcp-ts-stdio`, `prts-mcp-ghcr`; the internal test harness binary `prts-mcp-rust` is excluded).
- **`data/`** *(in public candidate archives)*: verified read-only fallback snapshot of `gamedata/`, `gamedata-levels/`, and `storyjson/` plus `data/BUNDLE.json` and `data/SHA256SUMS`.
- **Legal & Provenance Metadata**:
  - `LICENSE`, `NOTICE`, and `licenses/` (upstream license files for locked Cargo dependencies, Rust standard library notices, and QuickJS regexp notices);
  - `THIRD-PARTY.json`: machine-readable dependency license inventory;
  - `BUILD.json` and `ABI.json`: source commit SHA, compiler version, target baseline, and audited shared-library imports;
  - `SHA256SUMS` covers all files inside the archive. Internal candidate builds also retain an external `.sha256` sidecar. Public GitHub downloads use a single `SHA256SUMS` for the five native archives and the release metadata ZIP; see [`RELEASE-CANDIDATES.md`](RELEASE-CANDIDATES.md) for public filenames and metadata contents.
