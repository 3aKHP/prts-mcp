// One real publish followed by checksum read-back; no credential probe writes.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { root, version, run, sha, json, readJson, directory, filename, packed, cargo, assertSourceReceipt, indexChecksum } from './common.mjs';

assert.equal(process.env.RUST_CRATES_PUBLISH_ENABLED, 'true', 'crates.io publication is disabled');
run(process.execPath, ['tools/release/check-version.mjs', '--release'], { stdio: 'inherit' });
assert.equal(run('git', ['status', '--porcelain', '--untracked-files=normal']).trim(), '', 'Publication requires clean source');
const policy = readJson(join(root, 'artifacts/release-policy.json'));
const receipt = readJson(join(directory, 'SOURCE.json'));
const checksum = sha(join(directory, filename));
assertSourceReceipt(receipt, { version, commit: policy.commit, cargoVersion: cargo(['--version']).trim(), checksum });

// Stable Cargo publishes by repackaging the source. Check reproducibility before
// granting it a write, and verify the exact checksum served by the registry after.
cargo(['package', '--locked', '--no-verify', '--target-dir', join(root, 'target')], { stdio: 'inherit' });
assert.equal(sha(packed), checksum, 'Cargo repack differs from the installed source candidate');
const index = 'https://index.crates.io/pr/ts/prts-mcp';
async function remoteChecksum() {
  const response = await fetch(index, { headers: { 'User-Agent': 'prts-mcp-release (https://github.com/3aKHP/prts-mcp)', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  assert.equal(response.status, 200, `Cannot inspect registry index: HTTP ${response.status}`);
  return indexChecksum(await response.text(), version);
}
const existing = await remoteChecksum();
if (existing !== null) {
  assert.equal(existing, checksum, 'Published version differs from this source candidate');
} else {
  cargo(['publish', '--locked', '--no-verify', '--target-dir', join(root, 'target')], { stdio: 'inherit' });
  assert.equal(sha(packed), checksum, 'Published Cargo archive differs from the checked candidate');
  const deadline = Date.now() + 300000;
  for (;;) {
    const actual = await remoteChecksum();
    if (actual !== null) {
      assert.equal(actual, checksum, 'Registry checksum differs from the installed source candidate');
      break;
    }
    assert(Date.now() < deadline, 'Registry visibility timed out; retry this publisher with the same candidate');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
json(join(directory, 'PUBLISHED.json'), { schema: 'prts-mcp-cargo-publication/v1', version, commit: policy.commit, sha256: checksum, alreadyPublished: existing !== null });
console.log(`CRATES_PUBLICATION_PASS: prts-mcp ${version} ${checksum}`);
