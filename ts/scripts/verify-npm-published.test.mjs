#!/usr/bin/env node
// Unit test for ts/scripts/verify-npm-published.sh.
//
// Spins up a mock npm registry on localhost, then runs the verify script
// across six scenarios that pin its error contract, including the two
// load-bearing retry branches (a non-JSON packument body must not abort the
// script under `set -e`; an interrupted tarball download must retry):
//   1. match            — served tarball == local artifact        -> exit 0
//   2. drift            — served != local, but matches registry's -> exit 1, "intact" + "drifted"
//                         own declared hashes (local rebuilt)
//   3. anomaly          — served != local AND != registry's       -> exit 1, "does NOT match"
//                         declared hashes (registry/CDN anomaly)
//   4. propagation      — packument 404, never retrievable        -> exit 1, "propagation delay"
//   5. non-JSON 200     — packument serves garbage once, then OK  -> exit 0 (pins the `|| true` guard)
//   6. partial transfer — tarball interrupted once, then full     -> exit 0 (pins the curl-rc retry)
//
// Run: node scripts/verify-npm-published.test.mjs   (from ts/)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'verify-npm-published.sh');
const PKG = 'prts-mcp-ts';
const VERSION = '9.9.9-test';

const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const integrity = (b) => 'sha512-' + createHash('sha512').update(b).digest('base64');

const dir = mkdtempSync(join(tmpdir(), 'verify-npm-'));
let failures = 0;

// scenario drives the mock: what the tarball endpoint serves and what hashes
// the packument declares. Mutated per case before running the script.
// packumentCalls/tarballCalls let a scenario misbehave on the first request
// only, so the retry branches are exercised.
let scenario = null;
let packumentCalls = 0;
let tarballCalls = 0;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === `/${PKG}/${VERSION}`) {
    packumentCalls += 1;
    if (scenario.packument404) { res.statusCode = 404; res.end(); return; }
    // Serve a non-JSON 200 on the first call to pin the `|| true` guard: an
    // unguarded `read < <(node ...)` would abort the script under set -e.
    if (scenario.packumentGarbageOnFirst && packumentCalls === 1) {
      res.setHeader('content-type', 'application/json');
      res.end('not json {{{');
      return;
    }
    const served = scenario.servedTarball;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      dist: {
        tarball: `http://127.0.0.1:${server.address().port}/tarball`,
        shasum: scenario.declaredShasum ?? sha1(served),
        integrity: scenario.declaredIntegrity ?? integrity(served),
      },
    }));
    return;
  }
  if (pathname === '/tarball') {
    tarballCalls += 1;
    if (scenario.tarball404) { res.statusCode = 404; res.end(); return; }
    const body = scenario.servedTarball;
    // Interrupt the first transfer (claim more bytes than sent, then destroy
    // the socket) so curl exits non-zero; the script must retry, not misread
    // the truncated file as a byte mismatch.
    if (scenario.tarballPartialFirst && tarballCalls === 1) {
      res.setHeader('content-length', String(Buffer.byteLength(body) + 8192));
      res.write(body.subarray(0, Math.max(1, Math.floor(body.length / 2))));
      try { res.socket.destroy(); } catch { /* socket already gone */ }
      return;
    }
    res.setHeader('content-length', String(Buffer.byteLength(body)));
    res.end(body);
    return;
  }
  res.statusCode = 404; res.end();
});

function run(localArtifactPath) {
  // Async spawn (not spawnSync): the mock registry runs in this same process,
  // so the event loop must stay alive to answer the child's curl requests.
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, localArtifactPath], {
      env: {
        ...process.env,
        VERSION,
        NPM_PACKAGE: PKG,
        NPM_REGISTRY: `http://127.0.0.1:${server.address().port}`,
        VERIFY_ATTEMPTS: '2',
        VERIFY_SLEEP: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

async function check(name, localBytes, scn, { expectStatus, stdoutHas = [], stdoutNotHas = [] }) {
  scenario = scn;
  packumentCalls = 0;
  tarballCalls = 0;
  const local = join(dir, `${name}.tgz`);
  writeFileSync(local, localBytes);
  const r = await run(local);
  try {
    assert.strictEqual(r.status, expectStatus, `${name}: expected exit ${expectStatus}, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    for (const needle of stdoutHas) {
      assert.ok(r.stdout.includes(needle), `${name}: expected stdout to include ${JSON.stringify(needle)}\nstdout:\n${r.stdout}`);
    }
    for (const needle of stdoutNotHas) {
      assert.ok(!r.stdout.includes(needle), `${name}: stdout must NOT include ${JSON.stringify(needle)}\nstdout:\n${r.stdout}`);
    }
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.error(e.message);
  }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const GOOD = Buffer.from('this is the published tarball content - original');
const REBUILT = Buffer.from('this is a REBUILT tarball - bundled data changed');
const OTHER = Buffer.from('totally different bytes for the anomaly case');

// 1. match
await check('match', GOOD, { servedTarball: GOOD },
  { expectStatus: 0, stdoutHas: ['npm tarball SHA-256 verified'] });

// 2. drift: registry serves GOOD (its real bytes), local is REBUILT. The
//    served tarball matches the registry's declared shasum -> "intact".
await check('drift', REBUILT, { servedTarball: GOOD },
  { expectStatus: 1,
    stdoutHas: ['registry tarball is intact', 'drifted'],
    stdoutNotHas: ['does NOT match', 'investigate first'] });

// 3. anomaly: registry declares hashes of OTHER but serves GOOD -> served
//    bytes do not match the registry's own declared hashes.
await check('anomaly', REBUILT,
  { servedTarball: GOOD, declaredShasum: sha1(OTHER), declaredIntegrity: integrity(OTHER) },
  { expectStatus: 1,
    stdoutHas: ['does NOT match the registry', 'investigate first'],
    stdoutNotHas: ['intact', 'drifted'] });

// 4. propagation timeout: packument 404s forever.
await check('propagation', GOOD, { servedTarball: GOOD, packument404: true },
  { expectStatus: 1,
    stdoutHas: ['propagation delay', 'not a byte mismatch'],
    stdoutNotHas: ['bytes differ', 'investigate first'] });

// 5. non-JSON packument on the first call: the `|| true` guard must keep the
//    script alive so it retries and then succeeds.
await check('nonJsonPackument', GOOD, { servedTarball: GOOD, packumentGarbageOnFirst: true },
  { expectStatus: 0, stdoutHas: ['npm tarball SHA-256 verified'] });

// 6. partial tarball transfer on the first call: curl exits non-zero, so the
//    download must retry (not be hashed as a mismatch) and then succeed.
await check('partialTarball', GOOD, { servedTarball: GOOD, tarballPartialFirst: true },
  { expectStatus: 0, stdoutHas: ['npm tarball SHA-256 verified'] });

server.close();
rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} scenario(s) failed.`);
  process.exit(1);
}
console.log('\nAll verify-npm-published.sh scenarios passed.');
