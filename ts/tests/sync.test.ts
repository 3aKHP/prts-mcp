import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncRelease, type ReleaseSpec } from "../src/data/sync.ts";

function tempSpec(): ReleaseSpec {
  const root = mkdtempSync(join(tmpdir(), "prts-sync-test-"));
  return {
    owner: "3aKHP",
    repo: "ArknightsStoryJson",
    assetName: "zh_CN.zip",
    localZip: join(root, "storyjson", "zh_CN.zip"),
  };
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
