import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releasePolicy, verifyVersion, verifyNpmEvidence, verifyDockerEvidence, zipMemberPattern } from './common.mjs';
test('ZIP metadata lookup handles Windows separators and rejects missing or duplicate identities',()=>{
  assert.equal(zipMemberPattern(['data\\BUNDLE.json'],'data/BUNDLE.json'),'data\\\\BUNDLE.json');
  assert.equal(zipMemberPattern(['data/BUNDLE.json'],'data/BUNDLE.json'),'data/BUNDLE.json');
  assert.throws(()=>zipMemberPattern([],'data/BUNDLE.json'));
  assert.throws(()=>zipMemberPattern(['data/BUNDLE.json','data\\BUNDLE.json'],'data/BUNDLE.json'));
});
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
test('same-version npm evidence from different tarballs or CPUs is rejected',()=>{
  const receipt={version:'3.0.0-alpha.1',packages:[{name:'prts-mcp',sha256:'current'}]};
  const evidence={version:receipt.version,packages:receipt.packages,platform:'linux-x64',arch:'x64',native:true,checks:Array(17).fill({})};
  verifyNpmEvidence(receipt,evidence,'linux-x64');
  assert.throws(()=>verifyNpmEvidence(receipt,{...evidence,packages:[{name:'prts-mcp',sha256:'previous'}]},'linux-x64'));
  assert.throws(()=>verifyNpmEvidence(receipt,{...evidence,arch:'arm64'},'linux-x64'));
});
test('self-consistent replacement Docker archive cannot reuse another archive runtime proof',()=>{
  const image={commit:'source',version:'3.0.0-alpha.1',imageId:'image',arch:'amd64'};
  const evidence={...image,platform:'linux-x64',native:true,checks:Array(10).fill({}),archiveSha256:'actually-loaded'};
  verifyDockerEvidence(image,evidence,'actually-loaded','linux-x64');
  assert.throws(()=>verifyDockerEvidence(image,evidence,'replacement-with-its-own-sidecar','linux-x64'));
  assert.throws(()=>verifyDockerEvidence(image,{...evidence,commit:'old-source'},'actually-loaded','linux-x64'));
});
