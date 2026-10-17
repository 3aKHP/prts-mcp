import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, release as osRelease } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { root,version,targets,readJson,json,sha,verifyInventory,verifyNotices } from './common.mjs';
import { startRegistry,capture,npmSpawn } from './registry.mjs';
import { stdio } from './mcp.mjs';

const id = process.argv[2], target = targets[id];
assert(target && target.os === process.platform && target.arch === process.arch,'npm runtime verification requires its native host');
const out = join(root,'artifacts/npm',id);
const started = performance.now(), timings = [];
async function timed(name, run) {
  const start = performance.now();
  try { return await run(); }
  finally {
    const entry = {name,ms:Math.round(performance.now()-start)};
    timings.push(entry);
    console.log(`NPM_TIMING: ${JSON.stringify(entry)}`);
  }
}
const receipt = readJson(join(out,'packages.json'));
for (const p of receipt.packages) assert.equal(sha(join(out,'tarballs',p.filename)),p.sha256);
const temp = mkdtempSync(join(tmpdir(),'prts-npm 空格-'));
const checks = [];
const registry = await startRegistry(out);
const env = {...process.env};
for (const key of Object.keys(env)) {
  if (/^(PRTS_|GAMEDATA_PATH|STORYJSON_PATH|GITHUB_TOKEN|GITHUB_MIRRORS|NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG_)/i.test(key)) delete env[key];
}
const config = join(temp,'empty.npmrc'); writeFileSync(config,'');
const globalConfig = join(temp,'global.npmrc'); writeFileSync(globalConfig,'');
Object.assign(env,{NPM_CONFIG_USERCONFIG:config,NPM_CONFIG_GLOBALCONFIG:globalConfig,
  NPM_CONFIG_REGISTRY:registry.url,NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',
  NPM_CONFIG_TIMING:'true',NPM_CONFIG_LOGS_DIR:join(out,'npm-logs'),
  IMAGES_ENABLED:'false',LOCAL_IMAGE:'false',PRTS_OUTPUT_CHANNEL:'content',
  PRTS_AUTO_SYNC_INTERVAL_SECONDS:'0',GITHUB_MIRRORS:'http://127.0.0.1:9',
  XDG_DATA_HOME:join(temp,'empty-user'),LOCALAPPDATA:join(temp,'empty-user'),USERPROFILE:join(temp,'empty-profile'),
});
const install = async args => {
  const result = await timed('global-install',()=>capture('npm',args,{env,cwd:temp}));
  assert.equal(result.code,0,result.stderr);
  return result.stdout.trim();
};
const children = new Set();
const track = child => { children.add(child); child.once('close',()=>children.delete(child)); return child; };
const launch = (file,overrides={}) => track(spawn(process.execPath,[file],{cwd:temp,env:{...env,...overrides},stdio:['pipe','pipe','pipe']}));
const prefix = join(temp,'global');
const globalRoot = process.platform === 'win32' ? join(prefix,'node_modules') : join(prefix,'lib/node_modules');
const main = join(globalRoot,'prts-mcp/bin/prts-mcp.cjs');
const compat = join(globalRoot,'prts-mcp-ts/bin/prts-mcp-ts-stdio.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

async function signalCheck(file,requested='SIGTERM') {
  const portServer = createServer(); portServer.listen(0,'127.0.0.1'); await once(portServer,'listening');
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const child = launch(file,{PRTS_TRANSPORT:'http',HOST:'127.0.0.1',PORT:String(port)});
  const close = once(child,'close'); let stderr=''; child.stderr.on('data',data=>{stderr+=data;});
  const address = `http://127.0.0.1:${port}/health`;
  try {
    let ready=false;
    for(let i=0;i<150;i++){
      try{if((await fetch(address,{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}
      if(child.exitCode!==null)throw new Error(stderr);
      await delay(100);
    }
    assert(ready,stderr);
    child.kill(requested);
    const [code,signal]=await Promise.race([close,delay(10000).then(()=>{throw new Error('npm launcher exit timeout');})]);
    if(process.platform==='win32') assert(code===1 || signal==='SIGTERM');
    else assert.equal(signal,requested);
    let stopped=false;
    for(let i=0;i<50;i++){
      try{await fetch(address,{signal:AbortSignal.timeout(200)});}catch{stopped=true;break;}
      await delay(100);
    }
    assert(stopped,'native HTTP process survived its npm launcher');
    checks.push({case:process.platform==='win32'?'Windows forced launcher exit stops native child':`${requested} forwarded with no surviving HTTP child`,code,signal});
  } finally { if(child.exitCode===null && child.signalCode===null)child.kill(); }
}

try {
  console.log(`NPM_STAGE: ${id} global dual-entry install`);
  await install(['install','--global','--prefix',prefix,'--cache',join(temp,'global-cache'),'--ignore-scripts',
    `prts-mcp@${version}`,`prts-mcp-ts@${version}`]);
  checks.push({case:'global install both exact-version entries with clean cache',registryOnly:true});
  const req = createRequire(main);
  const nativeRoot = join(req.resolve(`@3akhp/prts-mcp-${id}/package.json`),'..');
  const nativePkg = readJson(join(nativeRoot,'package.json'));
  assert.equal(nativePkg.version,version);
  assert.deepEqual(nativePkg.os,[process.platform]);assert.deepEqual(nativePkg.cpu,[process.arch]);
  checks.push({case:'matching native platform selected',platform:id});
  const nativeHashes=await timed('native-inventory',()=>verifyInventory(nativeRoot)),notices=verifyNotices(nativeRoot);
  const installedData=join(req.resolve('@3akhp/prts-mcp-data/package.json'),'..','data');
  const dataHashes=await timed('data-inventory',()=>verifyInventory(installedData));
  checks.push({case:'actual installed tarball payload and license integrity',nativeHashes:nativeHashes.length,noticeReferences:notices,dataHashes:dataHashes.length});
  await timed('installed-entry-profiles',async()=>{
    const profile = spawn(process.execPath,['tools/native/probe.mjs',id,'--npm-root',globalRoot],{cwd:root,env,stdio:'inherit'});
    const [code] = await once(profile,'close'); assert.equal(code,0);
  });
  checks.push({case:'installed new/compat entry profiles, frozen outputs and protocols',evidence:`artifacts/native/${id}/npm-runtime-evidence.json`});
  console.log(`NPM_STAGE: ${id} offline fallback and actual global shim`);
  checks.push({case:'fresh empty-user offline fallback',...await stdio(launch(main,{PRTS_TRANSPORT:'stdio'}),version)});
  const directCommand = process.platform==='win32' ? join(prefix,'prts-mcp-ts-stdio.cmd') : join(prefix,'bin/prts-mcp-ts-stdio');
  let commandChild;
  if(process.platform==='win32'){
    const literal="'"+directCommand.replaceAll("'","''")+"'";
    const command=`[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & ${literal}; exit $LASTEXITCODE`;
    commandChild=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{cwd:temp,env,stdio:['pipe','pipe','pipe']});
  }else commandChild=spawn(directCommand,[],{cwd:temp,env,stdio:['pipe','pipe','pipe']});
  checks.push({case:'actual global executable shim',...await stdio(commandChild,version)});
  for(const name of ['prts-mcp','prts-mcp-ts']){
    console.log(`NPM_STAGE: ${id} clean-cache npx ${name}`);
    const bin=name==='prts-mcp'?'prts-mcp':'prts-mcp-ts-stdio';
    const result=await timed(`npx-${name}`,async()=>{
      const child=npmSpawn('npx',['--yes','--cache',join(temp,`npx-${name}`),'--registry',registry.url,'--package',`${name}@${version}`,bin],
        {cwd:temp,env:{...env,PRTS_TRANSPORT:'stdio'},stdio:['pipe','pipe','pipe']});
      return stdio(child,version);
    });
    checks.push({case:`npx ${name} with clean cache`,...result});
  }
  const project=join(temp,'locked-project');mkdirSync(project);
  console.log(`NPM_STAGE: ${id} locked project install and clean npm ci`);
  json(join(project,'package.json'),{name:'npm-install-probe',private:true,dependencies:{'prts-mcp':version,'prts-mcp-ts':version}});
  const local = await timed('project-install',()=>capture('npm',['install','--ignore-scripts','--cache',join(temp,'lock-cache')],{cwd:project,env}));assert.equal(local.code,0,local.stderr);
  const lock=readFileSync(join(project,'package-lock.json'),'utf8');
  await timed('remove-project-install',()=>rmSync(join(project,'node_modules'),{recursive:true,force:true}));
  const ci=await timed('npm-ci',()=>capture('npm',['ci','--ignore-scripts','--cache',join(temp,'ci-cache')],{cwd:project,env}));assert.equal(ci.code,0,ci.stderr);
  assert.equal(readFileSync(join(project,'package-lock.json'),'utf8'),lock);
  const localMain=join(project,'node_modules/prts-mcp/bin/prts-mcp.cjs');
  const localCompat=join(project,'node_modules/prts-mcp-ts/bin/prts-mcp-ts-stdio.cjs');
  const requireMain=createRequire(localMain), requireCompat=createRequire(localCompat);
  assert.equal(requireMain.resolve('@3akhp/prts-mcp-runtime'),requireCompat.resolve('@3akhp/prts-mcp-runtime'));
  checks.push({case:'npm ci with fresh cache and unchanged lockfile; shared runtime/data deduplicated',...await stdio(launch(localCompat),version)});
  console.log(`NPM_STAGE: ${id} lifecycle and error diagnostics`);
  for(const signal of process.platform==='win32'?['SIGTERM']:['SIGTERM','SIGINT','SIGHUP']) await timed(`lifecycle-${signal}`,()=>signalCheck(main,signal));
  const occupied=createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
  const badPort=launch(main,{PORT:String(occupied.address().port),HOST:'127.0.0.1',PRTS_TRANSPORT:'http'});
  let badOut='';badPort.stdout.on('data',d=>{badOut+=d;});badPort.stderr.resume();
  const [badCode]=await Promise.race([once(badPort,'close'),delay(10000).then(()=>{throw new Error('bind failure exit timeout');})]);
  await new Promise(resolve=>occupied.close(resolve));assert.equal(badCode,1);assert.equal(badOut,'');
  checks.push({case:'native startup error exit code preserved',exit:badCode});
  const nativeMeta=join(nativeRoot,'package.json'), original=readFileSync(nativeMeta,'utf8');
  json(nativeMeta,{...nativePkg,version:'0.0.0'});
  const mismatch=launch(main);let mismatchErr='',mismatchOut='';mismatch.stderr.on('data',d=>{mismatchErr+=d;});mismatch.stdout.on('data',d=>{mismatchOut+=d;});
  const [mismatchCode]=await once(mismatch,'close');writeFileSync(nativeMeta,original);
  assert.equal(mismatchCode,1);assert.equal(mismatchOut,'');assert.match(mismatchErr,/版本不一致/);
  checks.push({case:'mismatched platform version rejected on stderr',exit:1});
  const runtime=req.resolve('@3akhp/prts-mcp-runtime');
  for(const [label,setup,expected] of [['unsupported OS',"Object.defineProperty(process,'platform',{value:'freebsd'});",/暂不支持/],
    ...(process.platform==='linux'?[['musl unsupported',"process.report.getReport=()=>({header:{}});",/glibc 2.28/]]:[])]){
    const child=spawn(process.execPath,['-e',`${setup}require(${JSON.stringify(runtime)}).run('prts-mcp')`],{env,stdio:['ignore','pipe','pipe']});
    let err='',output='';child.stderr.on('data',d=>{err+=d;});child.stdout.on('data',d=>{output+=d;});
    const [exit]=await once(child,'close');assert.equal(exit,1);assert.equal(output,'');assert.match(err,expected);
    checks.push({case:label,exit:1,classification:'isolated selector simulation; not a native OS support claim'});
  }
  const omitted=join(temp,'no-optional');mkdirSync(omitted);json(join(omitted,'package.json'),{private:true});
  const noOptional=await timed('omit-optional-install',()=>capture('npm',['install','--omit=optional','--ignore-scripts','--cache',join(temp,'omit-cache'),`prts-mcp@${version}`],{env,cwd:omitted}));
  assert.equal(noOptional.code,0,noOptional.stderr);
  const absent=launch(join(omitted,'node_modules/prts-mcp/bin/prts-mcp.cjs'));let absentErr='',absentOut='';absent.stderr.on('data',d=>{absentErr+=d;});absent.stdout.on('data',d=>{absentOut+=d;});
  const [absentCode]=await once(absent,'close');assert.equal(absentCode,1);assert.equal(absentOut,'');assert.match(absentErr,/缺少平台包.*optional dependencies/);
  checks.push({case:'real --omit=optional install gives actionable stderr diagnosis',exit:1});
  assert(registry.hits.every(hit=>hit.method==='GET'||hit.method==='HEAD'));
  assert(!registry.hits.some(hit=>hit.path.startsWith('/foreign/')),'npm attempted to download an unsupported platform');
  json(join(out,'npm-evidence.json'),{platform:id,os:osRelease(),arch:process.arch,version,native:true,
    packages:receipt.packages,checks,registry:'read-only loopback; actual npm resolution',publicPublication:false});
  console.log(`NPM_INSTALL_PASS: ${checks.length} checks (${id})`);
} catch(error) {
  console.error(`NPM_VERIFY_FAILURE: ${error.stack ?? error}`);
  throw error;
} finally {
  await Promise.allSettled([...children].map(child=>{const close=once(child,'close');child.kill();return close;}));
  await registry.close();
  try { await timed('cleanup',()=>rmSync(temp,{recursive:true,force:true})); }
  finally {
    json(join(out,'npm-timings.json'),{platform:id,os:osRelease(),node:process.version,
      tempRoot:tmpdir(),totalMs:Math.round(performance.now()-started),timings});
  }
}
