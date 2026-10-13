import assert from 'node:assert/strict';
import { join } from 'node:path';
import { verifiedSnapshot } from './verify-snapshot.mjs';
import { run,sha } from './common.mjs';
const {directory,manifest,policy}=verifiedSnapshot();
if(process.env.RUST_NPM_PUBLISH_ENABLED!=='true')throw new Error('npm publication requires maintainer identity setup and enablement');
for(const pkg of manifest.packages){
  const file=join(directory,pkg.filename);assert.equal(sha(file),pkg.sha256);
  const endpoint=`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`;
  const response=await fetch(endpoint,{cache:'no-store',signal:AbortSignal.timeout(30000)});
  assert(response.ok||response.status===404,`Registry returned ${response.status}`);
  const meta=response.ok?await response.json():{versions:{},'dist-tags':{}};
  const existing=meta.versions?.[pkg.version];
  if(existing){
    assert.equal(existing.dist.integrity,pkg.integrity,'A published version cannot be overwritten with different bytes');
    console.log(`NPM_EXISTING_VERIFIED: ${pkg.name}@${pkg.version}`);
    if(meta['dist-tags']?.[policy.npmTag]!==pkg.version)run('npm',['dist-tag','add',`${pkg.name}@${pkg.version}`,policy.npmTag],{stdio:'inherit'});
  }else run('npm',['publish',file,'--access','public','--tag',policy.npmTag,'--ignore-scripts'],{stdio:'inherit'});
  const verified=await fetch(`${endpoint}/${encodeURIComponent(pkg.version)}`,{cache:'no-store',signal:AbortSignal.timeout(30000)});
  assert(verified.ok,`${pkg.name} was not readable after publishing`);
  assert.equal((await verified.json()).dist.integrity,pkg.integrity);
}
console.log(`NPM_PUBLICATION_PASS: ${manifest.packages.length} packages ${policy.version} (${policy.npmTag})`);
