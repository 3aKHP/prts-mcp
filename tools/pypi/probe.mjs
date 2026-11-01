import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { stdio } from '../npm/mcp.mjs';

const root = resolve(import.meta.dirname, '../..'), id = process.argv[2];
const target = JSON.parse(readFileSync(join(root, 'packaging/native/targets.json')))[id];
assert(target && process.platform === target.os && process.arch === target.arch, 'Probe requires its native host');
const out = resolve(process.argv[3] ?? join(root, 'artifacts/pypi', id));
const receipt = JSON.parse(readFileSync(join(out, 'package.json')));
const wheel = join(out, 'wheels', receipt.filename);
const temp = mkdtempSync(join(tmpdir(), 'prts-pypi 空格-'));
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(PRTS_|GAMEDATA_PATH|STORYJSON_PATH|GITHUB_TOKEN|GITHUB_MIRRORS|PYTHONPATH|PIP_|UV_|PIPX_)/i.test(key)) delete env[key];
const fixture = join(root, 'tests/fixtures/native-smoke');
Object.assign(env, {IMAGES_ENABLED: 'false', LOCAL_IMAGE: 'false',
  GAMEDATA_PATH: fixture, STORYJSON_PATH: join(fixture, 'storyjson/zh_CN.zip'),
  XDG_DATA_HOME: join(temp, 'user'), LOCALAPPDATA: join(temp, 'user'),
  GITHUB_MIRRORS: 'http://127.0.0.1:9', PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1',
  UV_CACHE_DIR: join(temp, 'uv-cache'), UV_PYTHON_DOWNLOADS: 'never',
  PIPX_HOME: join(temp, 'pipx'), PIPX_BIN_DIR: join(temp, 'commands'),
  PIPX_DEFAULT_PYTHON: process.env.VIRTUAL_ENV ? join(process.env.VIRTUAL_ENV, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') : 'python',
});
const run = (command, args) => execFileSync(command, args, {cwd: temp, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe']});
const pythonIn = dir => join(dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const commandIn = dir => join(dir, process.platform === 'win32' ? 'Scripts/prts-mcp.exe' : 'bin/prts-mcp');
const launch = (command, args = [], overrides = {}) => spawn(command, args, {cwd: temp, env: {...env, ...overrides}, stdio: ['pipe','pipe','pipe']});
const checks = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function httpExit(command) {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server,'listening');
  const port = server.address().port; await new Promise(r => server.close(r));
  const child = launch(command, [], {PRTS_TRANSPORT:' HTTP ', HOST:'127.0.0.1',PORT:String(port)});
  const closed = once(child,'close'); let stderr=''; child.stderr.on('data',s=>stderr+=s);
  try {
    let ready=false;
    for(let i=0;i<150;i++) {
      try { if((await fetch(`http://127.0.0.1:${port}/health`)).ok) {ready=true;break;} } catch {}
      if(child.exitCode!==null) throw new Error(stderr);
      await delay(100);
    }
    assert(ready,stderr);child.kill('SIGTERM');
    const result=await Promise.race([closed,delay(10000).then(()=>{throw new Error('HTTP exit timeout');})]);
    if(process.platform!=='win32') assert.equal(result[1],'SIGTERM');
    let stopped=false;
    for(let i=0;i<50;i++) {
      try { await fetch(`http://127.0.0.1:${port}/health`); } catch {stopped=true;break;}
      await delay(100);
    }
    assert(stopped,'Native HTTP process survived bridge exit');
  } finally { if(child.exitCode===null && child.signalCode===null) child.kill(); }
}
try {
  execFileSync('python', [join(root,'tools/pypi/inspect.py'),wheel,join(out,'package.json')], {env,stdio:'inherit'});
  run('python',['-m','venv',join(temp,'venv')]);
  const python=pythonIn(join(temp,'venv')), command=commandIn(join(temp,'venv'));
  run(python,['-m','pip','install','--no-deps',wheel]);
  for(const [name,cmd,args,overrides] of [
    ['pip-command',command,[],{}], ['module',python,['-m','prts_mcp.server'],{}],
    ['empty-transport',command,[],{PRTS_TRANSPORT:''}], ['invalid-transport',command,[],{PRTS_TRANSPORT:'unknown'}],
  ]) { await stdio(launch(cmd,args,overrides),receipt.productVersion);checks.push(name); }
  await stdio(launch('uv',['tool','run','--no-index','--find-links',join(out,'wheels'),'--python',python,'--from',`prts-mcp==${receipt.version}`,'prts-mcp']),receipt.productVersion); checks.push('uvx');
  run('python',['-m','pipx','install','--python',python,'--pip-args=--no-deps',wheel]);
  await stdio(launch(commandIn(join(temp,'pipx/venvs/prts-mcp'))),receipt.productVersion);checks.push('pipx');
  await httpExit(command);checks.push('http-parent-exit');
  const legacy = execFileSync('python',[join(root,'tools/pypi/legacy.py')],{cwd:root,encoding:'utf8'}).trim();
  run(python,['-m','pip','install','--no-deps','--force-reinstall',legacy]);
  run(python,['-m','pip','install','--no-deps','--upgrade',wheel]);
  await stdio(launch(command),receipt.productVersion);checks.push('legacy-upgrade');
  const lib = run(python,['-c','import prts_mcp; print(prts_mcp.__path__[0])']).trim();
  const native = join(lib,'_native',process.platform==='win32'?'prts-mcp-ghcr.exe':'prts-mcp-ghcr');
  assert(existsSync(native));
  run(python,['-c','from pathlib import Path; import sys; Path(sys.argv[1]).rename(sys.argv[1]+".missing")',native]);
  const broken = spawn(command,[],{cwd:temp,env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';broken.stdout.on('data',s=>stdout+=s);broken.stderr.on('data',s=>stderr+=s);
  const [code] = await once(broken,'close');assert.equal(code,1);assert.equal(stdout,'');assert.match(stderr,/missing/);checks.push('missing-native');
  run(python,['-m','pip','uninstall','-y','prts-mcp']);assert(!existsSync(command));checks.push('uninstall');
  writeFileSync(join(out,'pypi-evidence.json'),JSON.stringify({...receipt,native:true,arch:process.arch,checks},null,2)+'\n');
  console.log(`PYPI_PROBE_PASS: ${id} ${checks.join(', ')}`);
} finally { rmSync(temp,{recursive:true,force:true}); }
