// Read-only loopback registry for exact tarballs; nothing is published.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readJson, targets } from './common.mjs';

export async function startRegistry(out) {
  const receipt = readJson(join(out, 'packages.json'));
  const packages = new Map(receipt.packages.map(p => [p.name, p]));
  const tarballs = new Map(receipt.packages.map(p => [p.filename, p]));
  const hits = [];
  let url;
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    hits.push({ method: req.method, path: pathname });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (pathname.startsWith('/tarballs/')) {
      const file = pathname.slice('/tarballs/'.length);
      if (!tarballs.has(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      createReadStream(join(out, 'tarballs', file)).pipe(res);
      return;
    }
    const name = pathname.slice(1);
    const packed = packages.get(name);
    if (!packed) {
      // Lockfiles resolve every optional platform's metadata, even though npm
      // only downloads the matching tarball. Foreign descriptors are simulated
      // here, never executable payloads or claims of cross-platform runtime.
      const platform = Object.entries(targets).find(([id]) => name === `@3akhp/prts-mcp-${id}`);
      if (platform) {
        const [id,t] = platform;
        const meta = {name,version:receipt.version,os:[t.os],cpu:[t.arch],...(t.os==='linux'?{libc:'glibc'}:{}),
          dist:{tarball:`${url}/foreign/${id}.tgz`}};
        res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({name,'dist-tags':{latest:receipt.version},versions:{[receipt.version]:meta}}));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}'); return;
    }
    const meta = readJson(join(out, 'packages', name.replace('@','').replace('/','-'), 'package.json'));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name,
      'dist-tags': { latest: packed.version, next: packed.version },
      versions: { [packed.version]: { ...meta, dist: { tarball: `${url}/tarballs/${packed.filename}`, integrity: packed.integrity } } },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, hits, close: () => new Promise((resolve,reject) => {
    server.close(e => e ? reject(e) : resolve());
    server.closeAllConnections();
  }) };
}

export function npmSpawn(command, args, options = {}) {
  if (process.platform === 'win32') {
    const cli = join(dirname(process.execPath), `node_modules/npm/bin/${command === 'npx' ? 'npx' : 'npm'}-cli.js`);
    return spawn(process.execPath, [cli, ...args], options);
  }
  return spawn(command, args, options);
}

export function capture(command, args, options = {}) {
  return new Promise((resolve,reject) => {
    const child = npmSpawn(command, args, { ...options, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`npm command timeout: ${command} ${args.join(' ')}; ${stderr}`)); }, process.platform === 'win32' ? 600000 : 180000);
    child.stdout.on('data',data => { stdout += data; });
    child.stderr.on('data',data => { stderr += data; });
    child.once('error',error => { clearTimeout(timer); reject(error); });
    child.once('close',(code,signal) => { clearTimeout(timer); resolve({code,signal,stdout,stderr}); });
  });
}
