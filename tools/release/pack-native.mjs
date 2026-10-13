import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { root, out as nativeOut, stage as native, id, version, config, run, sha, json, psLiteral } from '../native/common.mjs';
import { verifyExactInventory } from '../docker/inventory.mjs';
import { verifyNotices } from '../npm/common.mjs';
import { verifyVersion, verifyBundle } from './common.mjs';
verifyVersion();
const build = JSON.parse(readFileSync(join(native, 'BUILD.json')));
const bundle = join(root, 'artifacts/npm-bundle/data');
const data = JSON.parse(readFileSync(join(bundle, 'BUNDLE.json')));
const commit = run('git', ['rev-parse', 'HEAD']).trim();
assert.equal(build.commit, commit);assert.equal(build.dirty, false);
assert.equal(build.version, version);assert.equal(build.platform, id);assert.equal(build.target, config.target);
assert.equal(run('git', ['status', '--porcelain']).trim(), '', 'Candidate packaging requires a clean source');
verifyBundle(data);
const nativeFiles = verifyExactInventory(native), dataFiles = verifyExactInventory(bundle);
const notices = verifyNotices(native);
const out = join(root, 'artifacts/candidate', id), stage = join(out, 'payload');
rmSync(out, { recursive: true, force: true });mkdirSync(stage, { recursive: true });
for (const entry of readdirSync(native)) if (entry !== 'SHA256SUMS') cpSync(join(native, entry), join(stage, entry), { recursive: true });
cpSync(bundle, join(stage, 'data'), { recursive: true });
writeFileSync(join(stage, 'README.txt'), `PRTS-MCP ${version} (${id})\n\nRun bin/prts-mcp: Streamable HTTP defaults to port 3000; PRTS_TRANSPORT=stdio selects stdio.\nValidated read-only fallback game data is in data/. User synchronization writes outside this installation.\nNo Node/Bun/Python, compiler or additional native library setup is required.\nA development candidate is not a stable release; inspect CANDIDATE.json, BUILD.json, ABI.json and NOTICE.\n`);
json(join(stage, 'CANDIDATE.json'), { schema: 'prts-mcp-candidate/v1', version, commit, platform: id,
  nativeBuild: build, dataBundle: data, originalNativeFiles: nativeFiles.length, dataFiles: dataFiles.length,
  noticeReferences: notices, nativeSdkSha256: sha(join(nativeOut, `prts-mcp-${version}-${id}.${config.os === 'win32' ? 'zip' : 'tar.gz'}`)), publicPublication: false });
const hashes = [];
function inventory(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) inventory(path);
    else { assert(entry.isFile());hashes.push(`${sha(path)}  ${relative(stage,path).split('\\').join('/')}`); }
  }
}
inventory(stage);writeFileSync(join(stage, 'SHA256SUMS'), hashes.join('\n')+'\n');
verifyExactInventory(stage);verifyExactInventory(join(stage, 'data'));verifyNotices(stage);
const filename = `prts-mcp-${version}-${id}-candidate.${config.os === 'win32' ? 'zip' : 'tar.gz'}`;
const archive = join(out, filename);
if (config.os === 'win32') run('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${psLiteral(stage)}, ${psLiteral(archive)})`]);
else run('tar', ['-czf',archive,'-C',stage,'.']);
writeFileSync(archive+'.sha256', `${sha(archive)}  ${filename}\n`);
json(join(out, 'candidate.json'), { version, commit, platform: id, filename, sha256: sha(archive), payloadFiles: hashes.length, dataFiles: dataFiles.length, publicPublication: false });
console.log(`NATIVE_CANDIDATE_PACK_PASS: ${id} ${hashes.length} files`);
