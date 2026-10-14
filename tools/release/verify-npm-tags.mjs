import assert from 'node:assert/strict';
import { verifiedSnapshot } from './verify-snapshot.mjs';
import { run } from './common.mjs';
const {manifest,policy}=verifiedSnapshot();
assert(process.env.RUST_NPM_PUBLISH_ENABLED==='true','npm tag verification requires publication enablement');
const runId=process.env.GITHUB_RUN_ID;
assert(/^\d+$/.test(runId||''),'Tag permission verification requires a GitHub run ID');
const probe=`prts-release-check-${runId}`;
async function tags(name){
  const response=await fetch(`https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`,
    {cache:'no-store',signal:AbortSignal.timeout(30000)});
  assert(response.ok,`Tag verification returned ${response.status}`);return response.json();
}
async function confirmedTags(name,retained,present){
  const deadline=Date.now()+300000;
  while(true){
    const observed=await tags(name),unchanged={...observed};delete unchanged[probe];
    assert.deepEqual(unchanged,retained,'Existing publication tags changed');
    assert(!Object.hasOwn(observed,probe)||observed[probe]===manifest.version,'Conflicting verification tag');
    if(Object.hasOwn(observed,probe)===present)return observed;
    assert(Date.now()<deadline,`Verification tag ${present?'addition':'removal'} was not confirmed within five minutes`);
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
}
for(const pkg of manifest.packages){
  const before=await tags(pkg.name);assert.equal(before[policy.npmTag],pkg.version);
  // A failed same-run attempt may have left this owned, exact-version probe.
  assert(!Object.hasOwn(before,probe)||before[probe]===pkg.version,'Conflicting verification tag');
  const retained={...before};delete retained[probe];
  run('npm',['dist-tag','add',`${pkg.name}@${pkg.version}`,probe],{stdio:'inherit'});
  try{
    await confirmedTags(pkg.name,retained,true);
  }finally{
    run('npm',['dist-tag','rm',pkg.name,probe],{stdio:'inherit'});
    await confirmedTags(pkg.name,retained,false);
  }
}
console.log(`NPM_TAG_PERMISSIONS_PASS: ${manifest.packages.length} packages; validation tags removed`);
