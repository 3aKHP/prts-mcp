import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { root, sha, publicBins } from './common.mjs';

// Run the actual publisher with an isolated Git/tag fixture, fake Cargo and
// a local in-process index response. No real token or network is used.
function fixture(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'prts-cargo-publish-'));
  const put = (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };
  for (const file of ['tools/cargo/common.mjs', 'tools/cargo/publish.mjs', 'tools/npm/common.mjs',
    'tools/release/common.mjs', 'tools/release/check-version.mjs', 'packaging/native/targets.json', 'packaging/npm/data-release.json']) {
    mkdirSync(dirname(join(dir, file)), { recursive: true }); cpSync(join(root, file), join(dir, file));
  }
  put('Cargo.toml', '[package]\nname = "prts-mcp"\nversion = "3.2.1"\n');
  put('Cargo.lock', '[[package]]\nname = "prts-mcp"\nversion = "3.2.1"\n');
  put('.gitignore', '/artifacts/\n/target/\n/mock/\n');
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(['init', '--quiet']); git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  git(['tag', 'v3.2.1']); git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  put('artifacts/cargo/prts-mcp-3.2.1.crate', 'installed archive');
  const checksum = sha(join(dir, 'artifacts/cargo/prts-mcp-3.2.1.crate'));
  put('artifacts/cargo/SOURCE.json', JSON.stringify({ schema: 'prts-mcp-cargo/v1', version: '3.2.1',
    commit: git(['rev-parse', 'HEAD']), dirty: false, cargoVersion: 'cargo fixture', filename: 'prts-mcp-3.2.1.crate',
    sha256: checksum, bins: publicBins, runtime: { sourceInstallation: true, extractedOutsideCheckout: true, pathEmpty: true,
      checks: [...publicBins.map(bin => ({ bin, transport: 'stdio', exit: 'EOF -> 0' })),
        { bin: 'prts-mcp', transport: 'http', legacy: true, modern: true }] } }));
  put('mock/cargo', `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('mock/commands.jsonl', JSON.stringify(args)+'\\n');
if (args[0] === '--version') console.log('cargo fixture');
if (args[0] === 'package' || args[0] === 'publish') {
  fs.mkdirSync('target/package', {recursive:true});
  fs.writeFileSync('target/package/prts-mcp-3.2.1.crate', process.env.TEST_MODE === 'repack-conflict' ? 'different' : 'installed archive');
}
if (args[0] === 'publish') fs.writeFileSync('mock/published', 'yes');
`);
  execFileSync('chmod', ['+x', join(dir, 'mock/cargo')]);
  put('mock/fetch.mjs', `import { existsSync } from 'node:fs';
globalThis.fetch = async url => {
  if (url !== 'https://index.crates.io/pr/ts/prts-mcp') throw new Error('Unexpected endpoint');
  if (process.env.TEST_MODE === 'http-error') return new Response('', {status:503});
  if (process.env.TEST_MODE === 'fresh' && !existsSync('mock/published')) return new Response('', {status:404});
  return new Response(JSON.stringify({name:'prts-mcp',vers:'3.2.1',yanked:process.env.TEST_MODE==='yanked',
    cksum:process.env.TEST_MODE==='remote-conflict'?'${'c'.repeat(64)}':'${checksum}'}));
};`);
  if (mode === 'dirty') put('Cargo.toml', readFileSync(join(dir, 'Cargo.toml'), 'utf8') + '# changed\n');
  const env = { ...process.env, PATH: join(dir, 'mock') + ':' + process.env.PATH,
    RUST_CRATES_PUBLISH_ENABLED: mode === 'disabled' ? 'false' : 'true', RUST_STABLE_RELEASE_ENABLED: 'true',
    GITHUB_REPOSITORY: '3aKHP/prts-mcp', GITHUB_REF: mode === 'wrong-tag' ? 'refs/tags/v3.2.2' : 'refs/tags/v3.2.1',
    PRTS_CARGO_DIRECT: 'false', TEST_MODE: mode };
  delete env.CARGO_REGISTRY_TOKEN; delete env.CARGO_REGISTRIES_CRATES_IO_TOKEN;
  return { dir, env };
}
for (const mode of ['fresh', 'already-published', 'disabled', 'wrong-tag', 'dirty', 'repack-conflict', 'remote-conflict', 'yanked', 'http-error']) {
  test(`Cargo publisher: ${mode}`, { skip: process.platform === 'win32' }, () => {
    const { dir, env } = fixture(mode);
    try {
      const result = spawnSync(process.execPath, ['--import', './mock/fetch.mjs', 'tools/cargo/publish.mjs'], { cwd: dir, env, encoding: 'utf8', timeout: 15000 });
      const success = ['fresh', 'already-published'].includes(mode);
      assert.equal(result.status === 0, success, result.stderr);
      const commands = existsSync(join(dir, 'mock/commands.jsonl')) ? readFileSync(join(dir, 'mock/commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
      assert.equal(commands.filter(args => args[0] === 'publish').length, mode === 'fresh' ? 1 : 0);
      assert.equal(existsSync(join(dir, 'artifacts/cargo/PUBLISHED.json')), success);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
