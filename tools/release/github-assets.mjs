import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyExactInventory } from '../docker/inventory.mjs';

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function nativeArchives(version) {
  return ['linux-x64', 'linux-arm64', 'windows-x64', 'darwin-arm64', 'darwin-x64'].map(platform => {
    const extension = platform === 'windows-x64' ? 'zip' : 'tar.gz';
    return { platform,
      filename: `prts-mcp-${version}-${platform.replace('darwin-', 'macos-')}.${extension}`,
      sourceFilename: `prts-mcp-${version}-${platform}-candidate.${extension}` };
  });
}
export function githubAssetNames(version) {
  return [...nativeArchives(version).map(row => row.filename), `prts-mcp-${version}-release-metadata.zip`, 'SHA256SUMS'];
}

// Build once during collection. Publishers only upload this checksum-bound layout.
export function prepareGithubAssets(directory, manifest) {
  verifyExactInventory(directory);
  const sourceChecksums = readFileSync(join(directory, 'SHA256SUMS'), 'utf8');
  const output = join(directory, 'github');
  mkdirSync(output);
  const assets = nativeArchives(manifest.version).map(row => {
    const source = manifest.files.find(file => file.filename === row.sourceFilename && file.kind === 'native-candidate');
    assert(source, `Missing native archive: ${row.sourceFilename}`);
    assert.equal(digest(join(directory, source.filename)), source.sha256);
    copyFileSync(join(directory, source.filename), join(output, row.filename));
    return { ...row, sha256: source.sha256 };
  });
  const metadata = mkdtempSync(join(tmpdir(), 'prts-release-metadata-'));
  try {
    const names = manifest.files.filter(file => file.kind === 'evidence').map(file => file.filename);
    assert(names.every(name => name.endsWith('.json') && !/[\\/]/.test(name)), 'Metadata must contain flat JSON evidence');
    for (const name of [...names, 'RELEASE.json']) copyFileSync(join(directory, name), join(metadata, name));
    writeFileSync(join(metadata, 'SHA256SUMS'), sourceChecksums);
    writeFileSync(join(metadata, 'PUBLIC-ASSETS.json'), JSON.stringify({ schema: 'prts-mcp-public-assets/v1',
      version: manifest.version, commit: manifest.commit, assets }, null, 2) + '\n');
    const members = [...names, 'RELEASE.json', 'SHA256SUMS', 'PUBLIC-ASSETS.json'].sort();
    for (const name of members) {
      chmodSync(join(metadata, name), 0o644);
      utimesSync(join(metadata, name), 315532800, 315532800);
    }
    execFileSync('zip', ['-q', '-X', '-0', resolve(output, `prts-mcp-${manifest.version}-release-metadata.zip`), ...members],
      { cwd: metadata, env: { ...process.env, TZ: 'UTC' } });
  } finally { rmSync(metadata, { recursive: true, force: true }); }
  const files = githubAssetNames(manifest.version).filter(name => name !== 'SHA256SUMS').sort();
  writeFileSync(join(output, 'SHA256SUMS'), files.map(name => `${digest(join(output, name))}  ${name}\n`).join(''));
  assert.deepEqual(verifyExactInventory(output).sort(), files);
  const all = githubAssetNames(manifest.version).sort();
  writeFileSync(join(directory, 'SHA256SUMS'), sourceChecksums + all.map(name => `${digest(join(output, name))}  github/${name}\n`).join(''));
  verifyExactInventory(directory);
}
