import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root,version,config,id,arch,out,image,pin,readJson,json,sha,run,verifyNotices } from './common.mjs';
import { verifyExactInventory } from './inventory.mjs';

const native=join(root,'artifacts/native',id,'payload'),bundle=join(root,'artifacts/npm-bundle/data');
const build=readJson(join(native,'BUILD.json')),data=readJson(join(bundle,'BUNDLE.json'));
const commit=run('git',['rev-parse','HEAD']).trim();
assert.equal(build.platform,id);assert.equal(build.target,config.target);assert.equal(build.version,version);
assert.equal(build.commit,commit,'Repack current clean native source before building the image');assert.equal(build.dirty,false);
assert.equal(run('git',['status','--porcelain']).trim(),'','Distribution images require a clean source snapshot');
assert.equal(data.productVersion,version);
assert.equal(data.schema,'prts-mcp-bundle/v1');assert.equal(data.repo,pin.repo);
assert.equal(data.releaseTag,pin.release_tag);assert.equal(data.sourceVersion,pin.source_version);
assert.deepEqual(data.assets,pin.assets,'Prepare the current production data pin before packaging');
const nativeFiles=verifyExactInventory(native),dataFiles=verifyExactInventory(bundle),notices=verifyNotices(native);
const context=join(out,'context');rmSync(context,{recursive:true,force:true});mkdirSync(context,{recursive:true});
cpSync(native,join(context,'native-payload'),{recursive:true});cpSync(bundle,join(context,'bundle'),{recursive:true});
cpSync(join(root,'Dockerfile'),join(context,'Dockerfile'));
// Only explicitly verified inputs reach the context; no local root data/cache.
writeFileSync(join(context,'.dockerignore'),'.git\n');
run('docker',['build','--platform',`linux/${arch}`,'--label',`org.opencontainers.image.version=${version}`,
  '--label',`org.opencontainers.image.revision=${commit}`,'--label','org.opencontainers.image.source=https://github.com/3aKHP/prts-mcp',
  '--label',`io.prts-mcp.data.release=${data.releaseTag}`,'--tag',image,context],{stdio:'inherit'});
const inspected=JSON.parse(run('docker',['image','inspect',image]))[0];
assert.equal(inspected.Architecture,arch);assert.equal(inspected.Os,'linux');
json(join(out,'image.json'),{image,imageId:inspected.Id,platform:id,arch,commit,version,nativeBuild:build,dataBundle:data,
  nativeFiles:nativeFiles.length,dataFiles:dataFiles.length,noticeReferences:notices,config:inspected.Config,publicPublication:false});
const archive=join(out,`prts-mcp-${version}-${id}.docker.tar`);
run('docker',['image','save','--output',archive,image]);
run('gzip',['--force',archive]);
writeFileSync(archive+'.gz.sha256',`${sha(archive+'.gz')}  ${archive.split('/').at(-1)}.gz\n`);
console.log(`DOCKER_BUILD_PASS: ${id} ${inspected.Id}`);
