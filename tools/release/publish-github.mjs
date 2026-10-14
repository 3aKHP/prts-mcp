import assert from 'node:assert/strict';
import { writeFileSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { verifiedSnapshot } from './verify-snapshot.mjs';
import { run,repository,root } from './common.mjs';
import { releaseNotes } from './release-notes.mjs';
const {directory,manifest,policy}=verifiedSnapshot();
const file=join(directory,'..','release-notes.md');
writeFileSync(file,releaseNotes({english:readFileSync(join(root,'CHANGELOG.md'),'utf8'),
  chinese:readFileSync(join(root,'CHANGELOG.zh-CN.md'),'utf8'),policy,repository,commit:manifest.commit}));
let existing;
try {existing=JSON.parse(run('gh',['api',`repos/${repository}/releases/tags/${policy.tag}`]));}
catch(error){if(!/404/.test(String(error.stderr??'')+String(error.stdout??'')))throw error;}
if(existing){
  assert.equal(existing.tag_name,policy.tag);assert.equal(existing.prerelease,policy.prerelease);
  const assets=new Map(existing.assets.map(a=>[a.name,a]));
  for(const row of [...manifest.files,{filename:'RELEASE.json'},{filename:'SHA256SUMS'}]){
    const asset=assets.get(row.filename);
    if(!asset){run('gh',['release','upload',policy.tag,join(directory,row.filename),'--repo',repository],{stdio:'inherit'});continue;}
    const response=await fetch(asset.browser_download_url,{signal:AbortSignal.timeout(300000)});assert(response.ok);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),createHash('sha256').update(readFileSync(join(directory,row.filename))).digest('hex'),'Existing release asset cannot be overwritten');
  }
}else{
  run('gh',['release','create',policy.tag,'--repo',repository,'--verify-tag','--target',manifest.commit,'--title',`PRTS-MCP ${policy.version}`,
    '--notes-file',file,`--latest=${policy.githubLatest?'true':'false'}`,...(policy.prerelease?['--prerelease']:[]),
    ...manifest.files.map(row=>join(directory,row.filename)),join(directory,'RELEASE.json'),join(directory,'SHA256SUMS')],{stdio:'inherit'});
}
console.log(`GITHUB_PUBLICATION_PASS: ${policy.tag}`);
