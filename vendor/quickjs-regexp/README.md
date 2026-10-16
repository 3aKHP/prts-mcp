# Vendored QuickJS Regexp and Unicode C Sources

These seven upstream C/header files are copied unmodified from the `quickjs/` directory of the checksum-pinned `rquickjs-sys 0.14.0` crate on `crates.io`. [`SOURCE.json`](SOURCE.json) records the upstream crate archive checksum and the SHA-256 digest of each file. Upstream copyright and license notices (`MIT AND Unicode-3.0`) are preserved in [`NOTICES.txt`](NOTICES.txt) and bundled with every binary distribution.

Only `libregexp.c`, `libunicode.c`, and our [`native/regexp.c`](../../native/regexp.c) FFI bridge are compiled by [`build.rs`](../../build.rs) into a static C library. `quickjs.c`, the JavaScript VM/evaluator, and module loaders are excluded. Together, these components provide ECMAScript regular-expression matching (including lookahead/lookbehind and Unicode property escapes) in pure C with no runtime dependency on Node.js, Bun, or PCRE.

A C compiler is required only when building PRTS-MCP from source; prebuilt native archives, npm platform packages, and Docker images statically link this library across all five supported targets (`linux-x64`, `linux-arm64`, `windows-x64`, `darwin-arm64`, and `darwin-x64`).

If you update these vendored files, verify the bytecode-prefix bridge in `native/regexp.c`, update `SOURCE.json`, and run the full regex and sanitizer verification suite (`./scripts/check-runtime.sh --full` and `node tools/check-native-regexp.mjs`).
