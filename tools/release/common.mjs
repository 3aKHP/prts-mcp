import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { root, version, targets, pin, readJson, json, sha, run } from '../npm/common.mjs';
export { root, version, targets, pin, readJson, json, sha, run };
export const repository = '3aKHP/prts-mcp';
export const packageNames = [...Object.keys(targets).map(id => `@3akhp/prts-mcp-${id}`),
  '@3akhp/prts-mcp-data', '@3akhp/prts-mcp-runtime', 'prts-mcp', 'prts-mcp-ts'];
export function verifyVersion(product = version) {
  assert(/^3\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*)|-dev\.0)?$/.test(product), 'Invalid Rust product version');
  const lock = readFileSync(new URL('../../Cargo.lock', import.meta.url), 'utf8');
  const item = lock.split('[[package]]').find(part => /^\s*name = "prts-mcp"\s*$/m.test(part));
  assert(item, 'Product is missing from Cargo.lock');
  assert.equal(item.match(/^version = "([^"]+)"/m)?.[1], product, 'Cargo.lock product version mismatch');
  return product;
}
export function releasePolicy(product, ref, { repository: repo = repository, stableEnabled = false } = {}) {
  assert.equal(repo, repository, 'Forks cannot publish this product');
  assert(!product.includes('-dev.'), 'Development versions cannot be published');
  assert(/^3\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.test(product), 'Invalid release version');
  assert.equal(ref, `refs/tags/v${product}`, 'Release tag must match the exact product version');
  const prerelease = product.includes('-');
  assert(prerelease || stableEnabled, 'Stable publication is disabled until M5');
  return { version: product, tag: `v${product}`, prerelease, npmTag: prerelease ? 'next' : 'latest',
    dockerTags: prerelease ? [product, 'next'] : [product, '3', 'latest'], githubLatest: !prerelease };
}
export function verifyBundle(bundle, product = version) {
  assert.equal(bundle.schema, 'prts-mcp-bundle/v1');
  assert.equal(bundle.productVersion, product);assert.equal(bundle.repo, pin.repo);
  assert.equal(bundle.releaseTag, pin.release_tag);assert.equal(bundle.sourceVersion, pin.source_version);
  assert.deepEqual(bundle.assets, pin.assets, 'Candidate data pin mismatch');
}
export function verifyNpmEvidence(receipt, evidence, id) {
  assert.equal(evidence.version,receipt.version);assert.equal(evidence.platform,id);assert.equal(evidence.native,true);
  assert.equal(evidence.arch,targets[id].arch);assert(evidence.checks.length>=14);
  assert.deepEqual(evidence.packages,receipt.packages,'npm runtime evidence must describe the actual tarballs');
}
export function verifyDockerEvidence(image, evidence, archiveSha256, id) {
  assert.equal(evidence.commit,image.commit);assert.equal(evidence.version,image.version);assert.equal(evidence.platform,id);
  assert.equal(evidence.native,true);assert.equal(evidence.checks.length,10);assert.equal(evidence.imageId,image.imageId);
  assert.equal(evidence.arch,targets[id].arch==='x64'?'amd64':'arm64');assert.equal(image.arch,evidence.arch);
  assert.equal(evidence.archiveSha256,archiveSha256,'Docker runtime evidence must bind the actual loaded archive');
}
