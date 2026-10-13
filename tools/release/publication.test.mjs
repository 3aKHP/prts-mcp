import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync,spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const project=fileURLToPath(new URL('../../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(mode='fresh') {
  const root=mkdtempSync(join(tmpdir(),'prts-publish-test-'));
  const put=(path,body)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),body);};
  for(const file of ['tools/npm/common.mjs','tools/docker/inventory.mjs','tools/release/common.mjs','tools/release/verify-snapshot.mjs','tools/release/publish-npm.mjs','tools/release/publish-docker.mjs','tools/release/publish-github.mjs','packaging/native/targets.json','packaging/npm/data-release.json']){
    mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(join(project,file),join(root,file));
  }
  put('Cargo.toml','[package]\nname = "prts-mcp"\nversion = "3.0.0-alpha.1"\n');
  execFileSync('git',['init','--quiet'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--quiet','-m','fixture'],{cwd:root});
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const targets=JSON.parse(readFileSync(join(root,'packaging/native/targets.json')));
  const names=[...Object.keys(targets).map(id=>`@3akhp/prts-mcp-${id}`),'@3akhp/prts-mcp-data','@3akhp/prts-mcp-runtime','prts-mcp','prts-mcp-ts'];
  const files=[],add=(filename,bytes,kind='evidence')=>{put('artifacts/release/'+filename,bytes);files.push({filename,sha256:hash(bytes),kind});};
  const packages=names.map((name,i)=>{const filename=`pkg-${i}.tgz`,body=`fixture-${name}`;add(filename,body,'npm');return{name,version:'3.0.0-alpha.1',filename,sha256:hash(body),integrity:'sha512-fixture'};});
  for(const id of ['linux-x64','linux-arm64']){
    add(`${id}-image.json`,JSON.stringify({commit,image:`local:${id}`,imageId:`sha256:${id}`}));
    add(`prts-mcp-3.0.0-alpha.1-${id}.docker.tar.gz`,'mock verified image');
  }
  const manifest={schema:'prts-mcp-release/v1',version:'3.0.0-alpha.1',commit,platforms:Object.keys(targets).map(platform=>({platform})),packages,files};
  put('artifacts/release/RELEASE.json',JSON.stringify(manifest));
  put('artifacts/release/SHA256SUMS',[...files.map(f=>`${f.sha256}  ${f.filename}`),`${hash(JSON.stringify(manifest))}  RELEASE.json`].join('\n')+'\n');
  const mock=join(root,'mock'),log=join(root,'commands.jsonl');mkdirSync(mock);
  const program=`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2),name=require('node:path').basename(process.argv[1]);fs.appendFileSync(process.env.TEST_COMMAND_LOG,JSON.stringify({name,args})+'\\n');const mode=process.env.TEST_MODE;\nif(name==='gh'){if(args[0]==='api'){if(mode==='partial')console.log(JSON.stringify({tag_name:'v3.0.0-alpha.1',prerelease:true,assets:[]}));else{console.error('HTTP 404');process.exit(1);}}}\nif(name==='docker'){if(args[0]==='pull'){if(mode==='conflict'||mode==='wrong-index')process.exit(0);console.error('manifest unknown');process.exit(1);}if(args[0]==='image'){const id=args[2].includes('arm64')?'linux-arm64':'linux-x64';console.log(JSON.stringify([{Id:args[2].startsWith('ghcr.io')&&mode==='conflict'?'sha256:wrong':'sha256:'+id,Architecture:id==='linux-arm64'?'arm64':'amd64'}]));}if(args[0]==='buildx'&&args[2]==='inspect'){if(args.includes('--format'))console.log('sha256:'+(args[3].includes('arm64')?'arm64':'amd64'));else{const state=process.env.TEST_STATE;if(!fs.existsSync(state)&&mode!=='wrong-index'){console.error('manifest unknown');process.exit(1);}console.log(JSON.stringify({manifests:[{digest:'sha256:amd64',platform:{os:'linux',architecture:mode==='wrong-index'?'arm64':'amd64'}},{digest:'sha256:arm64',platform:{os:'linux',architecture:mode==='wrong-index'?'amd64':'arm64'}}]}));}}if(args[0]==='buildx'&&args[2]==='create')fs.writeFileSync(process.env.TEST_STATE,'yes');}\n`;
  for(const name of ['docker','gh','npm']){put('mock/'+name,program);execFileSync('chmod',['+x',join(mock,name)]);}
  put('mock/fetch.mjs',`import {readFileSync,existsSync} from 'node:fs';
import {basename} from 'node:path';
const packages=JSON.parse(readFileSync(new URL('../artifacts/release/RELEASE.json',import.meta.url))).packages;
const mode=process.env.TEST_NPM_MODE;let reads=0;
if(mode==='invisible'){let clock=0;Date.now=()=>clock+=300001;}
const commands=()=>existsSync(process.env.TEST_COMMAND_LOG)?readFileSync(process.env.TEST_COMMAND_LOG,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
globalThis.fetch=async url=>{
 const path=decodeURIComponent(new URL(url).pathname).slice(1),tagsRequest=path.startsWith('-/package/');
 const pkg=packages.find(p=>path===p.name||path===p.name+'/'+p.version||path==='-/package/'+p.name+'/dist-tags');
 if(!pkg)throw new Error('Unexpected mock registry request: '+url);
 const calls=commands().filter(c=>c.name==='npm'),published=calls.some(c=>c.args[0]==='publish'&&basename(c.args[1])===pkg.filename);
 if(path===pkg.name+'/'+pkg.version){
  if(mode==='invisible'||(mode==='delayed'&&pkg===packages[0]&&reads++===0))return new Response('{}',{status:404});
  return new Response(JSON.stringify({dist:{integrity:pkg.integrity}}));
 }
 const fresh=mode==='fresh'||mode==='delayed'||mode==='invisible';
 if(fresh&&!published&&!tagsRequest&&pkg.name!=='prts-mcp-ts')return new Response('{}',{status:404});
 const tags={latest:'2.8.1',beta:'1.0.0-beta.1'};
 if(!fresh)tags.next=mode==='repair'?'2.8.1':pkg.version;
 if(mode==='bootstrap'&&pkg.name!=='prts-mcp-ts')tags.latest=pkg===packages[0]||pkg===packages[1]?'3.0.0-alpha.1':'0.0.0-stage';
 if(fresh&&published){tags.next=pkg.version;if(pkg.name!=='prts-mcp-ts')tags.latest=pkg.version;}
 if(mode==='stable-change'&&pkg.name==='prts-mcp-ts')tags.latest=pkg.version;
 for(const call of calls){
  const a=call.args;
  if(a[0]==='dist-tag'&&a[1]==='rm'&&a[2]===pkg.name)delete tags[a[3]];
  if(a[0]==='dist-tag'&&a[1]==='add'&&a[2]===pkg.name+'@'+pkg.version)tags[a[3]]=pkg.version;
 }
 if(tagsRequest)return new Response(JSON.stringify(tags));
 const versions=fresh&&!published?{}:{[pkg.version]:{dist:{integrity:mode==='conflict'?'sha512-conflict':pkg.integrity}}};
 return new Response(JSON.stringify({versions,'dist-tags':tags}));
};`);
  const env={...process.env,PATH:mock+':'+process.env.PATH,GITHUB_REF:'refs/tags/v3.0.0-alpha.1',GITHUB_REPOSITORY:'3aKHP/prts-mcp',RUST_STABLE_RELEASE_ENABLED:'false',RUST_NPM_PUBLISH_ENABLED:'false',TEST_COMMAND_LOG:log,TEST_MODE:mode,TEST_STATE:join(root,'state')};
  return {root,env,manifest,run:name=>spawnSync(process.execPath,[join(root,'tools/release',name+'.mjs')],{cwd:root,env,encoding:'utf8'}),commands:()=>readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('npm stays disabled without account setup and executes no publishing command',()=>{
  const f=fixture();try{const r=f.run('publish-npm');assert.notEqual(r.status,0);assert.match(r.stderr,/maintainer identity setup/);}finally{f.cleanup();}
});
test('corrupt downloaded candidate cannot reach public write commands',()=>{
  const f=fixture();try{writeFileSync(join(f.root,'artifacts/release/pkg-0.tgz'),'corruption');const r=f.run('publish-docker');assert.notEqual(r.status,0);assert.match(r.stderr,/checksum/);}finally{f.cleanup();}
});
test('Docker pushes both verified native images and candidate channels only',()=>{
  const f=fixture();try{const r=f.run('publish-docker');assert.equal(r.status,0,r.stderr);const c=f.commands();assert.equal(c.filter(x=>x.args[0]==='push').length,2);const tags=c.filter(x=>x.args[0]==='buildx'&&x.args[2]==='create').map(x=>x.args[4]);assert.deepEqual(tags,['ghcr.io/3akhp/prts-mcp:3.0.0-alpha.1','ghcr.io/3akhp/prts-mcp:next']);assert(c.filter(x=>x.args[0]==='buildx'&&x.args[2]==='create').every(x=>JSON.stringify(x.args.slice(-2))===JSON.stringify(['ghcr.io/3akhp/prts-mcp@sha256:amd64','ghcr.io/3akhp/prts-mcp@sha256:arm64'])));}finally{f.cleanup();}
});
test('conflicting immutable Docker version is rejected before any push',()=>{
  const f=fixture('conflict');try{const r=f.run('publish-docker');assert.notEqual(r.status,0);assert.match(r.stderr,/Immutable version image differs/);assert(!f.commands().some(x=>x.args[0]==='push'));}finally{f.cleanup();}
});
test('GitHub candidate publication sets prerelease and keeps Latest unchanged',()=>{
  const f=fixture();try{const r=f.run('publish-github');assert.equal(r.status,0,r.stderr);const create=f.commands().find(x=>x.args[0]==='release'&&x.args[1]==='create');assert(create.args.includes('--latest=false'));assert(create.args.includes('--prerelease'));assert(create.args.includes('--verify-tag'));}finally{f.cleanup();}
});
test('partial GitHub release retries upload missing assets without overwriting',()=>{
  const f=fixture('partial');try{const r=f.run('publish-github');assert.equal(r.status,0,r.stderr);const c=f.commands();assert.equal(c.filter(x=>x.args[0]==='release'&&x.args[1]==='upload').length,f.manifest.files.length+2);assert(!c.some(x=>x.args.includes('--clobber')));assert(!c.some(x=>x.args[1]==='create'));}finally{f.cleanup();}
});

test('npm publishes nine dependencies in snapshot order under next',()=>{
  const f=fixture();try{
    f.env.RUST_NPM_PUBLISH_ENABLED='true';f.env.TEST_NPM_MODE='fresh';f.env.NODE_OPTIONS='--import='+join(f.root,'mock/fetch.mjs');
    const r=f.run('publish-npm');assert.equal(r.status,0,r.stderr);const calls=f.commands().filter(c=>c.name==='npm');
    const publishes=calls.filter(c=>c.args[0]==='publish');
    assert.equal(publishes.length,9);assert.deepEqual(publishes.map(c=>c.args[1]),f.manifest.packages.map(p=>join(f.root,'artifacts/release',p.filename)));
    assert(publishes.every(c=>c.args[c.args.indexOf('--tag')+1]==='next'&&c.args.includes('--ignore-scripts')));
    assert.deepEqual(calls.filter(c=>c.args[1]==='rm').map(c=>c.args),f.manifest.packages.slice(0,8).map(p=>['dist-tag','rm',p.name,'latest']));
  }finally{f.cleanup();}
});
test('npm rejects existing version with different integrity before any publish',()=>{
  const f=fixture();try{
    f.env.RUST_NPM_PUBLISH_ENABLED='true';f.env.TEST_NPM_MODE='conflict';f.env.NODE_OPTIONS='--import='+join(f.root,'mock/fetch.mjs');
    const r=f.run('publish-npm');assert.notEqual(r.status,0);assert.match(r.stderr,/cannot be overwritten/);
  }finally{f.cleanup();}
});

test('matching existing npm versions repair next without republishing or touching stable tags',()=>{
  const f=fixture();try{
    f.env.RUST_NPM_PUBLISH_ENABLED='true';f.env.TEST_NPM_MODE='repair';f.env.NODE_OPTIONS='--import='+join(f.root,'mock/fetch.mjs');
    const r=f.run('publish-npm');assert.equal(r.status,0,r.stderr);const calls=f.commands().filter(c=>c.name==='npm');
    assert.deepEqual(calls.map(c=>c.args),f.manifest.packages.map(p=>['dist-tag','add',p.name+'@'+p.version,'next']));
  }finally{f.cleanup();}
});

test('existing Docker manifest with swapped CPU descriptors cannot advance next',()=>{
  const f=fixture('wrong-index');try{
    const r=f.run('publish-docker');assert.notEqual(r.status,0);assert.match(r.stderr,/actual native architecture/);
    assert(!f.commands().some(c=>c.args[0]==='push'||c.args[2]==='create'));
  }finally{f.cleanup();}
});


test('bootstrap latest aliases are removed only from eight new names, preserving legacy stable tags',()=>{
  const f=fixture();try{
    f.env.RUST_NPM_PUBLISH_ENABLED='true';f.env.TEST_NPM_MODE='bootstrap';f.env.NODE_OPTIONS='--import='+join(f.root,'mock/fetch.mjs');
    const r=f.run('publish-npm');assert.equal(r.status,0,r.stderr);
    assert.deepEqual(f.commands().map(c=>c.args),f.manifest.packages.slice(0,8).map(p=>['dist-tag','rm',p.name,'latest']));
  }finally{f.cleanup();}
});
test('accepted upload waits for a public version before publishing its dependencies',()=>{
  const f=fixture();try{
    f.env.RUST_NPM_PUBLISH_ENABLED='true';f.env.TEST_NPM_MODE='delayed';f.env.NODE_OPTIONS='--import='+join(f.root,'mock/fetch.mjs');
    const r=f.run('publish-npm');assert.equal(r.status,0,r.stderr);assert.equal(f.commands().filter(c=>c.args[0]==='publish').length,9);
  }finally{f.cleanup();}
});
test('an upload that never becomes public stops before advancing to later packages',()=>{
  const f=fixture();try{
    f.env.RUST_NPM_PUBLISH_ENABLED='true';f.env.TEST_NPM_MODE='invisible';f.env.NODE_OPTIONS='--import='+join(f.root,'mock/fetch.mjs');
    const r=f.run('publish-npm');assert.notEqual(r.status,0);assert.match(r.stderr,/within five minutes/);
    assert.equal(f.commands().filter(c=>c.args[0]==='publish').length,1);assert(!f.commands().some(c=>c.args[0]==='dist-tag'));
  }finally{f.cleanup();}
});
