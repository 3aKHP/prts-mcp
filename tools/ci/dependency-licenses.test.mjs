import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, problems, run } from './dependency-licenses.mjs';

const pkg = (name, version = '1.0.0', license = 'MIT') => ({ name, version, license, repository: null, source: 'registry+fixture' });
const metadata = { packages: [pkg('b'), pkg('a'), { ...pkg('root'), source: null }] };
const generated = inventory(metadata, '1.96.1');

test('full registry inventory is sorted and independent of input order', () => {
  assert.deepEqual(generated.packages.map(p => p.name), ['a', 'b']);
  assert.equal(generated.lock_package_count, 2);
  assert.deepEqual(inventory({ packages: [...metadata.packages].reverse() }, '1.96.1'), generated);
  assert.deepEqual(generated.license_summary, { MIT: 2 });
});

test('detects additions removals version and license changes', () => {
  const changed = inventory({ packages: [pkg('a', '2.0.0'), pkg('b', '1.0.0', 'Apache-2.0'), pkg('c')] }, '1.96.1');
  const result = problems(generated, changed);
  for (const expected of ['added: a@2.0.0', 'removed: a@1.0.0', 'changed: b@1.0.0', 'added: c@1.0.0']) {
    assert.ok(result.includes(expected));
  }
  assert.ok(problems({ ...generated, flagged: [{ name: 'gone', version: '1', license: 'MIT' }] }, generated).some(p => p.startsWith('review flagged')));
});

test('write is repeatable, preserves manual content; check never writes or compares dates', () => {
  const root = mkdtempSync(join(tmpdir(), 'license-inventory-'));
  try {
    mkdirSync(join(root, 'contracts'));
    writeFileSync(join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.96.1"\n');
    const path = join(root, 'contracts/dependency-licenses.json');
    const manual = { flagged: [{ name: 'a', version: '1.0.0', license: 'MIT', disposition: 'human choice' }], notes: ['keep'], vendored: [{ name: 'regexp' }] };
    writeFileSync(path, JSON.stringify({ ...generated, ...manual, packages: [], recorded_at: 'old' }));
    const before = readFileSync(path, 'utf8');
    assert.ok(run(root, metadata).length);
    assert.equal(readFileSync(path, 'utf8'), before);
    run(root, metadata, { write: true, date: '2026-11-09' });
    const written = readFileSync(path, 'utf8');
    const doc = JSON.parse(written);
    for (const key of Object.keys(manual)) assert.deepEqual(doc[key], manual[key]);
    assert.deepEqual(run(root, metadata, { date: 'later' }), []);
    run(root, metadata, { write: true, date: 'later' });
    assert.equal(readFileSync(path, 'utf8'), written);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
