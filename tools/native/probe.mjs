// Black-box checks of the extracted release archive, outside the checkout,
// with an empty PATH. Node is the MCP client only; it is not the server runtime.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, release as osRelease } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { root, out, bins, suffix, version, config, run, sha, json, psLiteral } from './common.mjs';

const temp = mkdtempSync(join(tmpdir(), 'prts-native 空格-'));
const installed = join(temp, 'installed');
mkdirSync(installed);
const artifact = JSON.parse(readFileSync(join(out, 'artifact.json')));
const baseline = process.argv.includes('--baseline');
if (baseline && config.os !== 'linux') throw new Error('--baseline requires a Linux native runtime image');
if (baseline) run('docker', ['pull', config.runtimeImage], { stdio: 'inherit' });
assert.equal(sha(artifact.archive), artifact.sha256);
if (config.os === 'win32') {
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${psLiteral(artifact.archive)} -DestinationPath ${psLiteral(installed)}`]);
} else run('tar', ['-xf', artifact.archive, '-C', installed]);
for (const line of readFileSync(join(installed, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
  const [, hash, path] = line.match(/^([a-f\d]{64})  (.+)$/);
  assert.equal(sha(join(installed, path)), hash, `Extracted hash: ${path}`);
}
const fixture = join(temp, '测试数据');
const frozen = JSON.parse(readFileSync(join(root, 'contracts/native-smoke-manifest.json')));
for (const file of frozen.files) {
  assert.equal(sha(join(root, 'tests/fixtures/native-smoke', file.path)), file.sha256, `Frozen native fixture: ${file.path}`);
}
cpSync(join(root, 'tests/fixtures/native-smoke'), fixture, { recursive: true });
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(PATH|PRTS_|GAMEDATA_PATH|STORYJSON_PATH|IMAGES_ENABLED|LOCAL_IMAGE|ORIGINAL_IMAGE|HOST|PORT|GITHUB_TOKEN|GITHUB_MIRRORS|SESSION_IDLE_TIMEOUT_MS)$/i.test(key) || key.startsWith('PRTS_')) delete env[key];
}
Object.assign(env, { PATH: '', GAMEDATA_PATH: fixture, STORYJSON_PATH: join(fixture, 'storyjson/zh_CN.zip'),
  IMAGES_ENABLED: 'false', HOST: '127.0.0.1', PRTS_OUTPUT_CHANNEL: 'content',
  PRTS_AUTO_SYNC_INTERVAL_SECONDS: '0', GITHUB_MIRRORS: 'http://127.0.0.1:9' });
const checks = [];
const children = new Set();
const delay = ms => new Promise(r => setTimeout(r, ms));
function launch(bin, overrides = {}) {
  const executable = join(installed, 'bin', bin + suffix);
  const childEnv = { ...env, ...overrides };
  if (baseline) childEnv.HOST = '0.0.0.0';
  const args = baseline ? ['run', '--rm', '--init', '-i', '--user', `${process.getuid()}:${process.getgid()}`,
    ...(childEnv.PORT ? ['-p', `127.0.0.1:${childEnv.PORT}:${childEnv.PORT}`] : []),
    '-v', `${temp}:${temp}`, '-w', temp,
    ...Object.entries(childEnv).filter(([k,v]) => v !== undefined &&
      /^(PATH|PRTS_.*|GAMEDATA_PATH|STORYJSON_PATH|IMAGES_ENABLED|HOST|PORT|GITHUB_MIRRORS)$/.test(k))
      .flatMap(([k,v]) => ['-e', `${k}=${v}`]), '--entrypoint', executable, config.runtimeImage] : [];
  const child = spawn(baseline ? 'docker' : executable, args, { cwd: temp,
    env: baseline ? process.env : childEnv, stdio: ['pipe','pipe','pipe'] });
  children.add(child);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  const state = { child, stdout: '', stderr: '', lines: [] };
  child.stdout.on('data', data => { state.stdout += data; });
  child.stderr.on('data', data => { state.stderr += data; });
  state.closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  return state;
}
async function bounded(promise, state, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out; ${state?.stderr ?? ''}`)), 20000);
    })]);
  } finally { clearTimeout(timer); }
}
const init = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'native-platform-probe', version: '1' } };
const golden = name => JSON.parse(readFileSync(join(root, `contracts/cases/golden/${name}.json`))).expected.body.result;
async function stdio(bin, overrides, images = false) {
  const state = launch(bin, { ...overrides, ...(images ? { IMAGES_ENABLED: 'true' } : {}) });
  let serial = 0, buffer = '';
  const pending = new Map();
  state.child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, '2.0');
        pending.get(message.id)?.resolve(message);
      } catch (error) { for (const p of pending.values()) p.reject(error); }
    }
  });
  const call = async (method, params) => {
    const id = ++serial;
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    try { return await bounded(promise, state, method); } finally { pending.delete(id); }
  };
  try {
    const hello = await call('initialize', init);
    assert.equal(hello.result.serverInfo.version, version);
    state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await call('tools/list', {});
    assert.equal(tools.result.tools.length, images ? 24 : 23);
    if (!images) {
      const basic = await call('tools/call', { name: 'get_operator_basic_info', arguments: { name: '阿米娅' } });
      assert.deepEqual(basic.result, golden('operator.basic.default'));
      const stories = await call('tools/call', { name: 'search_stories', arguments: { pattern: '(?<=博)士' } });
      assert.ok(!stories.error && !stories.result.isError);
      assert.match(JSON.stringify(stories.result), /博士|stories\//);
    }
    state.child.stdin.end();
    assert.deepEqual(await bounded(state.closed, state, 'stdio EOF'), { code: 0, signal: null });
    assert.equal(buffer.trim(), '');
    for (const line of state.stdout.trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    checks.push({ bin, transport: 'stdio', tools: images ? 24 : 23, exit: 'EOF -> 0', path: 'empty' });
  } finally { if (state.child.exitCode === null) state.child.kill(); }
}
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return port;
}
function decode(text) {
  if (text.trim().startsWith('{')) return JSON.parse(text);
  const frames = text.split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5)));
  assert.ok(frames.length, `No MCP response: ${text}`);
  return frames.at(-1);
}
async function http(bin, overrides) {
  const port = await freePort();
  const state = launch(bin, { ...overrides, PORT: String(port) });
  const base = `http://127.0.0.1:${port}`;
  try {
    await bounded((async () => {
      const deadline = Date.now() + 19000;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`HTTP ready timeout: ${state.stderr}`);
        if (state.child.exitCode !== null) throw new Error(`HTTP process exited: ${state.stderr}`);
        try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
        await delay(100);
      }
    })(), state, 'HTTP ready');
    const send = async (method, params, id, headers = {}) => {
      const response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }) });
      if (id === undefined) {
        assert.equal(response.status, 202);
        return { body: await response.text(), session: null };
      }
      assert.equal(response.status, 200, `${method}: ${await response.clone().text()}`);
      return { body: decode(await response.text()), session: response.headers.get('mcp-session-id') };
    };
    const hello = await send('initialize', init, 1);
    assert.equal(hello.body.result.serverInfo.version, version);
    assert.ok(hello.session);
    await send('notifications/initialized', {}, undefined, { 'Mcp-Session-Id': hello.session });
    const listed = await send('tools/list', {}, 2, { 'Mcp-Session-Id': hello.session });
    assert.equal(listed.body.result.tools.length, 23);
    const basic = await send('tools/call', { name: 'get_operator_basic_info', arguments: { name: '阿米娅' } }, 3,
      { 'Mcp-Session-Id': hello.session });
    assert.deepEqual(basic.body.result, golden('operator.basic.default'));
    const modern = '2026-07-28';
    const modernParams = { _meta: { 'io.modelcontextprotocol/protocolVersion': modern,
      'io.modelcontextprotocol/clientInfo': init.clientInfo, 'io.modelcontextprotocol/clientCapabilities': {} } };
    const direct = await send('tools/list', modernParams, 4, { 'MCP-Protocol-Version': modern, 'Mcp-Method': 'tools/list' });
    assert.equal(direct.body.result.tools.length, 23);
    state.child.kill('SIGTERM');
    const exit = await bounded(state.closed, state, 'HTTP shutdown');
    assert.ok(exit.code === 0 || exit.signal === 'SIGTERM' || baseline && exit.code === 143 || config.os === 'win32' && exit.code === 1,
      `Unexpected shutdown: ${JSON.stringify(exit)}`);
    checks.push({ bin, transport: 'http', legacy: true, modern: true, path: 'empty', shutdown: exit });
  } finally { if (state.child.exitCode === null) state.child.kill(); }
}
try {
  await stdio('prts-mcp', { PRTS_TRANSPORT: ' StDiO ' });
  await stdio('prts-mcp', { PRTS_TRANSPORT: 'stdio' }, true);
  await stdio('prts-mcp-ts-stdio', { PRTS_TRANSPORT: 'http' });
  await stdio('prts-mcp-ghcr', {});
  if (config.os === 'win32') {
    const local = join(temp, 'Local App Data');
    cpSync(fixture, join(local, 'prts-mcp/gamedata'), { recursive: true });
    await stdio('prts-mcp', { PRTS_TRANSPORT: 'stdio', GAMEDATA_PATH: undefined, LOCALAPPDATA: local });
    const profile = join(temp, 'User Profile');
    cpSync(fixture, join(profile, 'AppData/Local/prts-mcp/gamedata'), { recursive: true });
    await stdio('prts-mcp', { PRTS_TRANSPORT: 'stdio', GAMEDATA_PATH: undefined,
      LOCALAPPDATA: undefined, USERPROFILE: profile });
  }
  await http('prts-mcp', {});
  await http('prts-mcp-ts', { PRTS_TRANSPORT: 'stdio' });
  await http('prts-mcp-ts-bun', { PRTS_TRANSPORT: 'stdio' });
  await http('prts-mcp-ghcr', { PRTS_TRANSPORT: ' HTTP ' });
  json(join(out, baseline ? 'runtime-baseline-evidence.json' : 'runtime-evidence.json'), { platform: config.target, native: true, os: osRelease(),
    runtimeImage: baseline ? config.runtimeImage : null,
    arch: process.arch, archiveSha256: artifact.sha256, extractedOutsideCheckout: true,
    pathEmpty: true, checks, scope: 'native units/regex plus detached archive MCP/profile checks; npm, Docker distribution and M4 E2E are later phases' });
  console.log(`Detached native runtime passed: ${checks.length} profiles/checks (${config.target})`);
} finally {
  await Promise.allSettled([...children].map(child => {
    const closed = once(child, 'close'); child.kill(); return closed;
  }));
  rmSync(temp, { recursive: true, force: true });
}
