# Native platform artifacts (M2A)

M2A builds and runs the native Rust product on five matching CPU/OS runners. These are development CI artifacts, not published 3.x releases. npm installation is M2B, the production Docker wrapper is M2C, public publishing is M3/M5 and full candidate real-client E2E is M4. No Node/Bun/Python business runtime or local compilation is part of native installation.

## Baselines and evidence

The machine-readable build configuration is [targets.json](../../packaging/native/targets.json). Cargo.lock remains frozen; development/release builds use Rust 1.96.1, and production binaries are also checked with Rust 1.89.0 (`Cargo.toml` rust-version). A C compiler is required only for source builds, including future cargo install; the native regexp component is linked into every prebuilt executable.

| Artifact | Target and CPU | Build baseline | Actual runtime verification |
| --- | --- | --- | --- |
| linux-x64 | x86_64-unknown-linux-gnu, x86-64/SSE2 | Pinned manylinux_2_28 image, glibc 2.28 | Local WSL x64 detached archive passed; native Ubuntu CI pending. |
| linux-arm64 | aarch64-unknown-linux-gnu, generic ARMv8 | Pinned manylinux_2_28 image, glibc 2.28 | Native ubuntu-24.04-arm CI pending; no emulation claim. |
| windows-x64 | x86_64-pc-windows-msvc, x86-64 | Static CRT, declared Windows 10 / Server 2016 Rust baseline | Native windows-2022 CI pending. |
| darwin-arm64 | aarch64-apple-darwin, Apple M1 baseline | macOS deployment target 14.0 | Native macos-14 CI pending. |
| darwin-x64 | x86_64-apple-darwin, x86-64/SSE2 | macOS deployment target 14.0 | Native macos-15-intel CI pending. |

The deployment/ABI floor and the OS actually exercised are separate facts. Linux containers share the host kernel: a glibc 2.28 build does not prove a particular old kernel. macOS Intel CI running version 15 does not constitute an actual version-14 runtime test. Windows Server 2022 CI does not constitute a Windows 10 desktop test. Runtime evidence records the host OS version and CPU; no cross-compiled or emulated run is counted as native evidence. macOS ARM uses Apple's M1 baseline, including crypto features guaranteed by Apple Silicon; an unqualified generic ARM target strips those guarantees and fails the locked ring dependency's compile-time check. macOS signatures are local/ad-hoc; public distribution signing/notarization and browser quarantine behavior are not claimed by this phase.

Linux artifacts accept only standard glibc/libgcc shared libraries, and readelf must report no symbol requirement newer than GLIBC_2.28. Windows artifacts reject VC/UCRT and other non-system DLL imports; users need not install vc_redist. macOS artifacts allow only system libraries/frameworks and verify Mach-O architecture, deployment target and code signature. Extra dependencies fail packaging rather than silently becoming installation prerequisites.

Platform correctness fixes preserve the frozen runtime contract: Windows extraction retains the drive/UNC prefix during containment checks, activation caches observe native file IDs, and both canonicalized paths are used when writing relative generation metadata so a whole data volume remains movable. Memory diagnostics use Windows working-set/peak counters and macOS Mach resident/peak sizes; Linux continues reading /proc with the real OS page size, including ARM64 systems with pages larger than 4 KiB. The small platform memory adapter uses OS SDK headers and is statically compiled into the binary; it adds no third-party runtime dependency. API references: [Windows memory counters](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo), [Apple Mach task information](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

## Build and validate

From a matching native host with Node >=22 and the source-build tools:

```bash
node tools/native/build.mjs linux-x64
node tools/native/pack.mjs linux-x64
node tools/native/probe.mjs linux-x64
```

Replace linux-x64 with an ID from targets.json. Linux additionally requires Docker; its C/Rust builds run in the pinned glibc-2.28 container on the native host CPU. Windows uses the Visual Studio SDK environment and CC=clang-cl with static CRT. macOS uses the system C compiler and a pinned deployment target. The host/CPU guard rejects mismatches before building or claiming support. [.github/workflows/native-platforms.yml](../../.github/workflows/native-platforms.yml) runs all five combinations without release/npm/container publishing permissions.

Per-platform verification runs the production minimum-Rust check, native library unit tests, original Bun regex corpus, expanded native text corpus and story index lifecycle. The detached archive probe validates extracted file hashes, new and legacy entry profiles, HTTP/stdio, both HTTP protocol eras, 24/23 tool registration, frozen TS operator output, Chinese story lookbehind matching, protocol-only stdio and EOF/shutdown behavior. It runs executables outside the source checkout from a path containing spaces and Chinese characters, with an empty PATH. Node is only the test MCP client. Windows additionally checks the real LOCALAPPDATA default-data path. The ordinary Linux CI retains the complete frozen 384-case differential/lifecycle suite; the smaller native matrix does not replace it or claim full production-data E2E on every OS.

## Payload and checksums

Each artifacts/native/<platform>/ directory contains prts-mcp-<version>-<platform>.tar.gz (Unix) or .zip (Windows), a .sha256 sidecar and runtime-evidence.json. Archives include five bin/ executables: prts-mcp, prts-mcp-ts, prts-mcp-ts-bun, prts-mcp-ts-stdio and prts-mcp-ghcr; the harness-only prts-mcp-rust is not distributed. No synthetic game fixture is included in the product archive. Normal startup uses the existing per-user sync/data contract, with explicit existing data paths supported.

LICENSE, NOTICE, original locked dependency notices, Rust standard-library notices and native regexp notices travel with each artifact. THIRD-PARTY.json inventories the normal/build dependency closure; build-time dependencies are retained conservatively and are not asserted to be linked. BUILD.json records source identity, dirty state, version, compiler, native host and configured baseline. ABI.json records actual native library dependencies and binary headers. SHA256SUMS covers every payload file except itself; the archive sidecar covers the complete compressed archive. Runtime evidence binds its successful run to the archive SHA-256.

Linux additionally runs the extracted archive in a pinned AlmaLinux 8 minimal runtime image on the matching host CPU, without a compiler or language runtime in that image. Docker is only this phase's test enclosure; a tiny init forwards signals, and HTTP is forwarded through a loopback-only mapped port. This does not pre-empt the M2C production Docker wrapper.

GitHub Actions artifacts retain evidence for 14 days; this is CI retention, not a stable-download service. Public release automation will use the same payload contract in M3. The archive probe does not depend on historical TS sources, network data or local caches: [the small committed fixture](../../tests/fixtures/native-smoke/README.md) corresponds to contracts/data-manifest.json and its exact committed bytes are sealed in contracts/native-smoke-manifest.json. It is used only in the temporary test installation.

Build environment references: [GitHub native hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [manylinux_2_28 images and glibc baseline](https://github.com/pypa/manylinux), [Rust supported platforms](https://doc.rust-lang.org/rustc/platform-support.html). Actual artifact audits and runtime records own the project's support claims.
