import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { DirectoryStore, FallbackStore, ZipStore } from "../src/data/stores.ts";

const FIXTURE_PATH = "zh_CN/gamedata/excel/sample.json";
const FIXTURE_DATA = { name: "阿米娅", rarity: 5 };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "prts-store-test-"));
}

function writeFixtureDir(root: string, data: unknown = FIXTURE_DATA): void {
  const target = join(root, FIXTURE_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(data), "utf-8");
}

function writeFixtureZip(path: string, data: unknown = FIXTURE_DATA): void {
  mkdirSync(dirname(path), { recursive: true });
  const zip = new AdmZip();
  zip.addFile(FIXTURE_PATH, Buffer.from(JSON.stringify(data), "utf-8"));
  zip.writeZip(path);
}

test("DirectoryStore reads JSON from directory", () => {
  const root = tempRoot();
  writeFixtureDir(root);
  const store = new DirectoryStore(root);

  assert.equal(store.exists(FIXTURE_PATH), true);
  assert.match(store.readText(FIXTURE_PATH), /阿米娅/);
  assert.deepEqual(store.readJson(FIXTURE_PATH), FIXTURE_DATA);
  assert.match(store.describe(), /^directory:/);
});

test("DirectoryStore reports missing files and rejects parent paths", () => {
  const root = tempRoot();
  const store = new DirectoryStore(root);

  assert.equal(store.exists(FIXTURE_PATH), false);
  assert.throws(() => store.readText(FIXTURE_PATH), /Dataset file not found/);
  assert.throws(() => store.exists("../outside.json"), /Unsafe dataset path/);
});

test("DirectoryStore rejects absolute paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "prts-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new DirectoryStore(root);

  assert.throws(() => store.exists("/zh_CN/gamedata/excel/sample.json"), /Unsafe dataset path/);
});

test("ZipStore reads JSON from zip", () => {
  const root = tempRoot();
  const zipPath = join(root, "fixture.zip");
  writeFixtureZip(zipPath);
  const store = new ZipStore(zipPath);

  assert.equal(store.exists(FIXTURE_PATH), true);
  assert.match(store.readText(FIXTURE_PATH), /阿米娅/);
  assert.deepEqual(store.readJson(FIXTURE_PATH), FIXTURE_DATA);
  assert.match(store.describe(), /^zip:/);
});

test("ZipStore reports missing entries and rejects parent paths", () => {
  const root = tempRoot();
  const zipPath = join(root, "fixture.zip");
  writeFixtureZip(zipPath);
  const store = new ZipStore(zipPath);

  assert.equal(store.exists("zh_CN/missing.json"), false);
  assert.throws(() => store.readText("zh_CN/missing.json"), /Dataset zip entry not found/);
  assert.throws(() => store.exists("../outside.json"), /Unsafe dataset path/);
});

test("ZipStore rejects absolute paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "prts-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const zipPath = join(root, "fixture.zip");
  const store = new ZipStore(zipPath);

  assert.throws(() => store.exists("/zh_CN/gamedata/excel/sample.json"), /Unsafe dataset path/);
});

test("FallbackStore prefers primary store", () => {
  const root = tempRoot();
  const primary = join(root, "primary");
  const fallback = join(root, "fallback");
  writeFixtureDir(primary, { source: "primary" });
  writeFixtureDir(fallback, { source: "fallback" });
  const store = new FallbackStore(new DirectoryStore(primary), new DirectoryStore(fallback));

  assert.equal(store.exists(FIXTURE_PATH), true);
  assert.deepEqual(store.readJson(FIXTURE_PATH), { source: "primary" });
  assert.match(store.describe(), /^fallback:/);
});

test("FallbackStore reads fallback when primary is missing", () => {
  const root = tempRoot();
  const primary = join(root, "primary");
  const fallback = join(root, "fallback");
  writeFixtureDir(fallback, { source: "fallback" });
  const store = new FallbackStore(new DirectoryStore(primary), new DirectoryStore(fallback));

  assert.equal(store.exists(FIXTURE_PATH), true);
  assert.deepEqual(store.readJson(FIXTURE_PATH), { source: "fallback" });
});

test("FallbackStore reports files missing in both stores", () => {
  const root = tempRoot();
  const store = new FallbackStore(
    new DirectoryStore(join(root, "primary")),
    new DirectoryStore(join(root, "fallback")),
  );

  assert.equal(store.exists(FIXTURE_PATH), false);
  assert.throws(() => store.readText(FIXTURE_PATH), /fallback chain/);
});
