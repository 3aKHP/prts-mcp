// Cargo source distribution only; runtime behavior remains in Rust.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { root, version, run, sha, json, readJson, verifyVersion } from '../release/common.mjs';
export { root, version, run, sha, json, readJson, verifyVersion };
export const publicBins = ['prts-mcp', 'prts-mcp-ghcr', 'prts-mcp-ts', 'prts-mcp-ts-bun', 'prts-mcp-ts-stdio'];
export const directory = join(root, 'artifacts/cargo');
export const filename = `prts-mcp-${version}.crate`;
export const packed = join(root, 'target/package', filename);
export const cargoArgs = process.env.PRTS_CARGO_DIRECT === 'true' ? ['--config', 'http.proxy=""'] : [];
export function cargo(args, options = {}) { return run('cargo', [...cargoArgs, ...args], options); }
export function assertSourceReceipt(receipt, { version: product, commit, cargoVersion, checksum }) {
  assert.equal(receipt.schema, 'prts-mcp-cargo/v1');
  assert.equal(receipt.version, product);
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.dirty, false, 'Publication requires a clean source candidate');
  assert.equal(receipt.cargoVersion, cargoVersion, 'Use the same Cargo toolchain as the source candidate');
  assert.equal(receipt.filename, `prts-mcp-${product}.crate`);
  assert.equal(receipt.sha256, checksum, 'Source candidate checksum mismatch');
  assert.deepEqual(receipt.bins, publicBins);
  assert.equal(receipt.runtime?.sourceInstallation, true);
  assert.equal(receipt.runtime?.extractedOutsideCheckout, true);
  assert.equal(receipt.runtime?.pathEmpty, true);
  assert.deepEqual([...new Set(receipt.runtime.checks.map(check => check.bin))].sort(), publicBins);
  assert(receipt.runtime.checks.some(check => check.transport === 'http' && check.legacy && check.modern));
  assert(receipt.runtime.checks.some(check => check.transport === 'stdio' && check.exit === 'EOF -> 0'));
}
export function indexChecksum(body, product) {
  const entries = body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const entry = entries.find(item => item.name === 'prts-mcp' && item.vers === product);
  if (!entry) return null;
  assert.equal(entry.yanked, false, 'Existing version is yanked; do not silently treat it as published');
  assert.match(entry.cksum, /^[a-f0-9]{64}$/);
  return entry.cksum;
}
