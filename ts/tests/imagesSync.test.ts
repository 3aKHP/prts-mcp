/**
 * Tests for imagesSync round-trip and delta-chain behavior (network mocked).
 *
 * Mirrors python/tests/test_images_sync.py: the baseline tests guard the
 * meta read/write key consistency and atomic-activation invariants; the
 * #179 chain scenarios use real zips + a truthful index so the sha256 gate
 * actually exercises the applied chain instead of vacuously passing over
 * empty artworks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { SCHEMA_VERSION } from "../src/data/images.ts";
import { neededShardKeys, syncImages } from "../src/sync/imagesSync.ts";
import { activeGeneration } from "../src/sync/generationStore.ts";

function tempImageDir(): string {
  return join(mkdtempSync(join(tmpdir(), "prts-images-sync-test-")), "images");
}

function withFetchMock(
  fetchMock: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalMirrors = process.env["GITHUB_MIRRORS"];
  globalThis.fetch = fetchMock;
  process.env["GITHUB_MIRRORS"] = "";
  return run().finally(() => {
    globalThis.fetch = originalFetch;
    if (originalMirrors === undefined) delete process.env["GITHUB_MIRRORS"];
    else process.env["GITHUB_MIRRORS"] = originalMirrors;
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
}

function zipBuffer(files: Record<string, Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) zip.addFile(path, content);
  return zip.toBuffer();
}

async function activeFiles(imageDir: string): Promise<Set<string>> {
  const gen = await activeGeneration(imageDir);
  assert.notEqual(gen, null, "an active generation must exist");
  const entries = await readdir(gen!, { recursive: true });
  return new Set(entries.filter((p) => p.endsWith(".png")));
}

// ---------------------------------------------------------------------------
// Baseline scenarios (single delta, empty artworks — meta/up_to_date guards).
// ---------------------------------------------------------------------------

/** Mock discovery + downloads for a one-delta world; count shard/delta fetches. */
function installSimpleMocks(opts: { deltaFails?: boolean } = {}): {
  fetchMock: typeof fetch;
  downloads: () => number;
} {
  const baseline = "b1";
  const current = "c1";
  let downloads = 0;
  const releases = [{
    tag_name: `images-${current}`,
    created_at: "2026-08-06T00:56:29Z",
    assets: [
      { name: "index.json", browser_download_url: `https://ex/${current}/index.json` },
      {
        name: `images-delta-${current}.zip`,
        browser_download_url: `https://ex/${current}/delta.zip`,
      },
    ],
  }];
  const shards: Record<string, string> = {};
  for (const s of ["chararts", "skinpack"]) {
    for (const v of ["original", "large", "preview"]) {
      shards[`${s}-${v}`] = `images-baseline-${s}-${v}-${baseline}.zip`;
    }
  }
  const indexPayload = {
    schemaVersion: SCHEMA_VERSION,
    baselineVersion: baseline,
    currentVersion: current,
    shards,
    artworks: {},
  };
  const fetchMock = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) return jsonResponse(releases);
    if (url.includes("index.json")) return jsonResponse(indexPayload);
    downloads += 1;
    if (opts.deltaFails && url.includes("delta")) {
      throw new Error("delta download failed");
    }
    return new Response(new Uint8Array(zipBuffer({})));
  }) as typeof fetch;
  return { fetchMock, downloads: () => downloads };
}

test("syncImages first updated then up_to_date without re-download", async () => {
  // Regression guard: meta read/write keys must match; a mismatch would make
  // the second sync re-download everything instead of returning up_to_date.
  const imageDir = tempImageDir();
  const mocks = installSimpleMocks();
  await withFetchMock(mocks.fetchMock, async () => {
    const r1 = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r1.status, "updated");
    assert.equal(r1.commitSha, "c1");
    const first = mocks.downloads();
    assert.equal(first, neededShardKeys(false).length + 1); // shards + delta

    const r2 = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r2.status, "up_to_date", "same versions must be up_to_date");
    assert.equal(mocks.downloads(), first, "up_to_date must not re-download");
  });
});

test("syncImages delta failure does not activate", async () => {
  // A delta download failure must not leave a broken generation active.
  const imageDir = tempImageDir();
  const mocks = installSimpleMocks({ deltaFails: true });
  await withFetchMock(mocks.fetchMock, async () => {
    const r = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r.status, "no_data", "delta failure with no prior generation → no_data");
    assert.equal(await activeGeneration(imageDir), null);
  });
});

test("syncImages offline falls back to the existing generation", async () => {
  // Network failure after a successful sync returns offline_fallback.
  const imageDir = tempImageDir();
  const mocks = installSimpleMocks();
  await withFetchMock(mocks.fetchMock, async () => {
    const r1 = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r1.status, "updated");
  });
  // Simulate network loss on the next cycle.
  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const r = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r.status, "offline_fallback");
    assert.equal(r.commitSha, "c1");
    assert.notEqual(await activeGeneration(imageDir), null);
  });
});

// ---------------------------------------------------------------------------
// Delta-chain scenarios (#179): real zips + truthful index artworks, so the
// sha256 gate actually exercises the applied chain instead of vacuously
// passing over empty artworks.
// ---------------------------------------------------------------------------

const B = "26-08-03-00-00-00_aaaaaa";
const D1 = "26-08-07-00-00-00_bbbbbb";
const D2 = "26-08-17-00-00-00_cccccc";

function png(tag: string): Buffer {
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    Buffer.from(tag, "utf-8"),
  ]);
}

function skinFiles(
  skin: string,
  variants: readonly string[] = ["large", "preview"],
): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const v of variants) files[`chararts/${skin}_${v}.png`] = png(`${skin}-${v}`);
  return files;
}

/** Build index.json artworks entries with truthful sha256 for *files*. */
function artworkEntries(files: Record<string, Buffer>): Record<string, unknown> {
  const artworks: Record<string, Record<string, unknown>> = {};
  for (const [path, content] of Object.entries(files)) {
    const stem = path.split("/")[1].slice(0, -".png".length);
    const cut = stem.lastIndexOf("_");
    const skin = stem.slice(0, cut);
    const variant = stem.slice(cut + 1);
    const entry = (artworks[skin] ??= { kind: "base" });
    entry[variant] = {
      file: path,
      sha256: createHash("sha256").update(content).digest("hex"),
      w: 1,
      h: 1,
      bytes: content.length,
    };
  }
  return artworks;
}

type ReleaseObj = Record<string, unknown>;

/**
 * Controlled AKDP images world: real zips and a truthful index.
 *
 * ``baseFiles`` ship in the baseline shards; ``deltaFiles`` maps each delta
 * version to the files its zip adds. The latest delta release also serves
 * the authoritative index.json covering every file, so the sha256 gate
 * fails unless the full chain was applied (#179).
 */
class ChainWorld {
  baseline: string;
  shardKeys: readonly string[];
  baseFiles: Record<string, Buffer> = {};
  deltaFiles: Record<string, Record<string, Buffer>> = {};
  missingDeltaAssets = new Set<string>();
  omittedReleases = new Set<string>();
  extraReleases: ReleaseObj[] = [];
  indexCurrentOverride: string | null = null;
  page1OnlyLatest = false;
  downloads = new Map<string, number>();
  paginatedCalls = 0;

  constructor(opts: { baseline?: string; shardKeys?: readonly string[] } = {}) {
    this.baseline = opts.baseline ?? B;
    this.shardKeys = opts.shardKeys ?? ["chararts-large", "chararts-preview"];
  }

  get current(): string {
    const versions = Object.keys(this.deltaFiles).sort();
    return versions.length > 0 ? versions[versions.length - 1] : this.baseline;
  }

  allFiles(): Record<string, Buffer> {
    const files = { ...this.baseFiles };
    for (const version of Object.keys(this.deltaFiles).sort()) {
      Object.assign(files, this.deltaFiles[version]);
    }
    return files;
  }

  indexPayload(): ReleaseObj {
    const shards: Record<string, string> = {};
    for (const key of this.shardKeys) {
      shards[key] = `images-baseline-${key}-${this.baseline}.zip`;
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      baselineVersion: this.baseline,
      currentVersion: this.indexCurrentOverride ?? this.current,
      shards,
      artworks: artworkEntries(this.allFiles()),
    };
  }

  releases(): ReleaseObj[] {
    const releases: ReleaseObj[] = [{
      tag_name: `images-baseline-${this.baseline}`,
      created_at: "2026-08-01T00:00:00Z",
      assets: [],
    }];
    const versions = Object.keys(this.deltaFiles).sort();
    versions.forEach((version, seq) => {
      if (this.omittedReleases.has(version)) return;
      const assets: Array<Record<string, string>> = [];
      if (!this.missingDeltaAssets.has(version)) {
        assets.push({
          name: `images-delta-${version}.zip`,
          browser_download_url: `https://ex/delta/${version}.zip`,
        });
      }
      if (version === versions[versions.length - 1]) {
        assets.push({
          name: "index.json",
          browser_download_url: `https://ex/${version}/index.json`,
        });
      }
      releases.push({
        tag_name: `images-${version}`,
        created_at: `2026-08-${String(2 + seq).padStart(2, "0")}T00:00:00Z`,
        assets,
      });
    });
    return [...releases, ...this.extraReleases];
  }

  fetchMock(): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        if (url.includes("&page=")) {
          this.paginatedCalls += 1;
          return jsonResponse(this.releases());
        }
        const releases = this.releases();
        return jsonResponse(this.page1OnlyLatest ? releases.slice(-1) : releases);
      }
      if (url.includes("index.json")) return jsonResponse(this.indexPayload());
      this.downloads.set(url, (this.downloads.get(url) ?? 0) + 1);
      let files: Record<string, Buffer>;
      if (url.startsWith("https://ex/delta/")) {
        const version = url.split("/").pop()!.slice(0, -".zip".length);
        files = this.deltaFiles[version];
      } else {
        const shardFile = url.split("/").pop()!;
        const shards = this.indexPayload()["shards"] as Record<string, string>;
        const shardKey = Object.keys(shards).find((k) => shards[k] === shardFile)!;
        const variant = shardKey.split("-").pop()!;
        files = Object.fromEntries(
          Object.entries(this.baseFiles).filter(([p]) => p.endsWith(`_${variant}.png`)),
        );
      }
      return new Response(new Uint8Array(zipBuffer(files)));
    }) as typeof fetch;
  }

  baselineDownloads(): number {
    let total = 0;
    for (const [url, n] of this.downloads) {
      if (url.includes("/releases/download/")) total += n;
    }
    return total;
  }

  totalDownloads(): number {
    let total = 0;
    for (const n of this.downloads.values()) total += n;
    return total;
  }
}

function chainWorld(): ChainWorld {
  const world = new ChainWorld();
  world.baseFiles = skinFiles("skin_base");
  world.deltaFiles = {
    [D1]: skinFiles("skin_d1"),
    [D2]: skinFiles("skin_d2"),
  };
  return world;
}

test("fresh install applies the full delta chain (#179)", async () => {
  const imageDir = tempImageDir();
  const world = chainWorld();
  await withFetchMock(world.fetchMock(), async () => {
    const r = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r.status, "updated");
    assert.equal(r.commitSha, D2);
    assert.deepEqual(await activeFiles(imageDir), new Set(Object.keys(world.allFiles())));
    // Two baseline shards + both deltas, each fetched exactly once.
    assert.equal(world.baselineDownloads(), 2);
    assert.equal(world.paginatedCalls, 0, "page 1 already covers the baseline");

    const r2 = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r2.status, "up_to_date");
  });
});

test("fast path applies intermediate deltas (#179)", async () => {
  // A prior generation must absorb every delta since its version.
  const imageDir = tempImageDir();
  const world = new ChainWorld();
  world.baseFiles = skinFiles("skin_base");
  world.deltaFiles = { [D1]: skinFiles("skin_d1") };
  await withFetchMock(world.fetchMock(), async () => {
    const r1 = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r1.status, "updated");
    assert.equal(r1.commitSha, D1);
    const shardsAfterFirst = world.baselineDownloads();

    // The pipeline publishes D2; the instance jumps D1 -> D2 directly.
    world.deltaFiles[D2] = skinFiles("skin_d2");

    const r2 = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r2.status, "updated");
    assert.equal(r2.commitSha, D2);
    assert.deepEqual(await activeFiles(imageDir), new Set(Object.keys(world.allFiles())));
    // Fast path: baseline shards and the already-applied D1 are not re-fetched.
    assert.equal(world.baselineDownloads(), shardsAfterFirst);
    assert.equal(world.downloads.get(`https://ex/delta/${D1}.zip`), 1);
    assert.equal(world.downloads.get(`https://ex/delta/${D2}.zip`), 1);
  });
});

test("delta chain with include_original variant set", async () => {
  // includeOriginal adds the original shards; chain semantics unchanged.
  const imageDir = tempImageDir();
  const world = new ChainWorld({
    shardKeys: ["chararts-large", "chararts-preview", "chararts-original"],
  });
  const variants = ["large", "preview", "original"];
  world.baseFiles = skinFiles("skin_base", variants);
  world.deltaFiles = {
    [D1]: skinFiles("skin_d1", variants),
    [D2]: skinFiles("skin_d2", variants),
  };
  await withFetchMock(world.fetchMock(), async () => {
    const r = await syncImages(imageDir, { includeOriginal: true, forceCheck: true });
    assert.equal(r.status, "updated");
    assert.deepEqual(await activeFiles(imageDir), new Set(Object.keys(world.allFiles())));
  });
});

test("missing intermediate release fails closed at the sha256 gate (#179)", async () => {
  // A delta the pipeline never published cannot be enumerated; the sha256
  // gate is the authoritative stop and nothing activates.
  const imageDir = tempImageDir();
  const world = chainWorld();
  world.omittedReleases = new Set([D1]);
  await withFetchMock(world.fetchMock(), async () => {
    const r = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r.status, "no_data");
    assert.match(r.error ?? "", /sha256/);
    assert.equal(await activeGeneration(imageDir), null);
  });
});

test("missing delta asset fails before the baseline download (#179)", async () => {
  // A broken chain fails closed *before* the ~1.5 GB baseline pull.
  const imageDir = tempImageDir();
  const world = chainWorld();
  world.missingDeltaAssets = new Set([D1]);
  await withFetchMock(world.fetchMock(), async () => {
    const r = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r.status, "no_data");
    assert.match(r.error ?? "", /delta asset missing/);
    assert.equal(world.totalDownloads(), 0, "no shard fetch may happen");
    assert.equal(await activeGeneration(imageDir), null);
  });
});

test("duplicate delta version fails closed (#179)", async () => {
  const imageDir = tempImageDir();
  const world = chainWorld();
  world.extraReleases = [{
    tag_name: `images-${D1}`,
    // Older than D2 so latestReleaseByPrefix still picks D2.
    created_at: "2026-08-02T12:00:00Z",
    assets: [{
      name: `images-delta-${D1}.zip`,
      browser_download_url: `https://ex/delta/${D1}.zip`,
    }],
  }];
  await withFetchMock(world.fetchMock(), async () => {
    const r = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r.status, "no_data");
    assert.match(r.error ?? "", /duplicate/);
    assert.equal(world.totalDownloads(), 0);
  });
});

test("rollback rebuilds from the baseline (#179)", async () => {
  // index currentVersion moving backwards must not reuse the newer prior
  // generation; rebuild from baseline + chain instead.
  const imageDir = tempImageDir();
  const world = chainWorld();
  await withFetchMock(world.fetchMock(), async () => {
    const r1 = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r1.commitSha, D2);

    // The factory retracts D2 (release deleted, index regenerated at D1).
    delete world.deltaFiles[D2];

    const r2 = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r2.status, "updated");
    assert.equal(r2.commitSha, D1);
    assert.deepEqual(
      await activeFiles(imageDir),
      new Set([...Object.keys(world.baseFiles), ...Object.keys(world.deltaFiles[D1])]),
    );
  });
});

test("sentinel-only empty chain applies the baseline alone", async () => {
  // A world whose only delta is the baseline sentinel (empty zip) is a
  // legal empty chain: shards only, no delta asset requested.
  const imageDir = tempImageDir();
  const world = new ChainWorld();
  world.baseFiles = skinFiles("skin_base");
  world.deltaFiles = { [B]: {} }; // sentinel: same version as the baseline
  await withFetchMock(world.fetchMock(), async () => {
    const r = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r.status, "updated");
    assert.equal(r.commitSha, B);
    assert.deepEqual(await activeFiles(imageDir), new Set(Object.keys(world.baseFiles)));
    assert.equal(world.baselineDownloads(), 2);
    assert.equal(
      [...world.downloads.keys()].some((url) => url.includes("delta")),
      false,
    );
  });
});

test("index currentVersion/tag mismatch fails closed (#179)", async () => {
  // index currentVersion is authoritative; drift from the latest delta tag
  // fails closed instead of building the wrong chain.
  const imageDir = tempImageDir();
  const world = chainWorld();
  world.indexCurrentOverride = "26-08-19-00-00-00_dddddd";
  await withFetchMock(world.fetchMock(), async () => {
    const r = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r.status, "no_data");
    assert.match(r.error ?? "", /currentVersion/);
    assert.equal(world.totalDownloads(), 0);
  });
});

test("pagination recovers a baseline beyond the first page (#179)", async () => {
  // When the baseline falls out of the newest-100 page, discovery paginates
  // until the chain start is covered.
  const imageDir = tempImageDir();
  const world = chainWorld();
  world.page1OnlyLatest = true;
  await withFetchMock(world.fetchMock(), async () => {
    const r = await syncImages(imageDir, { forceCheck: true });
    assert.equal(r.status, "updated");
    assert.equal(world.paginatedCalls, 1);
    assert.deepEqual(await activeFiles(imageDir), new Set(Object.keys(world.allFiles())));
  });
});
