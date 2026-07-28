import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { syncRelease, syncReleaseArchive, type ReleaseArchiveSpec, type ReleaseSpec } from "../src/data/sync.ts";

function tempSpec(): ReleaseSpec {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-test-"));
  return {
    owner: "3aKHP",
    repo: "ArknightsStoryJson",
    assetName: "zh_CN.zip",
    localZip: join(root, "storyjson", "zh_CN.zip"),
  };
}

function tempArchiveSpec(assetName = "zh_CN-levels.zip"): ReleaseArchiveSpec {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-archive-test-"));
  return {
    owner: "3aKHP",
    repo: "ArknightsGameData",
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
      repo: "3aKHP/ArknightsStoryJson",
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
      repo: "3aKHP/ArknightsStoryJson",
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

test("syncRelease forced check bypasses fresh-cache fast path", async () => {
  const spec = tempSpec();
  mkdirSync(dirname(spec.localZip), { recursive: true });
  writeFileSync(spec.localZip, "cached");
  writeFileSync(
    join(dirname(spec.localZip), "release_meta.json"),
    JSON.stringify({
      repo: "3aKHP/ArknightsStoryJson",
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
      JSON.stringify({
        tag_name: "upstream-cached-sha",
        assets: [{
          name: "zh_CN.zip",
          browser_download_url: "https://example.test/zh_CN.zip",
        }],
      }),
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
      repo: "3aKHP/ArknightsGameData",
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
      repo: "3aKHP/ArknightsGameData",
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
