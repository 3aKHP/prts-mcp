import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMAGES_META,
  activeGenerationSync,
  loadMeta,
  saveMeta,
} from "../src/sync/generationStore.ts";

test("activeGenerationSync resolves a valid generation and requires index.json", () => {
  const root = mkdtempSync(join(tmpdir(), "prts-genstore-"));
  const gen = join(root, ".releases", "test");
  mkdirSync(gen, { recursive: true });
  writeFileSync(join(gen, "index.json"), "{}", "utf-8");
  writeFileSync(join(root, IMAGES_META), JSON.stringify({
    generation_root: ".releases/test",
  }), "utf-8");

  assert.equal(activeGenerationSync(root), gen);

  // A generation dir without index.json is not active.
  const noIndex = join(root, ".releases", "noindex");
  mkdirSync(noIndex, { recursive: true });
  writeFileSync(join(root, IMAGES_META), JSON.stringify({
    generation_root: ".releases/noindex",
  }), "utf-8");
  assert.equal(activeGenerationSync(root), null);
});

test("activeGenerationSync rejects escaping and malformed pointers", () => {
  const root = mkdtempSync(join(tmpdir(), "prts-genstore-"));
  const outside = mkdtempSync(join(tmpdir(), "prts-genstore-out-"));
  const legit = join(root, ".releases", "legit");
  mkdirSync(legit, { recursive: true });
  writeFileSync(join(legit, "index.json"), "{}", "utf-8");

  for (const bad of ["../escape", "/etc", "", 42, null]) {
    writeFileSync(join(root, IMAGES_META), JSON.stringify({ generation_root: bad }), "utf-8");
    assert.equal(activeGenerationSync(root), null, `generation_root=${JSON.stringify(bad)}`);
  }

  // KNOWN PY/TS DIVERGENCE (D2 ledger): Python's Path.resolve() resolves
  // symlinks, so a symlinked generation root fails its containment check;
  // Node's path.resolve is purely lexical and this resolver accepts it.
  // Pinned here as current behavior — the downstream artwork doGet guard
  // (realpath-based, PR #169) still contains actual file reads, and the
  // pointer is only writable by the local sync itself.
  symlinkSync(outside, join(root, ".releases", "linked"));
  writeFileSync(join(outside, "index.json"), "{}", "utf-8");
  writeFileSync(join(root, IMAGES_META), JSON.stringify({
    generation_root: ".releases/linked",
  }), "utf-8");
  assert.equal(activeGenerationSync(root), join(root, ".releases", "linked"));

  // Unreadable/absent meta → null.
  writeFileSync(join(root, IMAGES_META), "not json", "utf-8");
  assert.equal(activeGenerationSync(root), null);
});

test("saveMeta/loadMeta round-trip atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "prts-genstore-"));
  await saveMeta(root, { generation_root: ".releases/x", currentVersion: "c1" });
  const meta = await loadMeta(root);
  assert.equal(meta?.["currentVersion"], "c1");
  assert.equal(meta?.["generation_root"], ".releases/x");
  assert.equal(JSON.parse((await import("node:fs")).readFileSync(join(root, IMAGES_META), "utf-8"))["currentVersion"], "c1");
});
