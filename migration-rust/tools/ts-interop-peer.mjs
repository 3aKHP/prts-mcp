//! TS-side interop peer for the P2 shared-volume tests. Runs REAL frozen TS
//! code (the oracle dist build) against a volume the Rust side owns or wrote.
//! The fetch mock must be installed before the dist modules load (transport
//! captures NATIVE_FETCH at import time), so all imports are dynamic.
//
// Modes:
//   write-pair <root>            activate a gamedata pair via syncReleaseArchivePair
//                                (network down; local zips + fresh release_meta pre-exist)
//   read-volume <root>           loadConfig() + DirectoryStore read of the volume
//   download-release <zip> <asset-file> <tag>
//                                downloadReleaseAsset with a mocked fetch
//   hold-lock <dir> <name> <holdMs>
//   try-lock <dir> <name> <timeoutMs>
//
// Output: one JSON line on stdout ("result": ...); errors exit non-zero.

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = `${ROOT}.reference/ts-v2.8.1/ts/dist`;

function networkDownFetch() {
  return async () => {
    throw new Error("network down (interop mock)");
  };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  switch (mode) {
    case "images-sync": {
      // Real fetch, no mock: GITHUB_MIRRORS mirror + a dead https proxy so
      // ONLY the mirror is reachable (the undici proxy branch).
      const [imageDir, mirrorPort] = args;
      process.env["GITHUB_MIRRORS"] = `http://127.0.0.1:${mirrorPort}`;
      process.env["https_proxy"] = "http://127.0.0.1:9";
      process.env["HTTPS_PROXY"] = "http://127.0.0.1:9";
      const { syncImages } = await import(`${DIST}/sync/imagesSync.js`);
      const result = await syncImages(imageDir, { includeOriginal: false, forceCheck: false });
      console.log(JSON.stringify({ result: { status: result.status, commitSha: result.commitSha, error: result.error } }));
      return;
    }
    case "images-active": {
      const [imageDir] = args;
      const { activeGenerationSync } = await import(`${DIST}/sync/generationStore.js`);
      const { parseIndex } = await import(`${DIST}/data/images.js`);
      const fs = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const gen = activeGenerationSync(imageDir);
      if (gen === null) {
        console.log(JSON.stringify({ result: { active: null } }));
        return;
      }
      const index = parseIndex(JSON.parse(await fs.readFile(`${gen}/index.json`, "utf8")));
      const ids = index ? Object.keys(index.artworks).sort() : null;
      // Hash every PNG to prove the full tree is readable.
      const hashes = {};
      if (index) {
        for (const sid of ids) {
          for (const [v, meta] of Object.entries(index.artworks[sid].variants)) {
            const bytes = await fs.readFile(`${gen}/${meta.file}`);
            hashes[`${sid}|${v}`] = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
          }
        }
      }
      console.log(JSON.stringify({
        result: {
          active: gen,
          currentVersion: index?.currentVersion ?? null,
          baselineVersion: index?.baselineVersion ?? null,
          artworks: ids,
          hashes,
        },
      }));
      return;
    }
    case "images-fullsync": {
      // Real network full-scale sync (P6 measurement): direct GitHub, no
      // mirror, no proxy. Prints the sync result plus VmHWM/VmRSS.
      const [imageDir, includeOriginal] = args;
      process.env["GITHUB_MIRRORS"] = "";
      delete process.env["https_proxy"];
      delete process.env["HTTPS_PROXY"];
      const started = Date.now();
      const { syncImages } = await import(`${DIST}/sync/imagesSync.js`);
      const result = await syncImages(imageDir, { includeOriginal: includeOriginal === "true", forceCheck: false });
      const status = await import("node:fs/promises").then((fs) => fs.readFile("/proc/self/status", "utf8"));
      const hwm = status.match(/^VmHWM:\s+(\d+) kB/m)?.[1];
      const rss = status.match(/^VmRSS:\s+(\d+) kB/m)?.[1];
      console.log(JSON.stringify({ result: { status: result.status, commitSha: result.commitSha, error: result.error }, durationMs: Date.now() - started, vmHwmKb: Number(hwm), vmRssKb: Number(rss) }));
      return;
    }
    case "sync-bench": {
      // Real transport (no fetch mock): runStartupSync against the local
      // mirror via GITHUB_MIRRORS + a dead https proxy (undici proxy branch).
      const [xdgRoot, mirrorPort] = args;
      process.env["XDG_DATA_HOME"] = xdgRoot;
      process.env["GITHUB_MIRRORS"] = `http://127.0.0.1:${mirrorPort}`;
      delete process.env["GAMEDATA_PATH"];
      delete process.env["STORYJSON_PATH"];
      const { runStartupSync } = await import(`${DIST}/startupSync.js`);
      await runStartupSync(false);
      const status = await import("node:fs/promises").then((fs) =>
        fs.readFile("/proc/self/status", "utf-8"),
      );
      const hwm = status.match(/^VmHWM:\s+(\d+) kB/m)?.[1];
      const rss = status.match(/^VmRSS:\s+(\d+) kB/m)?.[1];
      console.log(JSON.stringify({ result: "ok", vmHwmKb: Number(hwm), vmRssKb: Number(rss) }));
      return;
    }
    case "write-pair": {
      globalThis.fetch = networkDownFetch();
      process.env["GITHUB_MIRRORS"] = "";
      const { syncReleaseArchivePair } = await import(`${DIST}/sync/gamedataPair.js`);
      const root = args[0];
      const spec = (assetName, localRoot, required) => ({
        owner: "3aKHP",
        repo: "arknights-data-pipeline",
        assetName,
        localZip: join(localRoot, "archives", assetName),
        localRoot,
        requiredFiles: [required],
      });
      const excel = spec(
        "zh_CN-excel.zip",
        join(root, "gamedata"),
        "zh_CN/gamedata/excel/character_table.json",
      );
      const levels = spec(
        "zh_CN-levels.zip",
        join(root, "gamedata-levels"),
        "zh_CN/gamedata/levels/enemydata/enemy_database.json",
      );
      const results = await syncReleaseArchivePair(excel, levels, false);
      console.log(JSON.stringify({
        result: "ok",
        statuses: results.map((r) => r.status),
        commitShas: results.map((r) => r.commitSha),
      }));
      return;
    }
    case "read-volume": {
      const root = args[0];
      process.env["GAMEDATA_PATH"] = join(root, "gamedata");
      const { loadConfig } = await import(`${DIST}/config.js`);
      const { DirectoryStore } = await import(`${DIST}/data/stores.js`);
      const cfg = loadConfig();
      const store = cfg.effectiveExcelPath
        ? new DirectoryStore(cfg.effectiveExcelPath)
        : null;
      const table = store
        ? store.readJson("character_table.json")
        : null;
      console.log(JSON.stringify({
        result: "ok",
        excelPath: cfg.excelPath,
        effectiveExcelPath: cfg.effectiveExcelPath,
        effectiveLevelsPath: cfg.effectiveLevelsPath,
        storyjsonZip: cfg.storyjsonZip,
        effectiveStoryjsonZip: cfg.effectiveStoryjsonZip,
        characterIds: table ? Object.keys(table) : null,
        levelsEnemyDatabase: cfg.effectiveLevelsPath
          ? new DirectoryStore(cfg.effectiveLevelsPath)
              .readJson("zh_CN/gamedata/levels/enemydata/enemy_database.json")
          : null,
      }));
      return;
    }
    case "download-release": {
      const [zipPath, assetFile, tag] = args;
      const assetBytes = await import("node:fs/promises").then((fs) => fs.readFile(assetFile));
      let calls = 0;
      globalThis.fetch = async (input) => {
        calls += 1;
        if (calls === 1) return new Response(assetBytes);
        return new Response("missing", { status: 404 });
      };
      process.env["GITHUB_MIRRORS"] = "";
      const { downloadReleaseAsset } = await import(`${DIST}/sync/release.js`);
      const { dirname } = await import("node:path");
      await downloadReleaseAsset(
        {
          owner: "3aKHP",
          repo: "arknights-data-pipeline",
          assetName: "zh_CN.zip",
          localZip: zipPath,
          verifyManifest: true,
        },
        tag,
        "https://example.test/asset",
      );
      const fs = await import("node:fs/promises");
      const meta = await fs.readFile(`${dirname(zipPath)}/release_meta.json`, "utf-8");
      console.log(JSON.stringify({ result: "ok", releaseMeta: meta, calls }));
      return;
    }
    case "hold-lock":
    case "try-lock": {
      const [dir, name, ms] = args;
      const { withArchiveActivationLock } = await import(`${DIST}/sync/releaseActivation.js`);
      const timing =
        mode === "hold-lock"
          ? { timeoutMs: 60_000, staleMs: 60_000, ownerGraceMs: 60_000, heartbeatMs: 50 }
          : { timeoutMs: Number(ms), staleMs: 60_000, ownerGraceMs: 60_000, heartbeatMs: 50 };
      try {
        if (mode === "hold-lock") {
          await withArchiveActivationLock(
            { localZip: join(dir, "peer") },
            async () => {
              // Printed only once the lock is actually held.
              console.log(JSON.stringify({ result: "acquired" }));
              await new Promise((resolve) => setTimeout(resolve, Number(ms)));
            },
            name,
            timing,
          );
          console.log(JSON.stringify({ result: "released" }));
        } else {
          await withArchiveActivationLock({ localZip: join(dir, "peer") }, async () => {}, name, timing);
          console.log(JSON.stringify({ result: "acquired" }));
        }
      } catch (err) {
        console.log(JSON.stringify({
          result: "timeout",
          error: err instanceof Error ? err.message : String(err),
        }));
      }
      return;
    }
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

function join(...parts) {
  // Minimal path.join for POSIX test hosts.
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
