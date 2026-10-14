# Native platform artifacts (M2A)

M2A builds and runs the native Rust product on five matching CPU/OS runners. M2A SDK artifacts remain development output; M3 publishes separate complete data-bearing candidates. npm installation is M2B, the production Docker wrapper is M2C, public publishing is M3/M5 and full candidate real-client E2E is M4. No Node/Bun/Python business runtime or local compilation is part of native installation.

## Baselines and evidence

The machine-readable build configuration is [targets.json](../../packaging/native/targets.json). Cargo.lock remains frozen; development/release builds use Rust 1.96.1, and production binaries are also checked with Rust 1.89.0 (`Cargo.toml` rust-version). A C compiler is required only for source builds, including future cargo install; the native regexp component is linked into every prebuilt executable.

| Artifact | Target and CPU | Build baseline | Actual runtime verification |
| --- | --- | --- | --- |
| linux-x64 | x86_64-unknown-linux-gnu, x86-64/SSE2 | Pinned manylinux_2_28 image, glibc 2.28 | WSL and native Ubuntu CI passed; minimal AlmaLinux 8 runtime passed. |
| linux-arm64 | aarch64-unknown-linux-gnu, generic ARMv8 | Pinned manylinux_2_28 image, glibc 2.28 | Native ubuntu-24.04-arm CI and minimal AlmaLinux 8 runtime passed. |
| windows-x64 | x86_64-pc-windows-msvc, x86-64 | Static CRT, declared Windows 10 / Server 2016 Rust baseline | Native windows-2022 CI passed; local Windows desktop stdio smoke passed. |
| darwin-arm64 | aarch64-apple-darwin, Apple M1 baseline | macOS deployment target 14.0 | Native macos-14 CI passed (Darwin 23.6.0). |
| darwin-x64 | x86_64-apple-darwin, x86-64/SSE2 | macOS deployment target 14.0 | Native macos-15-intel CI passed. |

All five native jobs passed on source snapshot 69c142ed5a3597b6d40351ee157ac6f5ff0d899b in [native CI run 38334964791](https://github.com/3aKHP/prts-mcp/actions/runs/38334964791); [full Linux CI 38334964810](https://github.com/3aKHP/prts-mcp/actions/runs/38334964810) passed 215 Rust tests, 384/384 frozen differentials, lifecycle and 3,276 ASAN cases. Each native job passed 165 library tests plus the native text/original regex/story-index tests, ABI audits for five executables and the detached archive probe: eight profile checks on Unix, ten on Windows including both default-data branches. The local Windows desktop smoke used archive snapshot 437131bfa9a0da20419b72aace23a7eb33c9bc5a on NT 10.0.26340.0 with empty PATH, Chinese tool lookup and EOF -> 0; it is additional native proof, not M4 full candidate E2E. PR #229 records any later final-head CI revalidation and review closure.

The deployment/ABI floor and the OS actually exercised are separate facts. Linux containers share the host kernel: a glibc 2.28 build does not prove a particular old kernel. macOS Intel CI running version 15 does not constitute an actual version-14 runtime test. Windows Server 2022 CI does not constitute a Windows 10 desktop test. Runtime evidence records the host OS version and CPU; no cross-compiled or emulated run is counted as native evidence. macOS ARM uses Apple's M1 baseline, including crypto features guaranteed by Apple Silicon; an unqualified generic ARM target strips those guarantees and fails the locked ring dependency's compile-time check. macOS signatures are local/ad-hoc; public distribution signing/notarization and browser quarantine behavior are not claimed by this phase.

Linux artifacts accept only standard glibc/libgcc shared libraries, and readelf must report no symbol requirement newer than GLIBC_2.28. Windows artifacts reject VC/UCRT and other non-system DLL imports; users need not install vc_redist. macOS artifacts allow only system libraries/frameworks and verify Mach-O architecture, deployment target and code signature. Extra dependencies fail packaging rather than silently becoming installation prerequisites.

Windows BCryptPrimitives.dll is explicitly allowed as the operating system's [ProcessPrng CNG implementation](https://learn.microsoft.com/en-us/windows/win32/seccng/processprng), used by the locked random-number dependencies. It is not a VC/UCRT runtime. The PE audit still rejects vcruntime/msvcp/ucrt imports.

Platform correctness fixes preserve the frozen runtime contract: Windows extraction retains the drive/UNC prefix during containment checks, activation caches observe native file IDs, and both canonicalized paths are used when writing relative generation metadata so a whole data volume remains movable. Memory diagnostics use Windows working-set/peak counters and macOS Mach resident/peak sizes; Linux continues reading /proc with the real OS page size, including ARM64 systems with pages larger than 4 KiB. The small platform memory adapter uses OS SDK headers and is statically compiled into the binary; it adds no third-party runtime dependency. API references: [Windows memory counters](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo), [Apple Mach task information](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

## Build and validate

From a matching native host with Node >=22 and the source-build tools:

```bash
node tools/native/build.mjs linux-x64
node tools/native/pack.mjs linux-x64
node tools/native/probe.mjs linux-x64
```

Replace linux-x64 with an ID from targets.json. Linux additionally requires Docker; its C/Rust builds run in the pinned glibc-2.28 container on the native host CPU. Windows uses the Visual Studio SDK environment and CC=clang-cl with static CRT. macOS uses the system C compiler and a pinned deployment target. The host/CPU guard rejects mismatches before building or claiming support. [.github/workflows/native-platforms.yml](../../.github/workflows/native-platforms.yml) runs all five combinations without release/npm/container publishing permissions.

Per-platform verification runs the production minimum-Rust check, native library unit tests, original Bun regex corpus, expanded native text corpus and story index lifecycle. The detached archive probe validates extracted file hashes, new and legacy entry profiles, HTTP/stdio, both HTTP protocol eras, 24/23 tool registration, frozen TS operator output, Chinese story lookbehind matching, protocol-only stdio and EOF/shutdown behavior. It runs executables outside the source checkout from a path containing spaces and Chinese characters, with an empty PATH. Node is only the test MCP client. Windows additionally checks real LOCALAPPDATA and USERPROFILE/AppData/Local default-data paths; ZIP tooling uses Unicode-aware Windows APIs, avoiding tar.exe code-page loss. Signal termination is measured, without claiming graceful shutdown where the OS terminates the process directly. The ordinary Linux CI retains the complete frozen 384-case differential/lifecycle suite; the smaller native matrix does not replace it or claim full production-data E2E on every OS.

## Payload and checksums

Each artifacts/native/<platform>/ directory contains prts-mcp-<version>-<platform>.tar.gz (Unix) or .zip (Windows), a .sha256 sidecar and runtime-evidence.json. Archives include five bin/ executables: prts-mcp, prts-mcp-ts, prts-mcp-ts-bun, prts-mcp-ts-stdio and prts-mcp-ghcr; the harness-only prts-mcp-rust is not distributed. No synthetic game fixture is included in the product archive. Normal startup uses the existing per-user sync/data contract, with explicit existing data paths supported.

LICENSE, NOTICE, original locked dependency notices, Rust standard-library notices and native regexp notices travel with each artifact. THIRD-PARTY.json inventories the normal/build dependency closure; build-time dependencies are retained conservatively and are not asserted to be linked. BUILD.json records source identity, dirty state, version, compiler, native host and configured baseline. ABI.json records actual native library dependencies and binary headers. SHA256SUMS covers every payload file except itself; the archive sidecar covers the complete compressed archive. Runtime evidence binds its successful run to the archive SHA-256.

Linux additionally runs the extracted archive in a pinned AlmaLinux 8 minimal runtime image on the matching host CPU, without a compiler or language runtime in that image. Docker is only this phase's test enclosure; a tiny init forwards signals, and HTTP is forwarded through a loopback-only mapped port. This does not pre-empt the M2C production Docker wrapper.

GitHub Actions artifacts retain evidence for 14 days; this is CI retention, not a stable-download service. M3 now publishes complete data-bearing [3.0.0-alpha.3 candidates](https://github.com/3aKHP/prts-mcp/releases/tag/v3.0.0-alpha.3) under the same payload contract; [acceptance](reports/3.0-m3-candidate-release.md) records actual release scope. The archive probe does not depend on historical TS sources, network data or local caches: [the small committed fixture](../../tests/fixtures/native-smoke/README.md) corresponds to contracts/data-manifest.json and its exact committed bytes are sealed in contracts/native-smoke-manifest.json. It is used only in the temporary test installation.

Build environment references: [GitHub native hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [manylinux_2_28 images and glibc baseline](https://github.com/pypa/manylinux), [Rust supported platforms](https://doc.rust-lang.org/rustc/platform-support.html). Actual artifact audits and runtime records own the project's support claims.
