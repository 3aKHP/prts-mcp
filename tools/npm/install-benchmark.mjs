// Standalone data-install diagnostic. Run from an isolated directory on native storage.
import { createServer } from 'node:http';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import assert from 'node:assert/strict';
const root = resolve(process.argv[2] || '.');
const file = join(root, 'data.tgz');
const output = join(root, `result-${Date.now()}`); mkdirSync(output);
const temp = mkdtempSync(join(process.env.PRTS_BENCH_TEMP || output, 'prts-npm 空格-'));
const npmCli = process.argv[3] || (process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : null);
const npmCommand = npmCli ? process.execPath : 'npm';
const npmArgs = npmCli ? [npmCli] : [];
const { name, version } = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }));
const bytes = readFileSync(file);
const report = { node: process.version, platform: process.platform, os: os.release(), cpu: os.cpus()[0]?.model,
  cores: os.cpus().length, npmCli, temp, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, rows: [], requests: [] };
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
let url;
const server = createServer((req, res) => {
  const start = performance.now();
  const record = { path: decodeURIComponent(new URL(req.url, 'http://localhost').pathname), method: req.method };
  report.requests.push(record);
  res.once('finish', () => { record.ms = Math.round(performance.now() - start); });
  if (record.path === '/data.tgz') { res.writeHead(200); createReadStream(file).pipe(res); }
  else if (record.path === '/' + name) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name,
    'dist-tags': { latest: version }, versions: { [version]: { name, version, dist: { tarball: url + '/data.tgz', integrity } } } }));
  else res.writeHead(404).end('{}');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
url = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(NPM_CONFIG_|NODE_AUTH_TOKEN|NPM_TOKEN)/i.test(key)) delete env[key];
writeFileSync(join(output, 'user.npmrc'), ''); writeFileSync(join(output, 'global.npmrc'), '');
Object.assign(env, { NPM_CONFIG_USERCONFIG: join(output, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(output, 'global.npmrc'),
  NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_REGISTRY: url, NPM_CONFIG_UPDATE_NOTIFIER: 'false' });
function run(command, args, cwd = temp) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(Error('command timed out')); }, 600000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(Error(`${code}: ${stderr}`)); });
  });
}
function flush() { writeFileSync(join(output, 'evidence.json'), JSON.stringify(report, null, 2)); }
async function measure(label, fn) {
  const row = { label }, start = performance.now();
  try { row.result = await fn(); } catch (e) { row.error = String(e.stack); throw e; }
  finally { row.ms = Math.round(performance.now() - start); report.rows.push(row); flush(); console.log(JSON.stringify(row)); }
}
async function npm(label, args, cwd) {
  const logs = join(output, label); mkdirSync(logs);
  return measure(label, async () => {
    const result = await run(npmCommand, [...npmArgs, ...args, '--timing', '--logs-dir', logs], cwd);
    writeFileSync(join(logs, 'stdout.txt'), result.stdout); writeFileSync(join(logs, 'stderr.txt'), result.stderr);
    return { stdout: result.stdout.trim() };
  });
}
try {
  report.npm = (await run(npmCommand, [...npmArgs, '--version'])).stdout.trim(); flush();
  const project = join(temp, 'project'); mkdirSync(project); writeFileSync(join(project, 'package.json'), '{"private":true}');
  const cache = join(temp, 'cache');
  await npm('cold-install', ['install', `${name}@${version}`, '--ignore-scripts', '--cache', cache], project);
  await npm('warm-ci', ['ci', '--ignore-scripts', '--cache', cache], project);
  const extracted = join(temp, 'tar'); mkdirSync(extracted);
  await measure('tar-extract', async () => { await run('tar', ['-xf', file, '-C', extracted]); });
  await measure('copy-tree', () => cpSync(join(extracted, 'package'), join(temp, 'copy'), { recursive: true }));
  await measure('hash-tree', () => {
    let count = 0, total = 0;
    function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else { createHash('sha256').update(readFileSync(path)).digest('hex'); count++; total += statSync(path).size; }
    } }
    walk(extracted); return { count, bytes: total };
  });
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await measure('cleanup', () => rmSync(temp, { recursive: true, force: true })); flush();
}
