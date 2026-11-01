import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSourceReceipt, indexChecksum, publicBins } from './common.mjs';

const expected = { version: '3.2.1', commit: 'a'.repeat(40), cargoVersion: 'cargo fixture', checksum: 'b'.repeat(64) };
function receipt() {
  return { schema: 'prts-mcp-cargo/v1', version: expected.version, commit: expected.commit, dirty: false,
    cargoVersion: expected.cargoVersion, filename: 'prts-mcp-3.2.1.crate', sha256: expected.checksum, bins: publicBins,
    runtime: { sourceInstallation: true, extractedOutsideCheckout: true, pathEmpty: true,
      checks: [...publicBins.map(bin => ({ bin, transport: 'stdio', exit: 'EOF -> 0' })),
        { bin: 'prts-mcp', transport: 'http', legacy: true, modern: true }] } };
}
test('source publication binds installed archive, commit and Cargo toolchain', () => {
  assertSourceReceipt(receipt(), expected);
  for (const [key, value] of Object.entries({ version: '3.2.2', commit: 'c'.repeat(40), dirty: true,
    cargoVersion: 'other Cargo', filename: '../other.crate', sha256: 'd'.repeat(64), bins: [...publicBins, 'prts-mcp-rust'] })) {
    assert.throws(() => assertSourceReceipt({ ...receipt(), [key]: value }, expected), key);
  }
  const noInstall = receipt(); noInstall.runtime.sourceInstallation = false;
  assert.throws(() => assertSourceReceipt(noInstall, expected));
  const noHttp = receipt(); noHttp.runtime.checks.pop();
  assert.throws(() => assertSourceReceipt(noHttp, expected));
});
test('index read-back selects exact version and rejects yanked or malformed checksums', () => {
  const entry = { name: 'prts-mcp', vers: '3.2.1', cksum: expected.checksum, yanked: false };
  assert.equal(indexChecksum(JSON.stringify(entry), '3.2.1'), expected.checksum);
  assert.equal(indexChecksum(JSON.stringify(entry), '3.2.2'), null);
  assert.equal(indexChecksum('', '3.2.1'), null);
  assert.throws(() => indexChecksum(JSON.stringify({ ...entry, yanked: true }), '3.2.1'));
  assert.throws(() => indexChecksum(JSON.stringify({ ...entry, cksum: 'wrong' }), '3.2.1'));
});
