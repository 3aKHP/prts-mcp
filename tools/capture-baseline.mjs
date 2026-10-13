// Documentation evidence only. Does not start a server or download data.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outer = resolve(root, '.reference/ts-v2.8.1');
const sha = 'e0ba36096cdd46640166b0a5db02902fa9a6a24c';
const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 });
const paths = git('ls-tree', '-r', '--name-only', sha, 'ts/src', 'ts/tests', 'tests/parity-fixtures').toString().trim().split('\n');
const entries = paths.map(path => {
  const bytes = git('show', `${sha}:${path}`);
  if (path.startsWith('ts/src/') && !readFileSync(resolve(outer, path)).equals(bytes)) {
    throw new Error(`Working source differs from pinned baseline: ${path}`);
  }
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), lines: bytes.toString().split('\n').length - 1 };
});
const { z } = await import(pathToFileURL(resolve(outer, 'ts/node_modules/zod/index.js')).href);
const tools = [];
const server = { registerTool(name, config) {
  tools.push({ name, description: config.description, inputSchema: z.toJSONSchema(config.inputSchema, { io: 'input' }) });
} };
for (const [file, fn] of [['prtsTools','registerPrtsTools'],['gamedataTools','registerGamedataTools'],['storyTools','registerStoryTools'],['artworkTools','registerArtworkTools']]) {
  const module = await import(pathToFileURL(resolve(outer, `ts/src/tools/${file}.ts`)).href);
  module[fn](server, 'content');
}
if (tools.length !== 24 || new Set(tools.map(t => t.name)).size !== 24) throw new Error('Unexpected surface');
writeFileSync(resolve(root, 'contracts/tool-declarations.json'), JSON.stringify({
  baseline: { tag: 'ts/v2.8.1', commit: sha },
  kind: 'registration-declarations-not-wire-snapshot',
  note: 'Source bytes verified against tag; zod io=input projection. P0 must capture actual tools/list and validation behavior through MCP. operator_artwork is conditional at server factory.',
  zod: JSON.parse(readFileSync(resolve(outer,'ts/node_modules/zod/package.json'))).version,
  tools,
}, null, 2) + '\n');
writeFileSync(resolve(root, 'docs/dev/rust-rewrite/research/source-inventory.json'), JSON.stringify({ baseline: sha, files: entries }, null, 2) + '\n');
const datasets = await import(pathToFileURL(resolve(outer, 'ts/src/data/datasets.ts')).href);
const images = await import(pathToFileURL(resolve(outer, 'ts/src/sync/imagesSync.ts')).href);
writeFileSync(resolve(root, 'contracts/data-declarations.json'), JSON.stringify({
  baseline: sha,
  kind: 'source-declarations-not-runtime-validation',
  data_contract_version: 'prts-mcp-data/v1',
  datasets: ['GAMEDATA_EXCEL', 'GAMEDATA_LEVELS', 'STORY_ZH_CN'].map(name => {
    const spec = datasets[name];
    return { name, datasetId: spec.datasetId, owner: spec.owner, repo: spec.repo,
      assetName: spec.assetName, requiredFiles: spec.requiredFiles,
      verifyManifest: spec.verifyManifest, validation: spec.validateZip ? 'validateStoryjsonZip (includes optional supplement chapter references)' : 'required files plus archive activation validation' };
  }),
  image_schema_version: 'akdp-images/v1',
  image_shards: { default: images.neededShardKeys(false), with_original: images.neededShardKeys(true) },
}, null, 2) + '\n');
console.log(JSON.stringify({ tools: tools.length, sourceFiles: entries.filter(e => e.path.startsWith('ts/src/')).length, output: relative(outer, root) }));
