import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { root, version, targets, packageNames, verifyVersion, verifyBundle, verifyNpmEvidence, verifyDockerEvidence, zipMemberPattern, readJson, json, sha, run } from './common.mjs';
verifyVersion();
const input = resolve(process.argv[2] ?? join(root,'artifacts/incoming'));
const output = join(root,'artifacts/release');
const commit = run('git',['rev-parse','HEAD']).trim();
assert.equal(run('git',['status','--porcelain']).trim(),'','Release collection requires a clean source');
rmSync(output,{recursive:true,force:true});mkdirSync(output,{recursive:true});
const inventory=[], packages=new Map(), platforms=[];
const safe = name => {assert(name && !/[\\/]/.test(name) && name!=='.' && name!=='..');return name;};
function retain(path, name, kind) {
  safe(name);const digest=sha(path);assert(!inventory.some(f=>f.filename===name),'Duplicate release filename');
  cpSync(path,join(output,name));inventory.push({filename:name,sha256:digest,kind});return digest;
}
for(const [id,target]of Object.entries(targets)){
  const dir=join(input,`candidate-${id}`), candidate=readJson(join(dir,'candidate.json')), evidence=readJson(join(dir,'candidate-evidence.json'));
  assert.equal(candidate.platform,id);assert.equal(candidate.version,version);assert.equal(candidate.commit,commit);
  assert.equal(evidence.commit,commit);assert.equal(evidence.platform,id);assert.equal(evidence.version,version);assert.equal(evidence.native,true);
  assert.equal(evidence.arch,target.arch);assert.equal(evidence.checks.length,3);assert.equal(evidence.archiveSha256,candidate.sha256);
  const archive=join(dir,safe(candidate.filename));assert.equal(sha(archive),candidate.sha256);
  assert.equal(readFileSync(archive+'.sha256','utf8').trim(),`${candidate.sha256}  ${candidate.filename}`);
  const zipEntries = candidate.filename.endsWith('.zip') ? run('unzip',['-Z1',archive]).trim().split('\n') : null;
  const nativeJson = name => JSON.parse(zipEntries
    ? run('unzip',['-p',archive,zipMemberPattern(zipEntries,name)]) : run('tar',['-xOzf',archive,`./${name}`]));
  const packedCandidate=nativeJson('CANDIDATE.json'), packedBuild=nativeJson('BUILD.json');
  assert.equal(packedCandidate.commit,commit);assert.equal(packedCandidate.version,version);assert.equal(packedCandidate.platform,id);
  assert.equal(packedBuild.commit,commit);assert.equal(packedBuild.version,version);assert.equal(packedBuild.platform,id);assert.equal(packedBuild.dirty,false);
  verifyBundle(nativeJson('data/BUNDLE.json'));verifyBundle(packedCandidate.dataBundle);
  retain(archive,candidate.filename,'native-candidate');retain(archive+'.sha256',candidate.filename+'.sha256','checksum');
  retain(join(dir,'candidate.json'),`${id}-candidate.json`,'evidence');retain(join(dir,'candidate-evidence.json'),`${id}-candidate-evidence.json`,'evidence');
  platforms.push({platform:id,sha256:candidate.sha256,checks:evidence.checks});
  // upload-artifact preserves npm/{id} and native/{id} beneath their common artifacts/ root.
  const npmDir=join(input,`npm-${id}`,'npm',id), npm=readJson(join(npmDir,'packages.json')), npmEvidence=readJson(join(npmDir,'npm-evidence.json'));
  assert.equal(npm.version,version);assert.equal(npm.platform,id);assert.equal(npm.nativeBuild.commit,commit);assert.equal(npm.nativeBuild.dirty,false);
  assert.equal(npm.nativeBuild.version,version);verifyBundle(npm.dataBundle);
  verifyNpmEvidence(npm,npmEvidence,id);
  const expected=[`@3akhp/prts-mcp-${id}`,'@3akhp/prts-mcp-data','@3akhp/prts-mcp-runtime','prts-mcp','prts-mcp-ts'];
  assert.deepEqual(npm.packages.map(p=>p.name).sort(),expected.sort());
  for(const p of npm.packages){
    assert.equal(p.version,version);const tarball=join(npmDir,'tarballs',safe(p.filename));assert.equal(sha(tarball),p.sha256);
    assert.equal('sha512-'+createHash('sha512').update(readFileSync(tarball)).digest('base64'),p.integrity);
    if(packages.has(p.name)){assert.equal(packages.get(p.name).sha256,p.sha256,'Shared npm tarballs differ across native runners');continue;}
    const extract = file=>JSON.parse(run('tar',['-xOzf',tarball,`package/${file}`]));
    const meta=extract('package.json');assert.equal(meta.name,p.name);assert.equal(meta.version,version);
    assert.equal(meta.repository.url,'https://github.com/3aKHP/prts-mcp.git');
    if(p.name===`@3akhp/prts-mcp-${id}`){
      const build=extract('BUILD.json');assert.equal(build.commit,commit);assert.equal(build.dirty,false);assert.equal(build.version,version);assert.equal(build.platform,id);
      assert.deepEqual(meta.os,[target.os]);assert.deepEqual(meta.cpu,[target.arch]);
    }else if(p.name==='@3akhp/prts-mcp-data')verifyBundle(extract('data/BUNDLE.json'));
    else if(p.name==='@3akhp/prts-mcp-runtime'){
      assert.deepEqual(meta.dependencies,{'@3akhp/prts-mcp-data':version});
      assert.deepEqual(meta.optionalDependencies,Object.fromEntries(Object.keys(targets).map(t=>[`@3akhp/prts-mcp-${t}`,version])));
    }else assert.deepEqual(meta.dependencies,{'@3akhp/prts-mcp-runtime':version});
    retain(tarball,p.filename,'npm');packages.set(p.name,p);
  }
  retain(join(npmDir,'npm-evidence.json'),`${id}-npm-evidence.json`,'evidence');
  if(target.os==='linux'){
    const dockerDir=join(input,`docker-${id}`), image=readJson(join(dockerDir,'image.json')), docker=readJson(join(dockerDir,'docker-evidence.json'));
    assert.equal(image.commit,commit);assert.equal(image.version,version);assert.equal(image.platform,id);assert.equal(image.nativeBuild.dirty,false);verifyBundle(image.dataBundle);
    assert.equal(image.nativeBuild.commit,commit);assert.equal(image.nativeBuild.version,version);assert.equal(image.nativeBuild.platform,id);
    const filename=`prts-mcp-${version}-${id}.docker.tar.gz`, file=join(dockerDir,filename);
    assert.equal(readFileSync(file+'.sha256','utf8').trim(),`${sha(file)}  ${filename}`);
    verifyDockerEvidence(image,docker,sha(file),id);
    retain(file,filename,'docker');retain(file+'.sha256',filename+'.sha256','checksum');
    retain(join(dockerDir,'image.json'),`${id}-image.json`,'evidence');retain(join(dockerDir,'docker-evidence.json'),`${id}-docker-evidence.json`,'evidence');
  }
}
assert.deepEqual([...packages.keys()].sort(),[...packageNames].sort(),'All nine unique npm packages are required');
const publishOrder=packageNames.map(name=>packages.get(name));
json(join(output,'RELEASE.json'),{schema:'prts-mcp-release/v1',version,commit,platforms,packages:publishOrder,files:inventory,publicPublication:false});
writeFileSync(join(output,'SHA256SUMS'),[...inventory.map(f=>`${f.sha256}  ${f.filename}`),`${sha(join(output,'RELEASE.json'))}  RELEASE.json`].join('\n')+'\n');
console.log(`RELEASE_COLLECT_PASS: ${platforms.length} native candidates, ${packages.size} npm packages, 2 Docker images (${commit})`);
