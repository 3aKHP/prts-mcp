/**
 * P6 differential fixture: minimal-images-v1.
 *
 * Copies minimal-gamedata-v2 (the P3 GameData fixture), adds skin_table.json
 * (label joins) and a pre-activated images generation directory:
 *   images/.images_meta.json → .releases/<gen>/ with index.json + PNG bytes.
 *
 * PNG files carry real PNG magic (downloads validate signatures); payloads
 * are deterministic strings whose sha256 lands in index.json.
 * The builder also registers the dataset in contracts/data-manifest.json.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, ".runtime", "fixtures", "minimal-gamedata-v2");
const DST = join(ROOT, ".runtime", "fixtures", "minimal-images-v1");
const MANIFEST_PATH = join(ROOT, "contracts", "data-manifest.json");

function dirname(p) { const parts = p.split("/"); parts.pop(); return parts.join("/") || "/"; }

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(payload) {
  return Buffer.concat([PNG_MAGIC, Buffer.from(payload, "utf8")]);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// --- skin_table.json (label + display metadata joins) -----------------------
const SKIN_TABLE = {
  charSkins: {
    "char_002_amiya@theme1#1": {
      displaySkin: {
        skinName: "报童",
        skinGroupName: "珊瑚海岸",
        obtainApproach: "时装商店采购",
        description: "轻便的报童装束。",
      },
    },
  },
};

// --- artwork files + index ---------------------------------------------------
const ARTWORKS = [
  { id: "char_002_amiya#1", kind: "base", shard: "chararts", since: "26-01-01-00-00-00_base" },
  { id: "char_002_amiya#2", kind: "base", shard: "chararts", since: "26-01-01-00-00-00_base" },
  { id: "char_002_amiya@theme1#1", kind: "skin", shard: "skinpack", since: "26-03-01-00-00-00_d1" },
  { id: "char_1001_amiya2#1", kind: "base", shard: "chararts", since: "26-01-01-00-00-00_base" },
  { id: "char_1001_amiya2#2", kind: "base", shard: "chararts", since: "26-01-01-00-00-00_base" },
];

const files = [];
const indexArtworks = {};
for (const art of ARTWORKS) {
  const shardDir = art.shard === "skinpack" ? "skinpack" : "chararts";
  const variants = {};
  for (const [variant, dims] of [["large", [1024, 1024]], ["preview", [256, 256]]]) {
    const payload = png(`fixture:${art.id}:${variant}`);
    const rel = `${shardDir}/${art.id}.${variant}.png`;
    files.push({ rel, payload });
    variants[variant] = {
      file: rel,
      w: dims[0],
      h: dims[1],
      bytes: payload.length,
      sha256: sha256(payload),
    };
  }
  indexArtworks[art.id] = {
    kind: art.kind,
    shard: art.shard,
    sinceVersion: art.since,
    ...variants,
  };
}

const GEN = "2ff20f8da19f3c77-fiximg0011223344";
const INDEX = {
  schemaVersion: "akdp-images/v1",
  baselineVersion: "26-01-01-00-00-00_base",
  currentVersion: "26-03-01-00-00-00_d1",
  shards: {
    "chararts-large": "chararts-large.zip",
    "chararts-preview": "chararts-preview.zip",
    "skinpack-large": "skinpack-large.zip",
    "skinpack-preview": "skinpack-preview.zip",
  },
  artworks: indexArtworks,
};
const GEN_META = {
  schemaVersion: "akdp-images/v1",
  baselineVersion: INDEX.baselineVersion,
  currentVersion: INDEX.currentVersion,
  shardsSynced: ["chararts-large", "chararts-preview", "skinpack-large", "skinpack-preview"],
};
const TOP_META = { ...GEN_META, generation_root: `.releases/${GEN}` };

// --- write the fixture --------------------------------------------------------
mkdirSync(DST, { recursive: true });
cpSync(SRC, DST, { recursive: true });
const write = (rel, data) => {
  const target = join(DST, rel);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, data);
};
write("zh_CN/gamedata/excel/skin_table.json", JSON.stringify(SKIN_TABLE, null, 2) + "\n");
write(`images/.releases/${GEN}/index.json`, JSON.stringify(INDEX, null, 1) + "\n");
write(`images/.releases/${GEN}/.images_meta.json`, JSON.stringify(GEN_META, null, 1) + "\n");
write("images/.images_meta.json", JSON.stringify(TOP_META, null, 1) + "\n");
for (const f of files) write(`images/.releases/${GEN}/${f.rel}`, f.payload);

// --- the oversized MediaWiki download body (gzip member for the cap case) ----
const OVERSIZED = Buffer.concat([PNG_MAGIC, Buffer.alloc(1024 * 1024 + 16)]);
const OVERSIZED_GZ_B64 = gzipSync(OVERSIZED).toString("base64");

// --- register in data-manifest ----------------------------------------------
function walk(dir, base) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else {
      out.push({
        path: relative(base, full),
        bytes: statSync(full).size,
        sha256: sha256(readFileSync(full)),
      });
    }
  }
  return out;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const allFiles = walk(DST, DST);
manifest.datasets["minimal-images-v1"] = {
  purpose: "P6 differential fixture: operator_artwork local backend (skin_table + activated images generation)",
  source: "minimal-gamedata-v2 copy + skin_table.json + synthetic akdp-images/v1 generation",
  root: ".runtime/fixtures/minimal-images-v1",
  excel_dir: "zh_CN/gamedata/excel",
  images_generation: `images/.releases/${GEN}`,
  files: allFiles,
};
manifest.image_assets = {
  status: "recorded",
  note: "minimal-images-v1 synthetic generation (5 artworks × large/preview); full-scale real sync measured separately in P6",
  oversized_download_body_b64_gzip_bytes: Buffer.byteLength(OVERSIZED_GZ_B64, "base64"),
};
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

// Export for the replay-script builder (run with --write-replay to emit).
if (process.argv.includes("--write-replay")) {
  const amiyaLarge = files.find((f) => f.rel === "chararts/char_002_amiya#1.large.png");
  const amiyaPreview = files.find((f) => f.rel === "chararts/char_002_amiya#1.preview.png");
  const badMagic = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]);
  const replayScript = {
    rules: [
      // allimages listing for 阿米娅 (1b 建筑小人 filtered by label rules).
      {
        match: { method: "GET", query: { action: "query", list: "allimages", aiprefix: "立绘_阿米娅_", ailimit: "50", aiprop: "name|size|mime", format: "json" } },
        respond: { status: 200, json: { query: { allimages: [
          { name: "立绘_阿米娅_1.png", size: 200000, mime: "image/png" },
          { name: "立绘_阿米娅_2.png", size: 300000, mime: "image/png" },
          { name: "立绘_阿米娅_1b.png", size: 5000, mime: "image/png" },
          { name: "立绘_阿米娅_skin1.png", size: 150000, mime: "image/png" },
          { name: "立绘_阿米娅_不标注.png", size: 10, mime: "image/png" },
        ] } } },
      },
      // CharinfoV2 parsetree (flat values only — no batch POST needed).
      {
        match: { method: "GET", query: { action: "parse", page: "阿米娅", prop: "parsetree", format: "json" } },
        respond: { status: 200, json: { parse: { parsetree: { "*":
          "<root><template><title>CharinfoV2</title>" +
          "<part><name>时装1名称</name><value>报童</value></part>" +
          "</template></root>" } } } },
      },
      // imageinfo for the get variants.
      {
        match: { method: "GET", query: { action: "query", titles: "File:立绘_阿米娅_1.png", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "1024", format: "json" } },
        respond: { status: 200, json: { query: { pages: { "7": { imageinfo: [
          { url: "https://media.prts.wiki/3/31/立绘_阿米娅_1.png", thumburl: "https://media.prts.wiki/thumb/立绘_阿米娅_1.png/1024px-立绘_阿米娅_1.png", width: 2048, height: 2048, mime: "image/png", size: 200000 },
        ] } } } } },
      },
      {
        match: { method: "GET", query: { action: "query", titles: "File:立绘_阿米娅_1.png", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "256", format: "json" } },
        respond: { status: 200, json: { query: { pages: { "7": { imageinfo: [
          { url: "https://media.prts.wiki/3/31/立绘_阿米娅_1.png", thumburl: "https://media.prts.wiki/thumb/立绘_阿米娅_1.png/256px-立绘_阿米娅_1.png", width: 2048, height: 2048, mime: "image/png", size: 200000 },
        ] } } } } },
      },
      // Disallowed host comes from imageinfo itself (client-side rejection).
      {
        match: { method: "GET", query: { action: "query", titles: "File:立绘_阿米娅_2.png", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "1024", format: "json" } },
        respond: { status: 200, json: { query: { pages: { "8": { imageinfo: [
          { url: "https://evil.example/立绘_阿米娅_2.png", thumburl: "https://evil.example/立绘_阿米娅_2.png", width: 2048, height: 2048, mime: "image/png", size: 1 },
        ] } } } } },
      },
      {
        match: { method: "GET", query: { action: "query", titles: "File:立绘_阿米娅_skin1.png", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "1024", format: "json" } },
        respond: { status: 200, json: { query: { pages: { "9": { imageinfo: [
          { url: "https://media.prts.wiki/skin1.png", thumburl: "https://media.prts.wiki/thumb/skin1.png/1024px-skin1.png", width: 1024, height: 1024, mime: "image/png", size: 150000 },
        ] } } } } },
      },
      // media downloads by path.
      { match: { method: "GET", host: "media.prts.wiki", path: "/thumb/立绘_阿米娅_1.png/1024px-立绘_阿米娅_1.png" },
        respond: { status: 200, content_type: "image/png", body_b64: amiyaLarge.payload.toString("base64") } },
      { match: { method: "GET", host: "media.prts.wiki", path: "/thumb/立绘_阿米娅_1.png/256px-立绘_阿米娅_1.png" },
        respond: { status: 200, content_type: "image/png", body_b64: amiyaPreview.payload.toString("base64") } },
      { match: { method: "GET", host: "media.prts.wiki", path: "/thumb/skin1.png/1024px-skin1.png" },
        respond: { status: 200, content_type: "image/png", body_b64: png("fixture:mediawiki-skin").toString("base64") } },
      // Boundary imageinfo targets (8 bad-magic, 9 bad-mime, 7 oversize,
      // plus an operator with no artworks at all).
      {
        match: { method: "GET", query: { action: "query", titles: "File:立绘_阿米娅_8.png", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "1024", format: "json" } },
        respond: { status: 200, json: { query: { pages: { "18": { imageinfo: [
          { url: "https://media.prts.wiki/8.png", thumburl: "https://media.prts.wiki/bad-magic.png", width: 2048, height: 2048, mime: "image/png", size: 1 },
        ] } } } } },
      },
      {
        match: { method: "GET", query: { action: "query", titles: "File:立绘_阿米娅_9.png", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "1024", format: "json" } },
        respond: { status: 200, json: { query: { pages: { "19": { imageinfo: [
          { url: "https://media.prts.wiki/9.png", thumburl: "https://media.prts.wiki/bad-mime.png", width: 2048, height: 2048, mime: "image/png", size: 1 },
        ] } } } } },
      },
      {
        match: { method: "GET", query: { action: "query", titles: "File:立绘_阿米娅_7.png", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "1024", format: "json" } },
        respond: { status: 200, json: { query: { pages: { "17": { imageinfo: [
          { url: "https://media.prts.wiki/7.png", thumburl: "https://media.prts.wiki/oversize.png", width: 4096, height: 4096, mime: "image/png", size: 999999 },
        ] } } } } },
      },
      {
        match: { method: "GET", query: { action: "query", list: "allimages", aiprefix: "立绘_无立绘干员_", ailimit: "50", aiprop: "name|size|mime", format: "json" } },
        respond: { status: 200, json: { query: { allimages: [] } } },
      },
      {
        match: { method: "GET", query: { action: "parse", page: "无立绘干员", prop: "parsetree", format: "json" } },
        respond: { status: 200, json: { parse: { parsetree: { "*":
          "<root><template><title>CharinfoV2</title><part><name>职业</name><value>近卫</value></part></template></root>" } } } },
      },
      // Boundary bodies.
      { match: { method: "GET", host: "media.prts.wiki", path: "/bad-mime.png" },
        respond: { status: 200, content_type: "text/html", body_b64: png("x").toString("base64") } },
      { match: { method: "GET", host: "media.prts.wiki", path: "/bad-magic.png" },
        respond: { status: 200, content_type: "image/png", body_b64: badMagic.toString("base64") } },
      { match: { method: "GET", host: "media.prts.wiki", path: "/oversize.png" },
        respond: { status: 200, content_type: "image/png", body_b64: OVERSIZED_GZ_B64, content_encoding: "gzip" } },
    ],
    default: { status: 404, json: { error: { code: "replay-unmatched", info: "no replay rule matched this request" } } },
  };
  const replayDir = join(ROOT, "contracts", "wiki-replay");
  mkdirSync(replayDir, { recursive: true });
  writeFileSync(join(replayDir, "artwork-mw.json"), JSON.stringify(replayScript, null, 2) + "\n");
  console.log("replay script: contracts/wiki-replay/artwork-mw.json");
}

console.log(`fixture: minimal-images-v1 (${allFiles.length} files, generation ${GEN})`);
console.log("manifest: datasets.minimal-images-v1 registered");
