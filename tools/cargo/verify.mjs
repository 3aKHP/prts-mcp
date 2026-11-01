// Install the actual .crate outside the checkout, then reuse native MCP probes.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root, version, run, sha, json, readJson, verifyVersion, publicBins, directory, filename, packed, cargo } from './common.mjs';

verifyVersion();
const targets = readJson(join(root, 'packaging/native/targets.json'));
const platform = Object.keys(targets).find(id => targets[id].os === process.platform && targets[id].arch === process.arch);
assert(platform, 'Source installation probe needs a supported native host');
const dirty = !!run('git', ['status', '--porcelain', '--untracked-files=normal']).trim();
assert(!dirty || process.argv.includes('--allow-dirty'), 'Commit changes before creating a release candidate');
run(process.execPath, ['tools/check-source-package.mjs', ...(dirty ? ['--allow-dirty'] : [])], { stdio: 'inherit' });
cargo(['package', '--locked', '--no-verify', '--target-dir', join(root, 'target'), ...(dirty ? ['--allow-dirty'] : [])], { stdio: 'inherit' });
const checksum = sha(packed);
const temporary = mkdtempSync(join(tmpdir(), 'prts-cargo-'));
try {
  run('tar', ['-xf', packed, '-C', temporary]);
  const source = join(temporary, `prts-mcp-${version}`);
  const installed = join(temporary, 'installed');
  const metadata = JSON.parse(cargo(['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1'], { cwd: source }));
  const bins = metadata.packages[0].targets.filter(target => target.kind.includes('bin')).map(target => target.name).sort();
  assert.deepEqual(bins, publicBins, 'Published Cargo manifest must expose only production binaries');
  // Reuse compilation cache, never an already installed executable. Cargo must
  // compile/install the detached manifest and its bundled native source files.
  cargo(['install', '--locked', '--path', source, '--root', installed, '--target-dir', join(root, 'target')], { cwd: source, stdio: 'inherit' });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  assert.deepEqual(readdirSync(join(installed, 'bin')).sort(), publicBins.map(bin => bin + suffix).sort());
  run(process.execPath, ['tools/native/probe.mjs', platform, '--cargo-root', installed], { stdio: 'inherit' });
  assert.equal(sha(packed), checksum);
  mkdirSync(directory, { recursive: true });
  cpSync(packed, join(directory, filename));
  json(join(directory, 'SOURCE.json'), {
    schema: 'prts-mcp-cargo/v1', version, commit: run('git', ['rev-parse', 'HEAD']).trim(), dirty,
    cargoVersion: cargo(['--version']).trim(), filename, sha256: checksum, bins,
    runtime: readJson(join(root, 'artifacts/native', platform, 'cargo-runtime-evidence.json')),
  });
  console.log(`CARGO_SOURCE_PASS: ${filename} ${checksum}`);
} finally {
  // Only this invocation's temporary source and installed copies are removed.
  rmSync(temporary, { recursive: true, force: true });
}
