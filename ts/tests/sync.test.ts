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
