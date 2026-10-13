import assert from 'node:assert/strict';
import { writeFileSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { verifiedSnapshot } from './verify-snapshot.mjs';
import { run,repository } from './common.mjs';
const {directory,manifest,policy}=verifiedSnapshot();
const file=join(directory,'..','release-notes.md');
writeFileSync(file,`# PRTS-MCP ${policy.version}\n\nNative Rust candidate for testing before stable 3.0.\n\nDownload the candidate archive matching your OS/CPU, verify SHA256SUMS, extract, and run bin/prts-mcp (Windows: bin/prts-mcp.exe). Streamable HTTP defaults to port 3000; PRTS_TRANSPORT=stdio chooses stdio. Validated fallback data and dependency licenses are included. No compiler, Bun or additional native-library setup is needed. Exact platform baselines: https://github.com/${repository}/blob/${manifest.commit}/docs/dev/NATIVE-PLATFORMS.md\n\nDocker: ghcr.io/3akhp/prts-mcp:${policy.version} supports native Linux x64/ARM64 and preserves default stdio. Select PRTS_TRANSPORT=http for HTTP.\n\n${process.env.RUST_NPM_PUBLISH_ENABLED==='true'?'npm packages are published under next.':'npm registry publication remains pending maintainer account setup; the attached npm tarballs are for review, not a complete registry installation path.'}\n\nThis candidate has scoped build/install/runtime validation. Full real-client E2E, upgrades and rollback remain M4; documentation/data release gates remain open. Stable 2.8.1 and latest channels remain unchanged. Source: ${manifest.commit}.\n`);
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
