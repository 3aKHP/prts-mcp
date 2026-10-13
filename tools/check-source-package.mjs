#!/usr/bin/env node
// Inspect Cargo's actual file list, including ignored files matched by include.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const names = execFileSync("cargo", ["package", "--list", "--locked"], { cwd: root, encoding: "utf8" }).trim().split("\n");
const topLevel = new Set([
  "Cargo.toml", "Cargo.toml.orig", "Cargo.lock", "build.rs", "rust-toolchain.toml",
  "LICENSE", "NOTICE", "README.md", "CHANGELOG.md", ".cargo_vcs_info.json",
]);
const allowed = (name) => topLevel.has(name) || /^(src|native|vendor)\//.test(name) || name === "contracts/data-declarations.json";
const extra = names.filter((name) => !allowed(name));
if (extra.length) throw new Error(`Unexpected source package paths: ${extra.join(", ")}`);
for (const required of ["Cargo.lock", "build.rs", "src/bin/prts-mcp.rs", "native/regexp.c", "vendor/quickjs-regexp/libregexp.c",
  "vendor/quickjs-regexp/libunicode.c", "vendor/quickjs-regexp/NOTICES.txt", "contracts/data-declarations.json", "LICENSE", "NOTICE"]) {
  if (!names.includes(required)) throw new Error(`Required source file missing: ${required}`);
}
console.log(`SOURCE_PACKAGE_FILES_PASS: ${names.length} files; root include allowlist excludes validation caches`);
