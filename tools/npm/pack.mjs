import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, rmSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root, version, targets, npm, run, sha, json, readJson } from './common.mjs';

const id = process.argv[2];
const target = targets[id];
if (!target) throw new Error('Usage: node tools/npm/pack.mjs <native-platform> [--native-dir <payload>]');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const nativeDir = resolve(option('--native-dir') ?? join(root, 'artifacts/native', id, 'payload'));
const build = readJson(join(nativeDir, 'BUILD.json'));
assert.equal(build.platform, id);
assert.equal(build.target, target.target);
assert.equal(build.version, version);
assert.equal(build.dirty, false, 'Only clean, audited native payloads may become npm platform packages');
const abi = readJson(join(nativeDir, 'ABI.json'));
assert.equal(abi.platform, target.target);
assert.equal(abi.binaries.length, 5);
for (const line of readFileSync(join(nativeDir, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
  assert(match && !match[2].startsWith('/') && !match[2].split('/').includes('..'));
  assert.equal(sha(join(nativeDir, match[2])), match[1]);
}
const out = join(root, 'artifacts/npm', id);
const packages = join(out, 'packages');
const tarballs = join(out, 'tarballs');
rmSync(out, { recursive: true, force: true });
mkdirSync(packages, { recursive: true });
mkdirSync(tarballs);
const base = { version, repository: { type: 'git', url: 'https://github.com/3aKHP/prts-mcp.git' },
  engines: { node: '>=22', npm: '>=10' }, publishConfig: { access: 'public', tag: 'next' } };
const manifest = [];
function make(name, fields, fill) {
  const dir = join(packages, name.replace('@','').replace('/','-'));
  mkdirSync(dir);
  json(join(dir, 'package.json'), { ...base, name, ...fields });
  for (const file of ['LICENSE','NOTICE']) cpSync(join(root, file), join(dir, file));
  fill(dir);
  const packed = JSON.parse(run(npm, ['pack','--json','--ignore-scripts','--pack-destination',tarballs], { cwd: dir }))[0];
  assert.equal(packed.name, name);
  assert.equal(packed.version, version);
  assert(!packed.files.some(f => /(^|\/)(\.git|\.release\.lock|node_modules)(\/|$)/.test(f.path)));
  manifest.push({ name, version, filename: packed.filename, integrity: packed.integrity,
    sha256: sha(join(tarballs, packed.filename)), unpackedSize: packed.unpackedSize, files: packed.files.length });
}
const platformName = `@3akhp/prts-mcp-${id}`;
make(platformName, { description: `PRTS-MCP native Rust payload (${id})`, license: 'MIT',
  os: [target.os], cpu: [target.arch], ...(target.os === 'linux' ? { libc: 'glibc' } : {}),
  files: ['bin/','BUILD.json','ABI.json','SHA256SUMS','notices/','THIRD-PARTY.json','LICENSE','NOTICE'] }, dir => {
  for (const entry of readdirSync(nativeDir)) {
    cpSync(join(nativeDir, entry), join(dir, entry), { recursive: true });
  }
});
make('@3akhp/prts-mcp-data', { description: 'Validated read-only Arknights data fallback for PRTS-MCP',
  license: 'SEE LICENSE IN NOTICE', files: ['data/','NOTICE'] }, dir => {
  const data = join(root, 'artifacts/npm-bundle/data');
  const bundle = readJson(join(data, 'BUNDLE.json'));
  assert.equal(bundle.schema, 'prts-mcp-bundle/v1');
  assert.equal(bundle.productVersion, version);
  cpSync(data, join(dir, 'data'), { recursive: true });
});
make('@3akhp/prts-mcp-runtime', { description: 'Shared native launch bridge for PRTS-MCP npm entries',
  license: 'MIT', main: 'runtime.cjs', files: ['runtime.cjs','platforms.json','LICENSE','NOTICE'],
  dependencies: { '@3akhp/prts-mcp-data': version },
  optionalDependencies: Object.fromEntries(Object.keys(targets).map(p => [`@3akhp/prts-mcp-${p}`, version])) }, dir => {
  cpSync(join(root,'packaging/npm/runtime.cjs'),join(dir,'runtime.cjs'));
  json(join(dir,'platforms.json'),Object.fromEntries(Object.entries(targets).map(([p,t])=>[p,{os:t.os,arch:t.arch,target:t.target}])));
});
for (const [name, commands] of [['prts-mcp',['prts-mcp']],['prts-mcp-ts',['prts-mcp-ts','prts-mcp-ts-bun','prts-mcp-ts-stdio']]]) {
  make(name, { description: name === 'prts-mcp' ? 'PRTS-MCP native Rust MCP server' : 'PRTS-MCP legacy command compatibility with the native Rust server',
    license: 'MIT', files: ['bin/','README.md','LICENSE','NOTICE'],
    bin: Object.fromEntries(commands.map(bin => [bin,`bin/${bin}.cjs`])),
    dependencies: { '@3akhp/prts-mcp-runtime': version } }, dir => {
    mkdirSync(join(dir,'bin'));
    for (const bin of commands) {
      const path = join(dir,'bin',`${bin}.cjs`);
      writeFileSync(path,`#!/usr/bin/env node\n"use strict";\nrequire("@3akhp/prts-mcp-runtime").run(${JSON.stringify(bin)});\n`);
      chmodSync(path,0o755);
    }
    writeFileSync(join(dir,'README.md'),`# ${name}\n\nPRTS-MCP ${version} uses the shared native Rust runtime and a validated read-only data fallback.\n\n${name === 'prts-mcp' ? 'prts-mcp defaults to Streamable HTTP. Set PRTS_TRANSPORT=stdio for stdio.' : 'prts-mcp-ts and prts-mcp-ts-bun preserve HTTP; prts-mcp-ts-stdio preserves stdio. Bun is not required.'}\n\nRequires Node >=22 for this npm launcher; no compiler or extra native-library setup is required. User-data updates are stored outside the installed package. Enable npm optional dependencies to install the matching native platform.\n\nThis development package is not a published stable release.\n`);
  });
}
json(join(out,'packages.json'),{ version,platform:id,nativeBuild:build,dataBundle:readJson(join(root,'artifacts/npm-bundle/data/BUNDLE.json')),packages:manifest });
console.log(`Packed ${manifest.length} npm tarballs for ${id}; data/runtime shared by both entries`);
