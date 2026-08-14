import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import {
  __resetActivationForTesting,
  checkActivationChange,
  registerActivationListener,
} from "../src/activation.js";
import {
  syncRelease,
  downloadReleaseAsset,
  syncReleaseArchive,
  syncReleaseArchivePair,
  withArchiveActivationLock,
  ActivationLockTimeoutError,
  fetchCascading,
  AssetNotFoundError,
  type ReleaseArchiveSpec,
  type ReleaseSpec,
} from "../src/data/sync.ts";
import { parseMirrors } from "../src/sync/transport.js";

test("fetchCascading raises AssetNotFoundError on a direct 404 (#100)", async () => {
  await withFetchMock((async () => new Response("missing", { status: 404 })) as typeof fetch, async () => {
    await assert.rejects(
      fetchCascading("https://example.com/asset", {}, 1000),
      (err: unknown) => err instanceof AssetNotFoundError,
    );
  });
});

test("downloadReleaseAsset verifies the optional factory manifest", async () => {
  const spec = { ...tempSpec(), verifyManifest: true };
  const content = Buffer.from("verified", "utf-8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  let call = 0;
  await withFetchMock((async (input: RequestInfo | URL) => {
    call += 1;
    if (call === 1) return new Response(content);
    assert.match(String(input), /manifest\.json$/);
    return new Response(JSON.stringify({
      contractVersion: "prts-mcp-data/v1",
      source: { versionId: "test" },
      assets: { "zh_CN.zip": { size: content.byteLength, sha256 } },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch, async () => {
    await downloadReleaseAsset(spec, "data-test", "https://example/asset");
  });
  assert.deepEqual(readFileSync(spec.localZip), content);
});

test("downloadReleaseAsset keeps the old zip on manifest mismatch", async () => {
  const spec = { ...tempSpec(), verifyManifest: true };
  mkdirSync(dirname(spec.localZip), { recursive: true });
  writeFileSync(spec.localZip, "old", "utf-8");
  const content = Buffer.from("new", "utf-8");
  let call = 0;
  await withFetchMock((async (input: RequestInfo | URL) => {
    call += 1;
    if (call === 1) return new Response(content);
    assert.match(String(input), /manifest\.json$/);
    return new Response(JSON.stringify({
      contractVersion: "prts-mcp-data/v1",
      source: { versionId: "test" },
      assets: { "zh_CN.zip": { size: content.byteLength, sha256: "bad" } },
    }));
  }) as typeof fetch, async () => {
    await assert.rejects(
      downloadReleaseAsset(spec, "data-test", "https://example/asset"),
      /manifest mismatch/,
    );
  });
  assert.equal(readFileSync(spec.localZip, "utf-8"), "old");
});

test("downloadReleaseAsset keeps legacy releases without a manifest", async () => {
  const spec = { ...tempSpec(), verifyManifest: true };
  const content = Buffer.from("legacy", "utf-8");
  let call = 0;
  await withFetchMock((async (input: RequestInfo | URL) => {
    call += 1;
    if (call === 1) return new Response(content);
    assert.match(String(input), /manifest\.json$/);
    return new Response("missing", { status: 404 });
  }) as typeof fetch, async () => {
    await downloadReleaseAsset(spec, "data-test", "https://example/asset");
  });
  assert.deepEqual(readFileSync(spec.localZip), content);
});

test("downloadReleaseAsset rejects an unsupported manifest contract", async () => {
  const spec = { ...tempSpec(), verifyManifest: true };
  let call = 0;
  await withFetchMock((async () => {
    call += 1;
    if (call === 1) return new Response("new");
    return new Response(JSON.stringify({ contractVersion: "unknown", assets: {} }));
  }) as typeof fetch, async () => {
    await assert.rejects(
      downloadReleaseAsset(spec, "data-test", "https://example/asset"),
      /unsupported contractVersion/,
    );
  });
  assert.equal(existsSync(spec.localZip), false);
});

test("downloadReleaseAsset rejects a non-object manifest", async () => {
  const spec = { ...tempSpec(), verifyManifest: true };
  let call = 0;
  await withFetchMock((async () => {
    call += 1;
    if (call === 1) return new Response("new");
    return new Response("null", { headers: { "content-type": "application/json" } });
  }) as typeof fetch, async () => {
    await assert.rejects(
      downloadReleaseAsset(spec, "data-test", "https://example/asset"),
      /manifest for data-test is invalid: manifest root must be an object/,
    );
  });
  assert.equal(existsSync(spec.localZip), false);
});

function tempSpec(): ReleaseSpec {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-test-"));
  return {
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName: "zh_CN.zip",
    localZip: join(root, "storyjson", "zh_CN.zip"),
  };
}

function tempArchiveSpec(assetName = "zh_CN-levels.zip"): ReleaseArchiveSpec {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-archive-test-"));
  return {
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName,
    localZip: join(root, "archives", assetName),
    localRoot: join(root, "gamedata-levels"),
    requiredFiles: ["zh_CN/gamedata/levels/enemydata/enemy_database.json"],
  };
}

function writeZip(path: string, entries: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const zip = new AdmZip();
  for (const [entryName, content] of Object.entries(entries)) {
    zip.addFile(entryName, Buffer.from(content, "utf-8"));
  }
  zip.writeZip(path);
}

function activeArchiveRoot(spec: ReleaseArchiveSpec): string {
  const meta = JSON.parse(
    readFileSync(join(dirname(spec.localZip), "extract_meta.json"), "utf-8"),
  ) as { data_root: string };
  return join(spec.localRoot, meta.data_root);
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

function withMirrors(mirrors: string | undefined, run: () => void): void {
  const originalMirrors = process.env["GITHUB_MIRRORS"];
  if (mirrors === undefined) delete process.env["GITHUB_MIRRORS"];
  else process.env["GITHUB_MIRRORS"] = mirrors;
  try {
    run();
  } finally {
    if (originalMirrors === undefined) delete process.env["GITHUB_MIRRORS"];
    else process.env["GITHUB_MIRRORS"] = originalMirrors;
  }
}

test("parseMirrors returns [] when GITHUB_MIRRORS is unset or empty", () => {
  withMirrors(undefined, () => assert.deepEqual(parseMirrors(), []));
  withMirrors("", () => assert.deepEqual(parseMirrors(), []));
});

test("parseMirrors strips all trailing slashes", () => {
  withMirrors("https://ghproxy.net/", () =>
    assert.deepEqual(parseMirrors(), ["https://ghproxy.net"]));
  withMirrors("https://ghproxy.net//", () =>
    assert.deepEqual(parseMirrors(), ["https://ghproxy.net"]));
});

test("parseMirrors trims surrounding whitespace", () => {
  withMirrors(" https://a.example , https://b.example ", () =>
    assert.deepEqual(parseMirrors(), ["https://a.example", "https://b.example"]));
});

test("parseMirrors trims whitespace and strips slashes together", () => {
  withMirrors(" https://a.example/ , https://b.example// ", () =>
    assert.deepEqual(parseMirrors(), ["https://a.example", "https://b.example"]));
});

test("parseMirrors drops blank and slash-only entries", () => {
  withMirrors("https://a, ,https://b", () =>
    assert.deepEqual(parseMirrors(), ["https://a", "https://b"]));
  withMirrors("https://a,,https://b", () =>
    assert.deepEqual(parseMirrors(), ["https://a", "https://b"]));
  withMirrors("https://a,///,https://b", () =>
    assert.deepEqual(parseMirrors(), ["https://a", "https://b"]));
});

function pairSpecs(root: string): readonly [ReleaseArchiveSpec, ReleaseArchiveSpec] {
  return [{
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName: "zh_CN-excel.zip",
    localZip: join(root, "gamedata", "archives", "zh_CN-excel.zip"),
    localRoot: join(root, "gamedata"),
    requiredFiles: ["zh_CN/gamedata/excel/character_table.json"],
  }, {
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName: "zh_CN-levels.zip",
    localZip: join(root, "gamedata-levels", "archives", "zh_CN-levels.zip"),
    localRoot: join(root, "gamedata-levels"),
    requiredFiles: ["zh_CN/gamedata/levels/enemydata/enemy_database.json"],
  }] as const;
}

function activatePairGeneration(
  specs: readonly [ReleaseArchiveSpec, ReleaseArchiveSpec],
  generation: string,
): void {
  for (const spec of specs) {
    const required = spec.requiredFiles[0];
    const dataRoot = join(spec.localRoot, ".releases", generation);
    mkdirSync(dirname(join(dataRoot, required)), { recursive: true });
    writeFileSync(join(dataRoot, required), generation, "utf-8");
    writeZip(spec.localZip, { [required]: generation });
    writeFileSync(join(dirname(spec.localZip), "release_meta.json"), JSON.stringify({
      repo: `${spec.owner}/${spec.repo}`,
      branch: "releases",
      commit_sha: generation,
      fetched_at: "2099-01-01T00:00:00.000Z",
      files: [spec.assetName],
    }), "utf-8");
    writeFileSync(join(dirname(spec.localZip), "extract_meta.json"), JSON.stringify({
      commit_sha: generation,
      data_root: `.releases/${generation}`,
    }), "utf-8");
  }
}

test("pair manifest is stable until the generation changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-pair-stability-test-"));
  const specs = pairSpecs(root);
  activatePairGeneration(specs, "same");
  const pairPath = join(root, ".gamedata_pair.json");
  process.env["GAMEDATA_PATH"] = specs[0].localRoot;
  try {
    __resetActivationForTesting();
    const first = await syncReleaseArchivePair(...specs);
    assert.deepEqual(first.map((result) => result.status), ["up_to_date", "up_to_date"]);
    checkActivationChange();
    let clears = 0;
    registerActivationListener(() => { clears += 1; });
    const before = statSync(pairPath);

    const second = await syncReleaseArchivePair(...specs);
    const after = statSync(pairPath);
    checkActivationChange();

    assert.deepEqual(second.map((result) => result.status), ["up_to_date", "up_to_date"]);
    assert.deepEqual(
      [after.ino, after.mtimeMs, after.ctimeMs],
      [before.ino, before.mtimeMs, before.ctimeMs],
    );
    assert.equal(clears, 0);

    activatePairGeneration(specs, "next");
    await syncReleaseArchivePair(...specs);
    const changed = statSync(pairPath);
    checkActivationChange();

    assert.equal(JSON.parse(readFileSync(pairPath, "utf-8")).commit_sha, "next");
    assert.notEqual(changed.ino, after.ino);
    assert.equal(clears, 1);
  } finally {
    delete process.env["GAMEDATA_PATH"];
  }
});

test("pair manifest is rebuilt when missing or invalid", async () => {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-pair-rebuild-test-"));
  const specs = pairSpecs(root);
  activatePairGeneration(specs, "same");
  const pairPath = join(root, ".gamedata_pair.json");

  await syncReleaseArchivePair(...specs);
  unlinkSync(pairPath);
  await syncReleaseArchivePair(...specs);
  assert.equal(JSON.parse(readFileSync(pairPath, "utf-8")).commit_sha, "same");

  writeFileSync(pairPath, "not json", "utf-8");
  await syncReleaseArchivePair(...specs);
  assert.equal(JSON.parse(readFileSync(pairPath, "utf-8")).commit_sha, "same");
});

test("pair manifest rebuild rejects mixed generations", async () => {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-pair-mixed-test-"));
  const specs = pairSpecs(root);
  activatePairGeneration(specs, "old");
  const excelRoot = join(specs[0].localRoot, ".releases", "new");
  const excelFile = join(excelRoot, specs[0].requiredFiles[0]);
  mkdirSync(dirname(excelFile), { recursive: true });
  writeFileSync(excelFile, "new", "utf-8");
  writeFileSync(join(dirname(specs[0].localZip), "extract_meta.json"), JSON.stringify({
    commit_sha: "new",
    data_root: ".releases/new",
  }), "utf-8");
  for (const spec of specs) unlinkSync(spec.localZip);

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const results = await syncReleaseArchivePair(...specs);
    assert.deepEqual(results.map((result) => result.status), [
      "offline_fallback",
      "offline_fallback",
    ]);
  });

  assert.equal(existsSync(join(root, ".gamedata_pair.json")), false);
});

test("pair manifest symlink is replaced", async () => {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-pair-symlink-test-"));
  const specs = pairSpecs(root);
  for (const spec of specs) {
    const required = join(spec.localRoot, spec.requiredFiles[0]);
    mkdirSync(dirname(required), { recursive: true });
    writeFileSync(required, "legacy", "utf-8");
  }
  const pairPath = join(root, ".gamedata_pair.json");
  const external = join(root, "external-pair.json");
  writeFileSync(external, JSON.stringify({
    commit_sha: "legacy",
    excel_data_root: ".",
    levels_data_root: ".",
  }), "utf-8");
  symlinkSync(external, pairPath);

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const results = await syncReleaseArchivePair(...specs);
    assert.deepEqual(results.map((result) => result.status), [
      "offline_fallback",
      "offline_fallback",
    ]);
  });

  const info = lstatSync(pairPath);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.deepEqual(
    JSON.parse(readFileSync(external, "utf-8")),
    JSON.parse(readFileSync(pairPath, "utf-8")),
  );
  assert.notEqual(statSync(external).ino, statSync(pairPath).ino);
});

test("syncRelease returns offline_fallback when network fails but zip exists", async () => {
  const spec = tempSpec();
  mkdirSync(dirname(spec.localZip), { recursive: true });
  writeFileSync(spec.localZip, "cached");

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncRelease(spec);

    assert.equal(result.status, "offline_fallback");
    assert.equal(result.commitSha, null);
    assert.equal(result.error, "Network unavailable");
  });
});

test("syncRelease reads Python release metadata", async () => {
  const spec = tempSpec();
  writeZip(spec.localZip, { "zh_CN/storyinfo.json": "{}" });
  writeFileSync(
    join(dirname(spec.localZip), "release_meta.json"),
    JSON.stringify({
      repo: "3aKHP/arknights-data-pipeline",
      branch: "releases",
      commit_sha: "same-sha",
      fetched_at: "2099-01-01T00:00:00.000Z",
      files: [spec.assetName],
    }),
    "utf-8",
  );
  let fetches = 0;

  await withFetchMock((async () => {
    fetches += 1;
    throw new Error("unexpected fetch");
  }) as typeof fetch, async () => {
    const result = await syncRelease(spec);
    assert.equal(result.status, "up_to_date");
    assert.equal(result.commitSha, "same-sha");
  });
  assert.equal(fetches, 0);
});

test("syncRelease serializes concurrent release checks", async () => {
  const spec = tempSpec();
  mkdirSync(dirname(spec.localZip), { recursive: true });
  writeFileSync(spec.localZip, "cached");
  let activeChecks = 0;
  let maxActiveChecks = 0;

  await withFetchMock((async () => {
    activeChecks += 1;
    maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    activeChecks -= 1;
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const results = await Promise.all([
      syncRelease(spec, true),
      syncRelease(spec, true),
    ]);
    assert.deepEqual(new Set(results.map((result) => result.status)), new Set([
      "offline_fallback",
    ]));
  });
  assert.equal(maxActiveChecks, 1);
});

test("syncRelease treats invalid validated zip as no_data", async () => {
  const spec = {
    ...tempSpec(),
    validateZip: () => ["zh_CN/storyinfo.json"],
  };
  mkdirSync(dirname(spec.localZip), { recursive: true });
  writeFileSync(spec.localZip, "cached");

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncRelease(spec);

    assert.equal(result.status, "no_data");
    assert.equal(result.commitSha, null);
    assert.equal(
      result.error,
      "Network unavailable and no cached zip; cached zip invalid: zh_CN/storyinfo.json",
    );
  });
});

test("syncRelease validates zip before fresh-cache fast path", async () => {
  const spec = {
    ...tempSpec(),
    validateZip: () => ["zh_CN/storyinfo.json"],
  };
  mkdirSync(dirname(spec.localZip), { recursive: true });
  writeFileSync(spec.localZip, "cached");
  writeFileSync(
    join(dirname(spec.localZip), "release_meta.json"),
    JSON.stringify({
      repo: "3aKHP/arknights-data-pipeline",
      branch: "releases",
      commitSha: "cached-sha",
      fetchedAt: new Date().toISOString(),
      files: ["zh_CN.zip"],
    }),
    "utf-8",
  );

  let fetchCalls = 0;
  await withFetchMock((async () => {
    fetchCalls += 1;
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncRelease(spec);

    assert.equal(fetchCalls, 1);
    assert.equal(result.status, "no_data");
    assert.equal(result.commitSha, null);
    assert.equal(
      result.error,
      "Network unavailable and no cached zip; cached zip invalid: zh_CN/storyinfo.json",
    );
  });
});

test("syncRelease rejects empty release metadata fields", async () => {
  const spec = tempSpec();
  mkdirSync(dirname(spec.localZip), { recursive: true });
  writeFileSync(spec.localZip, "cached");

  for (const metadata of [
    { commitSha: "", fetchedAt: new Date().toISOString() },
    { commitSha: "cached-sha", fetchedAt: "" },
  ]) {
    writeFileSync(
      join(dirname(spec.localZip), "release_meta.json"),
      JSON.stringify({
        repo: "3aKHP/arknights-data-pipeline",
        branch: "releases",
        ...metadata,
        files: ["zh_CN.zip"],
      }),
      "utf-8",
    );

    let fetchCalls = 0;
    await withFetchMock((async () => {
      fetchCalls += 1;
      throw new Error("network down");
    }) as typeof fetch, async () => {
      const result = await syncRelease(spec);

      assert.equal(fetchCalls, 1);
      assert.equal(result.status, "offline_fallback");
      assert.equal(result.commitSha, null);
    });
  }
});

test("syncRelease forced check bypasses fresh-cache fast path", async () => {
  const spec = tempSpec();
  mkdirSync(dirname(spec.localZip), { recursive: true });
  writeFileSync(spec.localZip, "cached");
  writeFileSync(
    join(dirname(spec.localZip), "release_meta.json"),
    JSON.stringify({
      repo: "3aKHP/arknights-data-pipeline",
      branch: "releases",
      commitSha: "cached-sha",
      fetchedAt: new Date().toISOString(),
      files: ["zh_CN.zip"],
    }),
    "utf-8",
  );

  let fetchCalls = 0;
  await withFetchMock((async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify([
        {
          tag_name: "data-cached-sha",
          created_at: "2026-01-01T00:00:00Z",
          assets: [{
            name: "zh_CN.zip",
            browser_download_url: "https://example.test/zh_CN.zip",
          }],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch, async () => {
    const result = await syncRelease(spec, true);

    assert.equal(fetchCalls, 1);
    assert.equal(result.status, "up_to_date");
    assert.equal(result.commitSha, "cached-sha");
  });
});

test("syncRelease converts zip validation exceptions to no_data", async () => {
  const spec = {
    ...tempSpec(),
    validateZip: () => {
      throw new Error("bad zip");
    },
  };
  mkdirSync(dirname(spec.localZip), { recursive: true });
  writeFileSync(spec.localZip, "cached");

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncRelease(spec);

    assert.equal(result.status, "no_data");
    assert.match(result.error ?? "", /cached zip invalid: .* is not a valid zip: bad zip/);
  });
});

test("syncRelease returns no_data when network fails and no zip exists", async () => {
  const spec = tempSpec();

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncRelease(spec);

    assert.equal(result.status, "no_data");
    assert.equal(result.commitSha, null);
    assert.equal(result.error, "Network unavailable and no cached zip");
  });
});

test("syncReleaseArchive extracts updated archive", async () => {
  const spec = tempArchiveSpec();
  writeZip(spec.localZip, {
    "zh_CN/gamedata/levels/enemydata/enemy_database.json": "{\"enemies\":[]}",
  });

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncReleaseArchive(spec);

    assert.equal(result.status, "updated");
    assert.match(result.commitSha ?? "", /^local-/);
  });
});

test("syncReleaseArchive verifies the factory manifest before activation", async () => {
  const spec = { ...tempArchiveSpec(), verifyManifest: true };
  const required = spec.requiredFiles[0];
  const assetPath = join(dirname(spec.localZip), "asset.zip");
  writeZip(assetPath, { [required]: "new" });
  const asset = readFileSync(assetPath);
  let call = 0;

  await withFetchMock((async (input: RequestInfo | URL) => {
    call += 1;
    const url = String(input);
    if (call === 1) {
      assert.match(url, /api\.github\.com\/repos\/3aKHP\/arknights-data-pipeline\/releases\?per_page=100$/);
      return new Response(JSON.stringify([
        {
          tag_name: "data-new",
          created_at: "2026-01-01T00:00:00Z",
          assets: [{ name: spec.assetName, browser_download_url: "https://example/asset" }],
        },
      ]), { headers: { "content-type": "application/json" } });
    }
    if (call === 2) {
      assert.equal(url, "https://example/asset");
      return new Response(asset);
    }
    assert.match(url, /releases\/download\/data-new\/manifest\.json$/);
    return new Response(JSON.stringify({
      contractVersion: "prts-mcp-data/v1",
      source: { versionId: "new" },
      assets: { [spec.assetName]: { size: asset.byteLength, sha256: "bad" } },
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch, async () => {
    const result = await syncReleaseArchive(spec, true);
    assert.equal(result.status, "no_data");
    assert.match(result.error ?? "", /manifest mismatch/);
  });
  assert.equal(existsSync(spec.localZip), false);
  assert.equal(existsSync(join(spec.localRoot, required)), false);
});

test("syncReleaseArchive returns no_data when zip misses required entries", async () => {
  const spec = tempArchiveSpec();
  writeZip(spec.localZip, {
    "zh_CN/gamedata/levels/obt/main/level_main_00-01.json": "{}",
  });

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncReleaseArchive(spec);

    assert.equal(result.status, "no_data");
    assert.match(result.error ?? "", /enemy_database\.json/);
  });
});

test("syncReleaseArchive retries activation after extraction failure", async () => {
  const spec = tempArchiveSpec();
  const required = spec.requiredFiles[0];
  writeZip(spec.localZip, {
    [required]: '{"version":"new"}',
  });
  writeFileSync(
    join(dirname(spec.localZip), "release_meta.json"),
    JSON.stringify({
      repo: "3aKHP/arknights-data-pipeline",
      branch: "releases",
      commitSha: "abc123",
      fetchedAt: new Date().toISOString(),
      files: [spec.assetName],
    }),
    "utf-8",
  );
  const requiredPath = join(spec.localRoot, required);
  mkdirSync(dirname(requiredPath), { recursive: true });
  writeFileSync(requiredPath, '{"version":"old"}', "utf-8");
  const blocker = join(spec.localRoot, ".releases");
  writeFileSync(blocker, "not a directory", "utf-8");
  const extractMeta = join(dirname(spec.localZip), "extract_meta.json");

  const first = await syncReleaseArchive(spec);

  assert.equal(first.status, "offline_fallback");
  assert.equal(existsSync(extractMeta), false);

  unlinkSync(blocker);
  const second = await syncReleaseArchive(spec);

  assert.equal(second.status, "updated");
  assert.equal(readFileSync(requiredPath, "utf-8"), '{"version":"old"}');
  assert.equal(
    readFileSync(join(activeArchiveRoot(spec), required), "utf-8"),
    '{"version":"new"}',
  );
  assert.equal(JSON.parse(readFileSync(extractMeta, "utf-8")).commit_sha, "abc123");
});

test("syncReleaseArchive reports updated after offline activation recovery", async () => {
  const spec = tempArchiveSpec();
  const required = spec.requiredFiles[0];
  writeZip(spec.localZip, { [required]: '{"version":"new"}' });
  writeFileSync(
    join(dirname(spec.localZip), "release_meta.json"),
    JSON.stringify({
      repo: "3aKHP/arknights-data-pipeline",
      branch: "releases",
      commitSha: "abc123",
      fetchedAt: "2000-01-01T00:00:00.000Z",
      files: [spec.assetName],
    }),
    "utf-8",
  );
  const requiredPath = join(spec.localRoot, required);
  mkdirSync(dirname(requiredPath), { recursive: true });
  writeFileSync(requiredPath, '{"version":"old"}', "utf-8");

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncReleaseArchive(spec, true);

    assert.equal(result.status, "updated");
    assert.equal(result.commitSha, "abc123");
    assert.equal(readFileSync(requiredPath, "utf-8"), '{"version":"old"}');
    assert.equal(
      readFileSync(join(activeArchiveRoot(spec), required), "utf-8"),
      '{"version":"new"}',
    );
  });
});

test("syncReleaseArchive rejects a symlinked release directory", async () => {
  const spec = tempArchiveSpec();
  const required = spec.requiredFiles[0];
  writeZip(spec.localZip, { [required]: "{}" });
  const outside = join(dirname(spec.localRoot), "outside");
  mkdirSync(outside);
  mkdirSync(spec.localRoot);
  symlinkSync(outside, join(spec.localRoot, ".releases"), "dir");

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncReleaseArchive(spec);
    assert.equal(result.status, "no_data");
    assert.match(result.error ?? "", /Unsafe release directory symlink/);
  });
});

test("syncReleaseArchive reclaims an abandoned ownerless lock", async () => {
  const spec = tempArchiveSpec();
  const required = spec.requiredFiles[0];
  writeZip(spec.localZip, { [required]: "{}" });
  const lock = join(dirname(spec.localZip), ".activation.lock");
  mkdirSync(lock);
  const abandoned = new Date(Date.now() - 11_000);
  utimesSync(lock, abandoned, abandoned);

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const result = await syncReleaseArchive(spec);
    assert.equal(result.status, "updated");
    assert.equal(existsSync(lock), false);
  });
});

test("live owner heartbeat prevents stale lock takeover", async () => {
  const spec = tempArchiveSpec();
  mkdirSync(dirname(spec.localZip), { recursive: true });
  let releaseFirst: (() => void) | undefined;
  let secondEntered = false;
  let resolveEntered: (() => void) | undefined;
  const firstEntered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const first = withArchiveActivationLock(
    spec,
    () => new Promise<void>((resolve) => {
      releaseFirst = resolve;
      resolveEntered?.();
    }),
    ".activation.lock",
    { timeoutMs: 1_000, staleMs: 40, ownerGraceMs: 10, heartbeatMs: 10 },
  );
  await firstEntered;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  const second = withArchiveActivationLock(
    spec,
    async () => { secondEntered = true; },
    ".activation.lock",
    { timeoutMs: 1_000, staleMs: 40, ownerGraceMs: 10, heartbeatMs: 10 },
  );
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  assert.equal(secondEntered, false);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});

test("activation lock wait times out with ActivationLockTimeoutError", async () => {
  const spec = tempArchiveSpec();
  mkdirSync(dirname(spec.localZip), { recursive: true });
  let releaseFirst: (() => void) | undefined;
  let resolveEntered: (() => void) | undefined;
  const firstEntered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const first = withArchiveActivationLock(
    spec,
    () => new Promise<void>((resolve) => {
      releaseFirst = resolve;
      resolveEntered?.();
    }),
    ".activation.lock",
    { timeoutMs: 60_000, staleMs: 60_000, ownerGraceMs: 60_000, heartbeatMs: 1_000 },
  );
  await firstEntered;
  // Fresh lock held by the first contender → never stale-reclaimed; the
  // zero budget makes the deadline check fire on the first EEXIST iteration.
  await assert.rejects(
    withArchiveActivationLock(
      spec,
      async () => {},
      ".activation.lock",
      { timeoutMs: 0, staleMs: 60_000, ownerGraceMs: 60_000, heartbeatMs: 1_000 },
    ),
    (err: unknown) => err instanceof ActivationLockTimeoutError
      && /Timed out waiting for archive activation lock/.test((err as Error).message),
  );
  // The contender must not have reclaimed or removed the live lock.
  assert.equal(existsSync(join(dirname(spec.localZip), ".activation.lock")), true);
  releaseFirst?.();
  await first;
});

test("pair manifest switches only after both archives share one SHA", async () => {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-pair-test-"));
  const excelRequired = "zh_CN/gamedata/excel/character_table.json";
  const levelsRequired = "zh_CN/gamedata/levels/enemydata/enemy_database.json";
  const excelSpec: ReleaseArchiveSpec = {
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName: "zh_CN-excel.zip",
    localZip: join(root, "gamedata", "archives", "zh_CN-excel.zip"),
    localRoot: join(root, "gamedata"),
    requiredFiles: [excelRequired],
  };
  const levelsSpec: ReleaseArchiveSpec = {
    owner: "3aKHP",
    repo: "arknights-data-pipeline",
    assetName: "zh_CN-levels.zip",
    localZip: join(root, "gamedata-levels", "archives", "zh_CN-levels.zip"),
    localRoot: join(root, "gamedata-levels"),
    requiredFiles: [levelsRequired],
  };
  for (const [spec, required] of [
    [excelSpec, excelRequired],
    [levelsSpec, levelsRequired],
  ] as const) {
    const path = join(spec.localRoot, required);
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(dirname(spec.localZip), { recursive: true });
    writeFileSync(path, "old", "utf-8");
    writeFileSync(
      join(dirname(spec.localZip), "release_meta.json"),
      JSON.stringify({
        repo: "3aKHP/arknights-data-pipeline",
        branch: "releases",
        commit_sha: "new",
        fetched_at: "2099-01-01T00:00:00Z",
        files: [spec.assetName],
      }),
      "utf-8",
    );
  }
  writeZip(excelSpec.localZip, { [excelRequired]: "new" });
  writeZip(levelsSpec.localZip, { "wrong/path.json": "new" });

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const [, levelsResult] = await syncReleaseArchivePair(excelSpec, levelsSpec);
    assert.equal(levelsResult.status, "offline_fallback");
  });
  const pairPath = join(root, ".gamedata_pair.json");
  let pair = JSON.parse(readFileSync(pairPath, "utf-8")) as {
    commit_sha: string;
    excel_data_root: string;
    levels_data_root: string;
  };
  assert.equal(pair.commit_sha, "legacy");
  assert.equal(pair.excel_data_root, ".");
  assert.equal(pair.levels_data_root, ".");

  writeZip(levelsSpec.localZip, { [levelsRequired]: "new" });
  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    await syncReleaseArchivePair(excelSpec, levelsSpec);
  });
  pair = JSON.parse(readFileSync(pairPath, "utf-8"));
  assert.equal(pair.commit_sha, "new");
  assert.match(pair.excel_data_root, /^\.releases\//);
  assert.match(pair.levels_data_root, /^\.releases\//);
});

test("syncReleaseArchive prunes stale staging without a new release", async () => {
  const spec = tempArchiveSpec();
  const required = spec.requiredFiles[0];
  writeZip(spec.localZip, { [required]: "{}" });

  await withFetchMock((async () => {
    throw new Error("network down");
  }) as typeof fetch, async () => {
    assert.equal((await syncReleaseArchive(spec)).status, "updated");
    const orphan = join(spec.localRoot, ".releases", ".orphan.tmp");
    mkdirSync(orphan);
    const stale = new Date(Date.now() - 25 * 60 * 60_000);
    utimesSync(orphan, stale, stale);

    assert.equal((await syncReleaseArchive(spec)).status, "offline_fallback");
    assert.equal(existsSync(orphan), false);
  });
});

test("concurrent archive activation keeps the authoritative tree", async () => {
  const spec = tempArchiveSpec();
  const required = spec.requiredFiles[0];
  writeZip(spec.localZip, { [required]: "{}" });

  let activeChecks = 0;
  let maxActiveChecks = 0;
  await withFetchMock((async () => {
    activeChecks += 1;
    maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    activeChecks -= 1;
    throw new Error("network down");
  }) as typeof fetch, async () => {
    const results = await Promise.all([
      syncReleaseArchive(spec),
      syncReleaseArchive(spec),
    ]);
    assert.deepEqual(new Set(results.map((result) => result.status)), new Set([
      "updated",
      "offline_fallback",
    ]));
    assert.equal(existsSync(join(activeArchiveRoot(spec), required)), true);
    assert.equal(existsSync(join(dirname(spec.localZip), ".activation.lock")), false);
  });
  assert.equal(maxActiveChecks, 1);
});
