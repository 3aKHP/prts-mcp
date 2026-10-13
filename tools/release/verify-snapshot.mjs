import assert from 'node:assert/strict';
import { join } from 'node:path';
import { verifyExactInventory } from '../docker/inventory.mjs';
import { root,version,packageNames,readJson,run,releasePolicy } from './common.mjs';
export function verifiedSnapshot() {
  const directory=join(root,'artifacts/release');verifyExactInventory(directory);
  const manifest=readJson(join(directory,'RELEASE.json'));
  const policy=releasePolicy(version,process.env.GITHUB_REF,{repository:process.env.GITHUB_REPOSITORY,
    stableEnabled:process.env.RUST_STABLE_RELEASE_ENABLED==='true'});
  assert.equal(manifest.version,version);assert.equal(manifest.commit,run('git',['rev-parse','HEAD']).trim());
  assert.equal(manifest.schema,'prts-mcp-release/v1');assert.equal(manifest.platforms.length,5);
  assert.deepEqual(manifest.packages.map(p=>p.name),packageNames);
  return {directory,manifest,policy};
}
