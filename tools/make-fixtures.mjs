#!/usr/bin/env node
/**
 * Build the deterministic minimal GameData fixture and record the P0 data
 * manifest (contracts/data-manifest.json).
 *
 * The stage/zone/item tables mirror the shapes used by the frozen TS tests
 * (ts/tests/stage.test.ts writeFixtures) so the oracle's list_stages path is
 * exercised with realistic entries while staying small and byte-stable.
 * The four REQUIRED_OPERATOR_FILES are "{}" sentinels — filesComplete() only
 * checks existence; no operator tool reads them in the P1 scope.
 *
 * Usage: node tools/make-fixtures.mjs [--skip-release-probe]
 *   --skip-release-probe  do not query the GitHub API (offline mode); the
 *                         manifest then records the probe as not-run.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REFERENCE = join(ROOT, ".reference", "ts-v2.8.1");
const FIXTURE_ROOT = join(ROOT, ".runtime", "fixtures", "minimal-gamedata-v1");
const MANIFEST_PATH = join(ROOT, "contracts", "data-manifest.json");
const UPSTREAM_REPO = "3aKHP/arknights-data-pipeline";
const SKIP_RELEASE_PROBE = process.argv.includes("--skip-release-probe");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeFixture(relPath, data) {
  const target = join(FIXTURE_ROOT, relPath);
  mkdirSync(dirname(target), { recursive: true });
  const text = typeof data === "string" ? data : JSON.stringify(data);
  writeFileSync(target, text, "utf-8");
}

// --- stage_table / zone_table / item_table: lifted from the frozen TS test
// fixture (ts/tests/stage.test.ts @ e0ba360) so the differential corpus matches
// what the oracle's own tests consider representative shapes. ---------------

const STAGE_TABLE = {
  stages: {
    "main_00-01": {
      stageId: "main_00-01",
      code: "0-1",
      name: "坍塌",
      stageType: "MAIN",
      difficulty: "NORMAL",
      zoneId: "main_0",
      levelId: "Obt/Main/level_main_00-01",
      apCost: 6,
      dangerLevel: "LV.1",
      description: "三点方向出现了敌人的先锋部队。",
      stageDropInfo: {
        displayRewards: [{ type: "TKT_RECRUIT", id: "7001", dropType: "ONCE" }],
      },
      unlockCondition: [],
      hardStagedId: "main_00-01#f#",
      bossMark: false,
    },
    "main_00-01#f#": {
      stageId: "main_00-01#f#",
      code: "TR-1",
      name: "坍塌·突袭",
      stageType: "MAIN",
      difficulty: "FOUR_STAR",
      zoneId: "main_0",
      levelId: "Obt/Main/level_main_00-01",
      apCost: 9,
      dangerLevel: "LV.2",
      description: "<@lv.fs>突袭条件</>：敌方生命值提升。",
      stageDropInfo: null,
      unlockCondition: [{ stageId: "main_00-01", completeState: "STAR_3" }],
      hardStagedId: null,
      bossMark: true,
    },
    "act31side_01": {
      stageId: "act31side_01",
      code: "AS-1",
      name: "测试活动关",
      stageType: "ACTIVITY",
      difficulty: "NORMAL",
      zoneId: "act31side_zone1",
      levelId: null,
      apCost: 12,
      dangerLevel: "NORMAL",
      description: "",
      unlockCondition: [{ stageId: "act31side_02", completeState: "PASS" }],
      hardStagedId: null,
      bossMark: false,
    },
    "daily_01": {
      stageId: "daily_01",
      code: "CE-5",
      name: "货物运送",
      stageType: "DAILY",
      difficulty: "NORMAL",
      zoneId: "daily_zone1",
      levelId: "Activities/Daily/level_daily_01",
      apCost: 30,
      dangerLevel: "ELITE",
      description: "高资源产出的每日关卡。",
      stageDropInfo: {
        displayRewards: [
          { type: "GOLD", dropType: "ONCE" },
          { type: "CARD_EXP", dropType: "ONCE" },
        ],
      },
      unlockCondition: [],
      hardStagedId: null,
      bossMark: false,
    },
  },
};

const ZONE_TABLE = {
  zones: {
    main_0: {
      zoneID: "main_0",
      zoneNameFirst: "序章",
      zoneNameSecond: "黑暗时代·上",
    },
    act31side_zone1: {
      zoneID: "act31side_zone1",
      zoneNameFirst: "火山旅梦",
      zoneNameSecond: null,
    },
    daily_zone1: {
      zoneID: "daily_zone1",
      zoneNameFirst: null,
      zoneNameSecond: null,
    },
  },
};

const ITEM_TABLE = {
  items: {
    "7001": {
      itemId: "7001",
      name: "招聘许可",
      hideInItemGet: false,
      classifyType: "NORMAL",
      itemType: "TKT_RECRUIT",
    },
  },
};

// --- build --------------------------------------------------------------------

rmSync(FIXTURE_ROOT, { recursive: true, force: true });
const EXCEL = "zh_CN/gamedata/excel";for (const sentinel of [
  "character_table.json",
  "handbook_info_table.json",
  "charword_table.json",
  "story_review_table.json",
]) {
  writeFixture(join(EXCEL, sentinel), {});
}
writeFixture(join(EXCEL, "stage_table.json"), STAGE_TABLE);
writeFixture(join(EXCEL, "zone_table.json"), ZONE_TABLE);
writeFixture(join(EXCEL, "item_table.json"), ITEM_TABLE);

// Empty dataset for missing-data / service-still-starts differential cases.
const EMPTY_ROOT = join(ROOT, ".runtime", "fixtures", "empty-gamedata-v1");
rmSync(EMPTY_ROOT, { recursive: true, force: true });
mkdirSync(EMPTY_ROOT, { recursive: true });
writeFileSync(join(EMPTY_ROOT, ".keep"), "", "utf-8");

// --- activated-minimal-v1: a generation volume written by the REAL frozen TS
// sync code (dist syncReleaseArchivePair, offline, local zips + fresh
// release_meta), so differential cases prove both implementations resolve the
// same pair-pointer layout (P2). The generation UUIDs are random; the served
// content equals minimal-gamedata-v1, so list_stages output stays stable.

const ACTIVATED_ROOT = join(ROOT, ".runtime", "fixtures", "activated-minimal-v1");
const ACTIVATED_TAG = "26-10-10-00-00-00_cafe01";
rmSync(ACTIVATED_ROOT, { recursive: true, force: true });

const AdmZip = (await import(
  join(REFERENCE, "ts", "node_modules", "adm-zip", "adm-zip.js")
)).default;

function buildZip(zipPath, entries) {
  const zip = new AdmZip();
  for (const [name, content] of entries) {
    zip.addFile(name, Buffer.from(content, "utf-8"));
  }
  mkdirSync(dirname(zipPath), { recursive: true });
  zip.writeZip(zipPath);
}

const excelZipPath = join(ACTIVATED_ROOT, "gamedata", "archives", "zh_CN-excel.zip");
const levelsZipPath = join(ACTIVATED_ROOT, "gamedata-levels", "archives", "zh_CN-levels.zip");
const fixtureFile = (name) => readFileSync(join(FIXTURE_ROOT, EXCEL, name), "utf-8");
buildZip(
  excelZipPath,
  [
    "character_table.json",
    "handbook_info_table.json",
    "charword_table.json",
    "story_review_table.json",
    "enemy_handbook_table.json",
    "building_data.json",
    "skin_table.json",
    "skill_table.json",
  ].map((name) => [`zh_CN/gamedata/excel/${name}`, "{}"])
    .concat([
      ["zh_CN/gamedata/excel/stage_table.json", fixtureFile("stage_table.json")],
      ["zh_CN/gamedata/excel/zone_table.json", fixtureFile("zone_table.json")],
      ["zh_CN/gamedata/excel/item_table.json", fixtureFile("item_table.json")],
    ]),
);
buildZip(levelsZipPath, [
  ["zh_CN/gamedata/levels/enemydata/enemy_database.json", "{}"],
]);
for (const [zipDir, asset] of [
  [dirname(excelZipPath), "zh_CN-excel.zip"],
  [dirname(levelsZipPath), "zh_CN-levels.zip"],
]) {
  writeFileSync(
    join(zipDir, "release_meta.json"),
    JSON.stringify({
      repo: UPSTREAM_REPO,
      branch: "releases",
      commit_sha: ACTIVATED_TAG,
      fetched_at: "2099-01-01T00:00:00.000Z",
      files: [asset],
    }, null, 2),
    "utf-8",
  );
}

const peerRun = spawnSync(
  process.execPath,
  [join(ROOT, "tools", "ts-interop-peer.mjs"), "write-pair", ACTIVATED_ROOT],
  { encoding: "utf-8", env: { PATH: process.env.PATH, HOME: process.env.HOME } },
);
if (peerRun.status !== 0) {
  throw new Error(`write-pair peer failed: ${peerRun.stderr}`);
}
const pairActivation = JSON.parse(
  peerRun.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop(),
);
if (pairActivation.statuses.some((s) => s !== "updated")) {
  throw new Error(`unexpected activation statuses: ${peerRun.stdout}`);
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out.sort();
}

const fixtureFiles = walkFiles(FIXTURE_ROOT).map((p) => ({
  path: relative(FIXTURE_ROOT, p),
  bytes: statSync(p).size,
  sha256: sha256(p),
}));

// --- bundled sample data (repo `data/gamedata`, fixed tag) --------------------

const bundledDir = join(REFERENCE, "data", "gamedata");
const bundledFiles = existsSync(bundledDir)
  ? walkFiles(bundledDir)
      .filter((p) => p.endsWith(".json"))
      .map((p) => ({
        path: relative(bundledDir, p),
        bytes: statSync(p).size,
        sha256: sha256(p),
      }))
  : [];

// --- upstream release probe (records the data-package version axis; no
// archives are downloaded here — full-data snapshots land in later phases) ----

let releaseProbe;
if (SKIP_RELEASE_PROBE) {
  releaseProbe = { status: "not-run", reason: "--skip-release-probe" };
} else {
  try {
    const raw = execFileSync(
      "curl",
      [
        "-sS", "--max-time", "20",
        "-H", "Accept: application/vnd.github+json",
        `https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=10`,
      ],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
    );
    const releases = JSON.parse(raw);
    releaseProbe = {
      status: "ok",
      probed_at: new Date().toISOString().slice(0, 10),
      releases: releases.map((r) => ({
        tag_name: r.tag_name,
        published_at: r.published_at,
        assets: (r.assets ?? []).map((a) => ({
          name: a.name,
          size: a.size,
          browser_download_url: a.browser_download_url,
        })),
      })),
    };
  } catch (err) {
    releaseProbe = { status: "not-run", reason: String(err).slice(0, 300) };
  }
}

const manifest = {
  schema_version: "prts-rust-plan/data-manifest/v1",
  recorded_at: new Date().toISOString(),
  baseline_commit: "e0ba36096cdd46640166b0a5db02902fa9a6a24c",
  datasets: {
    "minimal-gamedata-v1": {
      purpose: "P0/P1 differential fixture for list_stages and protocol cases",
      source: "derived from ts/tests/stage.test.ts writeFixtures @ baseline commit",
      root: ".runtime/fixtures/minimal-gamedata-v1",
      excel_dir: "zh_CN/gamedata/excel",
      files: fixtureFiles,
    },
    "bundled-sample-gamedata": {
      purpose: "repo-bundled partial excel sample shipped with the fixed tag; reference only",
      source: "git archive e0ba360:data/gamedata",
      root: ".reference/ts-v2.8.1/data/gamedata",
      files: bundledFiles,
    },
    "activated-minimal-v1": {
      purpose: "P2 differential fixture: TS-sync-written generation volume with pair pointer",
      source: "ts dist syncReleaseArchivePair (offline) over minimal-gamedata-v1 content",
      root: ".runtime/fixtures/activated-minimal-v1",
      gamedata_root: "gamedata",
      pair_commit_sha: ACTIVATED_TAG,
      activation: pairActivation,
      files: [
        "gamedata/archives/zh_CN-excel.zip",
        "gamedata/archives/release_meta.json",
        "gamedata-levels/archives/zh_CN-levels.zip",
        "gamedata-levels/archives/release_meta.json",
        ".gamedata_pair.json",
      ].map((rel) => ({
        path: rel,
        bytes: statSync(join(ACTIVATED_ROOT, rel)).size,
        sha256: sha256(join(ACTIVATED_ROOT, rel)),
      })),
      // Generation dir names carry random UUIDs; the CONTENT under them is
      // hashed with the generation segment masked so runs stay comparable.
      generation_content: walkFiles(ACTIVATED_ROOT)
        .filter((p) => p.includes(`${join("", ".releases")}${p.includes("/") ? "/" : "/"}`) || p.includes("/.releases/") || p.split("/").includes(".releases"))
        .map((p) => ({
          path: relative(ACTIVATED_ROOT, p).replace(/\.releases\/[^/]+\//, ".releases/<gen>/"),
          bytes: statSync(p).size,
          sha256: sha256(p),
        })),
    },
  },
  upstream_release_probe: {
    repo: UPSTREAM_REPO,
    note: "version axis of data packages, independent of server release dates; no archives downloaded in P0",
    ...releaseProbe,
  },
  wiki_response_fixtures: {
    status: "not-started",
    note: "P5 scope; P0 records the slot only",
  },
  image_assets: {
    status: "not-started",
    note: "P6 scope; P0 records the slot only",
  },
};

mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

console.log(`fixture: ${fixtureFiles.length} files under ${relative(ROOT, FIXTURE_ROOT)}`);
console.log(`bundled sample: ${bundledFiles.length} files recorded`);
console.log(`release probe: ${releaseProbe.status}`);
console.log(`manifest: ${relative(ROOT, MANIFEST_PATH)}`);
