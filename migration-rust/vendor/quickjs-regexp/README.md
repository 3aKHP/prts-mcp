# Standalone native regexp / Unicode sources

These seven upstream files are copied unchanged from the `quickjs/` directory
of the checksum-pinned crates.io `rquickjs-sys 0.14.0` release. `SOURCE.json`
records the archive checksum and each original file's SHA-256. File-level
copyright notices are retained. Code is MIT; generated Unicode tables use
Unicode-3.0. `NOTICES.txt` is included with every binary distribution.

Only `libregexp.c`, `libunicode.c` and our `native/regexp.c` bridge are compiled
by `build.rs`, as a static C archive. `quickjs.c`, JavaScript contexts/evaluation,
module loaders, and the rquickjs crates are excluded. These two upstream
components implement ECMAScript regexp matching and Unicode operations in C;
no Node, Bun, JS VM, PCRE installation, or host regex library is used at runtime.

A C compiler is required to build from source. Users of the native directory,
npm tarball, or Docker image use the included precompiled binary. The currently
verified platform is Linux x86_64 glibc (WSL2 / ubuntu:24.04), as in P7/P8.

Changes to these pinned sources require reviewing the bytecode-prefix bridge,
regenerating hashes, and repeating the original/extended Bun corpora, Unicode
folding proof, ASan/UBSan harness, full index digest and packaging checks.
