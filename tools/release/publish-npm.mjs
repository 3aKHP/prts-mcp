import assert from 'node:assert/strict';
import { join } from 'node:path';
import { verifiedSnapshot } from './verify-snapshot.mjs';
import { run,sha } from './common.mjs';
const {directory,manifest,policy}=verifiedSnapshot();
if(process.env.RUST_NPM_PUBLISH_ENABLED!=='true')throw new Error('npm publication requires maintainer identity setup and enablement');
async function registry(url) {
  const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(30000)});
  assert(response.ok||response.status===404,`Registry returned ${response.status}`);
  return response.ok?await response.json():undefined;
}
async function publishedVersion(endpoint,pkg) {
  // npm may accept an upload before its asynchronous validation makes it public.
  const deadline=Date.now()+300000;
  while(true){
    const version=await registry(`${endpoint}/${encodeURIComponent(pkg.version)}`);
    if(version){assert.equal(version.dist.integrity,pkg.integrity);return;}
    assert(Date.now()<deadline,`${pkg.name} was not readable within five minutes after publishing`);
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
}
for(const pkg of manifest.packages){
  const file=join(directory,pkg.filename);assert.equal(sha(file),pkg.sha256);
  const endpoint=`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`;
  const meta=await registry(endpoint)||{versions:{},'dist-tags':{}};
  const existing=meta.versions?.[pkg.version];
  if(existing){
    assert.equal(existing.dist.integrity,pkg.integrity,'A published version cannot be overwritten with different bytes');
    console.log(`NPM_EXISTING_VERIFIED: ${pkg.name}@${pkg.version}`);
    if(meta['dist-tags']?.[policy.npmTag]!==pkg.version)run('npm',['dist-tag','add',`${pkg.name}@${pkg.version}`,policy.npmTag],{stdio:'inherit'});
  }else run('npm',['publish',file,'--access','public','--tag',policy.npmTag,'--ignore-scripts'],{stdio:'inherit'});
  await publishedVersion(endpoint,pkg);
  const tagsEndpoint=`https://registry.npmjs.org/-/package/${encodeURIComponent(pkg.name)}/dist-tags`;
  const tags=await registry(tagsEndpoint);assert(tags,`${pkg.name} has no public tags`);
  // npm requires latest and creates it on first registration, even under next.
  // Preserve that initial alias; only M5 may deliberately advance stable latest.
  if(policy.prerelease&&!meta['dist-tags']?.latest&&Object.hasOwn(tags,'latest')){
    assert(pkg.name!=='prts-mcp-ts'&&tags.latest===pkg.version,'Unexpected initial latest tag');
    console.log(`NPM_INITIAL_LATEST_PRESERVED: ${pkg.name}@${tags.latest}`);
  }
  assert.equal(tags[policy.npmTag],pkg.version,`${pkg.name} candidate tag was not confirmed`);
  for(const [tag,value] of Object.entries(meta['dist-tags']||{})){
    if(tag===policy.npmTag)continue;
    assert.equal(tags[tag],value,`${pkg.name} existing ${tag} tag changed`);
  }
}
console.log(`NPM_PUBLICATION_PASS: ${manifest.packages.length} packages ${policy.version} (${policy.npmTag})`);
