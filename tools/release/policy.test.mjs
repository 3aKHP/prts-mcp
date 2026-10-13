import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releasePolicy, verifyVersion } from './common.mjs';
test('Cargo product version stays locked',()=>verifyVersion());
test('candidate releases cannot advance stable channels',()=>{
  const p=releasePolicy('3.0.0-alpha.1','refs/tags/v3.0.0-alpha.1');
  assert.equal(p.npmTag,'next');assert.equal(p.githubLatest,false);assert.deepEqual(p.dockerTags,['3.0.0-alpha.1','next']);
});
test('publication rejects dev, legacy, fork, mismatched tag and premature stable',()=>{
  for(const version of ['3.0.0-dev.0','2.8.2','3.0.0','3.0.0-alpha.01'])assert.throws(()=>releasePolicy(version,`refs/tags/v${version}`));
  assert.throws(()=>releasePolicy('3.0.0-alpha.1','refs/tags/ts/v3.0.0-alpha.1'));
  assert.throws(()=>releasePolicy('3.0.0-alpha.1','refs/tags/v3.0.0-alpha.2'));
  assert.throws(()=>releasePolicy('3.0.0-alpha.1','refs/tags/v3.0.0-alpha.1',{repository:'someone/fork'}));
});
test('stable policy requires explicit M5 enablement',()=>{
  const p=releasePolicy('3.0.0','refs/tags/v3.0.0',{stableEnabled:true});assert.equal(p.npmTag,'latest');assert.equal(p.githubLatest,true);
});
