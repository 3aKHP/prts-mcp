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
for(const pkg of manifest.packages){
  const before=await tags(pkg.name);assert.equal(before[policy.npmTag],pkg.version);
  // A failed same-run attempt may have left this owned, exact-version probe.
  assert(!Object.hasOwn(before,probe)||before[probe]===pkg.version,'Conflicting verification tag');
  run('npm',['dist-tag','add',`${pkg.name}@${pkg.version}`,probe],{stdio:'inherit'});
  assert.equal((await tags(pkg.name))[probe],pkg.version);
  run('npm',['dist-tag','rm',pkg.name,probe],{stdio:'inherit'});
  const after=await tags(pkg.name);assert(!Object.hasOwn(after,probe),'Verification tag removal was not confirmed');
  const retained={...before};delete retained[probe];assert.deepEqual(after,retained,'Existing publication tags changed');
}
console.log(`NPM_TAG_PERMISSIONS_PASS: ${manifest.packages.length} packages; validation tags removed`);
