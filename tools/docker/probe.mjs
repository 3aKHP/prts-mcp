import assert from 'node:assert/strict';
import { cpSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { root,out,image,id,arch,version,pin,mirrorImage,readJson,json,sha,run } from './common.mjs';
import { stdio } from '../npm/mcp.mjs';

const receipt=readJson(join(out,'image.json'));
const archive=join(out,`prts-mcp-${version}-${id}.docker.tar.gz`);
assert.equal(sha(archive),readFileSync(archive+'.sha256','utf8').split(/\s+/)[0]);
run('docker',['image','load','--input',archive]);
const inspected=JSON.parse(run('docker',['image','inspect',image]))[0];
assert.equal(inspected.Id,receipt.imageId);assert.equal(inspected.Architecture,arch);
assert.deepEqual(inspected.Config.Entrypoint,['/usr/bin/tini','-g','--','/app/bin/prts-mcp-ghcr']);
assert.equal(inspected.Config.User,'0:0');assert(inspected.Config.Env.includes('PRTS_MCP_ROOT=/app'));
assert.equal(inspected.Config.Labels['org.opencontainers.image.version'],version);
assert.equal(inspected.Config.Labels['org.opencontainers.image.revision'],receipt.commit);
const temp=mkdtempSync(join(root,'.runtime/docker-probe-'));
const prefix=`prts-m2c-${id}-${process.pid}`,network=`${prefix}-net`,mirror=`${prefix}-mirror`;
const containers=new Set(),checks=[];let networkCreated=false;
const docker=(args,opts={})=>run('docker',args,opts);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const commonEnv={IMAGES_ENABLED:'false',LOCAL_IMAGE:'false',PRTS_OUTPUT_CHANNEL:'content',PRTS_AUTO_SYNC_INTERVAL_SECONDS:'0',GITHUB_MIRRORS:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',https_proxy:'http://127.0.0.1:9'};
const envArgs=e=>Object.entries({...commonEnv,...e}).flatMap(([k,v])=>['-e',`${k}=${v}`]);
const ownedUser=['--user',`${process.getuid()}:${process.getgid()}`];
const readonly=['--read-only','--tmpfs','/tmp:rw,nosuid,nodev,mode=1777'];
function mounts(vol,separate=false){return separate?['--tmpfs','/data:rw,nosuid,nodev,mode=1777',...['gamedata','gamedata-levels','storyjson','images'].flatMap(name=>['-v',`${join(vol,name)}:/data/${name}`])]:['-v',`${vol}:/data`];}
function volume(dir){mkdirSync(dir,{recursive:true});for(const name of ['gamedata','gamedata-levels','storyjson','images'])mkdirSync(join(dir,name));return dir;}
function startStdio(name,args=[],env={}){containers.add(name);return spawn('docker',['run','--rm','-i','--name',name,...args,...envArgs(env),image],{cwd:temp,stdio:['pipe','pipe','pipe']});}
async function asyncRun(command,args,env=process.env){
 const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});
 let timer;try{const [code]=await Promise.race([once(child,'close'),new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error(`Child timeout: ${stderr}`));},300000);})]);assert.equal(code,0,stderr);return stdout;}finally{clearTimeout(timer);}
}
function fileInventory(dir){const hashes={};function visit(p){for(const e of readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())visit(f);else{assert(e.isFile());hashes[f.slice(dir.length+1)]=sha(f);}}}visit(dir);return hashes;}
function payloadHashes(dir){const files=fileInventory(dir);return Object.fromEntries(Object.entries(files).filter(([f])=>!f.endsWith('.lock')&&!f.includes('/archives/')));}
async function http(name,vol,{separate=false,env={},networkName=network}={}){
 containers.add(name);docker(['run','-d','--name',name,...ownedUser,...readonly,...mounts(vol,separate),'--network',networkName,
 '-p','127.0.0.1::3000',...envArgs({...env,PRTS_TRANSPORT:' HtTp ',HOST:'0.0.0.0'}),image]);
 const details=JSON.parse(docker(['inspect',name]))[0];
 assert(details.State.Running,`${JSON.stringify(details.State)} ${docker(['logs',name],{maxBuffer:1<<20})}`);
 const bindings=details.NetworkSettings.Ports['3000/tcp'];
 assert(bindings?.length,`Port not published: ${JSON.stringify({ports:details.NetworkSettings.Ports,bindings:details.HostConfig.PortBindings,network:details.HostConfig.NetworkMode})}`);
 const port=bindings[0].HostPort;
 const origin=`http://127.0.0.1:${port}`;let ready=false;
 for(let i=0;i<150;i++){try{if((await fetch(origin+'/health',{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await delay(100);}
 assert(ready,docker(['logs',name],{maxBuffer:1<<20}));
 async function call(method,params,serial,headers={}){
 const res=await fetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...headers},
 body:JSON.stringify({jsonrpc:'2.0',id:serial,method,params}),signal:AbortSignal.timeout(20000)});
 const text=await res.text();assert.equal(res.status,200,text);
 const msg=JSON.parse(res.headers.get('content-type').includes('text/event-stream')?text.split('\n').find(l=>l.startsWith('data: ')).slice(6):text);
 assert(!msg.error,JSON.stringify(msg));return {message:msg,session:res.headers.get('mcp-session-id')};}
 const hello=await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'docker-probe',version:'1'}},1);
 assert.equal(hello.message.result.serverInfo.version,version);
 const headers={'Mcp-Session-Id':hello.session};
 return {origin,call:async(name,args={})=>(await call('tools/call',{name,arguments:args},2,headers)).message.result,
 modern:async()=>{const r=await call('tools/list',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'docker-probe',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}},3,{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/list'});return r.message.result;}};
}
async function stop(name){docker(['stop','--time','5',name]);const state=JSON.parse(docker(['inspect',name]))[0].State;assert.equal(state.Running,false);assert.equal(state.ExitCode,143,'tini must forward SIGTERM rather than wait for SIGKILL');return state.ExitCode;}
try {
 docker(['network','create',network]);networkCreated=true;
 console.log(`DOCKER_STAGE: ${id} packaged integrity and offline stdio`);
 docker(['run','--rm','--network','none','--entrypoint','/bin/sh',image,'-ec',
 "cd /app; sha256sum -c SHA256SUMS >/dev/null; cd /app/data; sha256sum -c SHA256SUMS >/dev/null; test -r /usr/share/doc/tini/copyright; for x in node bun python python3 rustc cargo cc gcc; do ! command -v $x; done"]);
 checks.push({case:'native/data hashes, original notices and no compiler/language business runtime',nativeFiles:receipt.nativeFiles,dataFiles:receipt.dataFiles});
 checks.push({case:'default root stdio, invalid PORT ignored, actual offline bundle query and EOF',...await stdio(startStdio(`${prefix}-stdio`,['--network','none',...readonly],{PORT:'abc'}),version)});
 const fresh=volume(join(temp,'fresh'));
 checks.push({case:'non-root read-only rootfs with empty whole /data volume offline fallback',...await stdio(startStdio(`${prefix}-user`,[...ownedUser,...readonly,...mounts(fresh),'--network','none']),version)});
 const bad=await new Promise((resolve,reject)=>{const child=startStdio(`${prefix}-bad`,['--network','none'],{PRTS_TRANSPORT:'http',PORT:'abc'});let stderr='',stdout='';child.stderr.on('data',d=>{stderr+=d;});child.stdout.on('data',d=>{stdout+=d;});child.stdin.end();const timer=setTimeout(()=>{child.kill();reject(Error('Invalid PORT exit timeout'));},15000);child.on('close',code=>{clearTimeout(timer);resolve({code,stderr,stdout});});});
 assert.equal(bad.code,1);assert.equal(bad.stdout,'');assert.match(bad.stderr,/PORT must be numeric/);
 checks.push({case:'GHCR HTTP non-numeric PORT reports stderr and exits 1'});
 const off=await http(`${prefix}-http`,fresh);assert.match(JSON.stringify(await off.call('get_operator_basic_info',{name:'阿米娅'})),/阿米娅/);assert.equal((await off.modern()).tools.length,23);
 assert.equal(docker(['exec',`${prefix}-http`,'cat','/proc/1/comm']).trim(),'tini');
 checks.push({case:'explicit HTTP with default PORT 3000, legacy/modern MCP and tini PID1 stop',exit:await stop(`${prefix}-http`)});
 console.log(`DOCKER_STAGE: ${id} isolated mirror and actual legacy TS volume`);
 const fixture=join(temp,'mirror');mkdirSync(fixture);const lines=[];
 for(const asset of pin.assets){const src=join(root,'.runtime/npm-data',pin.release_tag,asset.name);assert.equal(sha(src),asset.sha256);cpSync(src,join(fixture,asset.name));lines.push(`https://github.com/${pin.repo}/releases/download/${pin.release_tag}/${asset.name} ${asset.name}`);}
 writeFileSync(join(fixture,'assets.txt'),lines.join('\n')+'\n');
 json(join(fixture,'releases.json'),[{tag_name:pin.release_tag,created_at:'2026-10-08T05:00:00Z',assets:pin.assets.map(a=>({name:a.name,browser_download_url:`https://github.com/${pin.repo}/releases/download/${pin.release_tag}/${a.name}`}))}]);
 docker(['pull',mirrorImage],{stdio:'inherit'});
 containers.add(mirror);docker(['run','-d','--name',mirror,'--network',network,'-p','127.0.0.1::8080',...ownedUser,'--read-only',
 '-v',`${fixture}:/fixture:ro`,'-v',`${join(root,'tools/docker/mirror.mjs')}:/mirror.mjs:ro`,mirrorImage,'node','/mirror.mjs','/fixture']);
 const mirrorPort=JSON.parse(docker(['inspect',mirror]))[0].NetworkSettings.Ports['8080/tcp'][0].HostPort;
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${mirrorPort}/https://api.github.com/test`)).ok)break;}catch{}await delay(100);}
 const legacyBase=join(temp,'legacy'),legacy=join(legacyBase,'prts-mcp');mkdirSync(legacyBase);
 const tsEnv={...process.env,IMAGES_ENABLED:'false',LOCAL_IMAGE:'false',PRTS_AUTO_SYNC_INTERVAL_SECONDS:'0',PRTS_OUTPUT_CHANNEL:'content',HTTPS_PROXY:'http://127.0.0.1:9',https_proxy:'http://127.0.0.1:9'};
 for(const key of Object.keys(tsEnv))if(/^(PRTS_MCP_ROOT|PRTS_IMAGE_DIR|GAMEDATA_PATH|STORYJSON_PATH|GITHUB_TOKEN|GITHUB_MIRRORS)$/.test(key))delete tsEnv[key];
 await asyncRun(process.execPath,['tools/ts-interop-peer.mjs','sync-bench',legacyBase,mirrorPort],tsEnv);
 assert(existsSync(join(legacy,'.gamedata_pair.json')));assert(existsSync(join(legacy,'storyjson/zh_CN.zip')));
 const pointer=readJson(join(legacy,'.gamedata_pair.json'));
 const chars=join(legacy,'gamedata',pointer.excel_data_root,'zh_CN/gamedata/excel/character_table.json');
 const table=readJson(chars);table.char_002_amiya.name='卷内阿米娅';json(chars,table);
 cpSync(join(root,'.runtime/fixtures/ts-images-v1'),join(legacy,'images'),{recursive:true});
 const before=payloadHashes(legacy);
 const old=await http(`${prefix}-old`,legacy,{env:{IMAGES_ENABLED:'true',LOCAL_IMAGE:'true'}});
 assert.match(JSON.stringify(await old.call('get_operator_basic_info',{name:'卷内阿米娅'})),/卷内阿米娅 - 干员基本信息/);
 const artwork=await old.call('operator_artwork',{action:'get',operator_name:'卷内阿米娅',artwork_id:'char_002_amiya#1',variant:'preview'});assert(artwork.content.some(c=>c.type==='image'),JSON.stringify(artwork).slice(0,300));
 await stop(`${prefix}-old`);assert.deepEqual(payloadHashes(legacy),before);
 checks.push({case:'actual TS-written pair and image generations, user data priority and PNG, unchanged offline payload',oracle:'TS/v2.8.1',imageAssets:5});
 const split=await http(`${prefix}-split`,legacy,{separate:true});assert.match(JSON.stringify(await split.call('get_operator_basic_info',{name:'卷内阿米娅'})),/卷内阿米娅 - 干员基本信息/);await stop(`${prefix}-split`);
 checks.push({case:'legacy four separate mounts read extract_meta without root pair pointer'});
 console.log(`DOCKER_STAGE: ${id} real in-container sync and offline recovery`);
 const synced=volume(join(temp,'synced'));
 const active=await http(`${prefix}-sync`,synced,{networkName:network,env:{PRTS_DATA_BACKEND:'json',GITHUB_MIRRORS:`http://${mirror}:8080/`,HTTPS_PROXY:'http://127.0.0.1:9',https_proxy:'http://127.0.0.1:9'}});
 let ready=false;for(let i=0;i<240;i++){if(existsSync(join(synced,'.gamedata_pair.json'))&&existsSync(join(synced,'storyjson/zh_CN.zip'))){ready=true;break;}await delay(500);}
 assert(ready,docker(['logs',`${prefix}-sync`],{maxBuffer:1<<22}));
 assert.match(JSON.stringify(await active.call('get_operator_basic_info',{name:'阿米娅'})),/阿米娅/);await stop(`${prefix}-sync`);
 const syncedBefore=payloadHashes(synced),recovered=await http(`${prefix}-recovery`,synced,{env:{PRTS_DATA_BACKEND:'json'}});
 assert.match(JSON.stringify(await recovered.call('list_stages')),/关卡列表/);await stop(`${prefix}-recovery`);assert.deepEqual(payloadHashes(synced),syncedBefore);
 checks.push({case:'non-root real sync into whole /data then offline restart without destructive resync'});
 const separateVol=volume(join(temp,'separate-sync'));
 const separateActive=await http(`${prefix}-separate-sync`,separateVol,{separate:true,networkName:network,env:{PRTS_DATA_BACKEND:'json',GITHUB_MIRRORS:`http://${mirror}:8080/`,HTTPS_PROXY:'http://127.0.0.1:9',https_proxy:'http://127.0.0.1:9'}});
 ready=false;for(let i=0;i<240;i++){if(existsSync(join(separateVol,'gamedata/archives/extract_meta.json'))&&existsSync(join(separateVol,'gamedata-levels/archives/extract_meta.json'))&&existsSync(join(separateVol,'storyjson/zh_CN.zip'))){ready=true;break;}await delay(500);}
 assert(ready,docker(['logs',`${prefix}-separate-sync`],{maxBuffer:1<<22}));await stop(`${prefix}-separate-sync`);
 const separateRecovered=await http(`${prefix}-separate-recovery`,separateVol,{separate:true,env:{PRTS_DATA_BACKEND:'json'}});assert.match(JSON.stringify(await separateRecovered.call('list_stages')),/关卡列表/);await stop(`${prefix}-separate-recovery`);
 checks.push({case:'real sync and recreation with four legacy subdirectory mounts'});
 console.log(`DOCKER_STAGE: ${id} default SQLite sync and offline recovery`);
 const sqliteFixture=join(temp,'sqlite-mirror');mkdirSync(sqliteFixture);
 const sqliteDir=join(root,'.runtime/sqlite-fixtures/minimal-images-v1');
 const descriptor=readJson(join(sqliteDir,'zh_CN.sqlite.meta.json'));
 const sqliteTag=`data-${descriptor.sourceVersion}`;
 const sqliteBase=`https://github.com/${pin.repo}/releases/download/${sqliteTag}`;
 const sqliteManifest={contractVersion:'prts-mcp-data/v1',publicationRevision:descriptor.publicationRevision,
   source:{versionId:descriptor.sourceVersion},sqlite:descriptor,
   assets:{[descriptor.asset]:{size:descriptor.compressedSize,sha256:descriptor.compressedSha256}}};
 cpSync(join(sqliteDir,descriptor.asset),join(sqliteFixture,descriptor.asset));
 json(join(sqliteFixture,'manifest.json'),sqliteManifest);
 writeFileSync(join(sqliteFixture,'assets.txt'),`${sqliteBase}/manifest.json manifest.json\n${sqliteBase}/${descriptor.asset} ${descriptor.asset}\n`);
 json(join(sqliteFixture,'releases.json'),[{tag_name:sqliteTag,assets:['manifest.json',descriptor.asset].map(name=>({name,browser_download_url:`${sqliteBase}/${name}`}))}]);
 const sqliteMirror=`${mirror}-sqlite`;
 containers.add(sqliteMirror);docker(['run','-d','--name',sqliteMirror,'--network',network,...ownedUser,'--read-only',
   '-v',`${sqliteFixture}:/fixture:ro`,'-v',`${join(root,'tools/docker/mirror.mjs')}:/mirror.mjs:ro`,mirrorImage,'node','/mirror.mjs','/fixture']);
 const sqliteVol=volume(join(temp,'sqlite-sync'));
 const debugEnv={PRTS_METRICS_ENABLED:'true',PRTS_DEBUG_TOKEN:'sqlite-probe-token'};
 const sqliteApp=await http(`${prefix}-sqlite`,sqliteVol,{env:{...debugEnv,GITHUB_MIRRORS:`http://${sqliteMirror}:8080/`}});
 ready=false;for(let i=0;i<240;i++){if(existsSync(join(sqliteVol,'database/active'))){ready=true;break;}await delay(500);}
 assert(ready,docker(['logs',`${prefix}-sqlite`],{maxBuffer:1<<22}));
 const backend=await (await fetch(sqliteApp.origin+'/debug/metrics',{headers:{Authorization:'Bearer sqlite-probe-token'}})).json();
 assert.equal(backend.data_backend.preference,'sqlite');assert.equal(backend.data_backend.effective,'sqlite');assert.equal(backend.data_backend.fallback,false);
 assert.match(JSON.stringify(await sqliteApp.call('get_operator_basic_info',{name:'阿米娅'})),/阿米娅/);
 assert(!existsSync(join(sqliteVol,'.gamedata_pair.json')),'default backend must not run JSON synchronization');
 await stop(`${prefix}-sqlite`);
 const sqliteBefore=payloadHashes(sqliteVol);
 const sqliteRecovery=await http(`${prefix}-sqlite-offline`,sqliteVol,{env:debugEnv});
 assert.match(JSON.stringify(await sqliteRecovery.call('get_operator_basic_info',{name:'阿米娅'})),/阿米娅/);
 await stop(`${prefix}-sqlite-offline`);assert.deepEqual(payloadHashes(sqliteVol),sqliteBefore);
 checks.push({case:'unconfigured backend synchronizes SQLite, reports effective SQLite, and restarts offline with the validated DB'});
 const rollback=spawn('bun',[join(root,'.reference/ts-v2.8.1/ts/dist/server-stdio.js')],{cwd:temp,env:{...tsEnv,GAMEDATA_PATH:join(synced,'gamedata'),STORYJSON_PATH:join(synced,'storyjson/zh_CN.zip')},stdio:['pipe','pipe','pipe']});
 checks.push({case:'fixed old TS reads container-written data (scoped read-back, not M4 release rollback)',...await stdio(rollback,'2.8.1')});
 json(join(out,'docker-evidence.json'),{platform:id,native:true,arch,version,commit:receipt.commit,imageId:receipt.imageId,archiveSha256:sha(archive),checks,publicPublication:false,
 scope:'native Docker packaging and isolated fixture lifecycle; real-client candidate E2E/complete release upgrades and rollback remain M4'});
 console.log(`DOCKER_VERIFY_PASS: ${checks.length} checks (${id})`);
}finally {
 for(const name of containers){try{docker(['rm','-f',name]);}catch{}}
 if(networkCreated)try{docker(['network','rm',network]);}catch{}
 rmSync(temp,{recursive:true,force:true});
}
