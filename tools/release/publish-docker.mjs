import assert from 'node:assert/strict';
import { join } from 'node:path';
import { verifiedSnapshot } from './verify-snapshot.mjs';
import { readJson,run } from './common.mjs';
const {directory,manifest,policy}=verifiedSnapshot();
const registry='ghcr.io/3akhp/prts-mcp',sources=[],digests=[];
for(const [id,arch]of [['linux-x64','amd64'],['linux-arm64','arm64']]){
  const receipt=readJson(join(directory,`${id}-image.json`));assert.equal(receipt.commit,manifest.commit);
  const file=join(directory,`prts-mcp-${policy.version}-${id}.docker.tar.gz`);
  run('docker',['load','--input',file],{stdio:'inherit'});
  const actual=JSON.parse(run('docker',['image','inspect',receipt.image]))[0];
  assert.equal(actual.Id,receipt.imageId);assert.equal(actual.Architecture,arch);
  const remote=`${registry}:${policy.version}-${id}`;
  let found=false;
  try {run('docker',['pull','--platform',`linux/${arch}`,remote],{stdio:'pipe'});found=true;}
  catch(error){const message=String(error.stderr??'');if(!/manifest unknown|name unknown|not found/i.test(message))throw error;}
  if(found){const existing=JSON.parse(run('docker',['image','inspect',remote]))[0];assert.equal(existing.Id,actual.Id,'Immutable version image differs');}
  else {run('docker',['tag',receipt.image,remote]);run('docker',['push',remote],{stdio:'inherit'});}
  sources.push(remote);digests.push(run('docker',['buildx','imagetools','inspect',remote,'--format','{{.Manifest.Digest}}']).trim());
}
for(const tag of policy.dockerTags){
  if(tag===policy.version){
    let existing;
    try{existing=JSON.parse(run('docker',['buildx','imagetools','inspect',`${registry}:${tag}`,'--raw']));}
    catch(error){if(!/manifest unknown|name unknown|not found/i.test(String(error.stderr??'')))throw error;}
    if(existing){assert.deepEqual(existing.manifests.map(m=>m.digest).sort(),[...digests].sort(),'Immutable version manifest differs');continue;}
  }
  run('docker',['buildx','imagetools','create','--tag',`${registry}:${tag}`,...sources],{stdio:'inherit'});
  const index=JSON.parse(run('docker',['buildx','imagetools','inspect',`${registry}:${tag}`,'--raw']));
  assert.deepEqual(index.manifests.filter(m=>m.platform?.os==='linux').map(m=>m.platform.architecture).sort(),['amd64','arm64']);
}
console.log(`DOCKER_PUBLICATION_PASS: ${policy.version} both verified native architectures`);
