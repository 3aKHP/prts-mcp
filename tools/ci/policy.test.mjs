import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requiresFull, shouldRun, verifyCurrentPr, verifyGate } from './policy.mjs';

const pr = (base = 'develop', labels = []) => ({
  number: 261,
  pull_request: { base: { ref: base }, head: { sha: 'current-head' }, labels: labels.map(name => ({ name })) },
});
const checks = full => Object.fromEntries([
  ['workflow-lint', 'success'], ['msrv', 'success'], ['rust-validation', 'success'],
  ['native', full ? 'success' : 'skipped'],
].map(([job, result]) => [job, { result }]));

test('only main or the exact opt-in label selects full PR verification', () => {
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited', 'labeled', 'unlabeled']) {
    assert.equal(requiresFull('pull_request', { ...pr(), action }), false);
    assert.equal(requiresFull('pull_request', { ...pr('main'), action }), true);
    assert.equal(requiresFull('pull_request', { ...pr('develop', ['ci:full']), action }), true);
  }
  for (const base of ['develop', 'release/v3.0.1', 'fix/v3.0.1-urgent']) {
    assert.equal(requiresFull('pull_request', pr(base)), false);
    assert.equal(requiresFull('pull_request', pr(base, ['ci:full'])), true);
  }
  assert.equal(requiresFull('pull_request', pr('develop', ['ci:Full', 'bug'])), false);
  assert.equal(requiresFull('push', { ref: 'refs/heads/main' }), false);
  assert.equal(requiresFull('workflow_dispatch', pr('main', ['ci:full'])), false);
  assert.throws(() => requiresFull('pull_request', {}));
  assert.throws(() => requiresFull('schedule', {}));
});

test('base and ci:full edits run CI; unrelated metadata does not', () => {
  assert.equal(shouldRun('pull_request', { action: 'edited', changes: { base: { ref: { from: 'develop' } } } }), true);
  for (const changes of [{ title: { from: 'old' } }, { body: { from: 'old' } }, {}]) {
    assert.equal(shouldRun('pull_request', { action: 'edited', changes }), false);
  }
  for (const action of ['labeled', 'unlabeled']) {
    assert.equal(shouldRun('pull_request', { action, label: { name: 'ci:full' } }), true);
    assert.equal(shouldRun('pull_request', { action, label: { name: 'bug' } }), false);
  }
  assert.equal(shouldRun('pull_request', { action: 'synchronize' }), true);
  assert.equal(shouldRun('push', {}), true);
});

test('live PR metadata rejects obsolete HEAD, retargeting and both tier changes', () => {
  const current = event => ({ ...event.pull_request, state: 'open' });
  verifyCurrentPr(pr(), current(pr()));
  assert.throws(() => verifyCurrentPr(pr(), { ...current(pr()), head: { sha: 'new-head' } }));
  assert.throws(() => verifyCurrentPr(pr(), current(pr('other-base'))));
  assert.throws(() => verifyCurrentPr(pr(), current(pr('main'))));
  assert.throws(() => verifyCurrentPr(pr(), current(pr('develop', ['ci:full']))));
  assert.throws(() => verifyCurrentPr(pr('develop', ['ci:full']), current(pr())));
  assert.throws(() => verifyCurrentPr(pr(), { ...current(pr()), state: 'closed' }));
  // Unrelated labels do not invalidate proof for the same head/base/tier.
  verifyCurrentPr(pr(), current(pr('develop', ['bug'])));
});

test('both tiers fail closed for every failed, cancelled, skipped or absent required job', () => {
  for (const full of [false, true]) {
    verifyGate(String(full), checks(full));
    const required = ['workflow-lint', 'msrv', 'rust-validation', ...(full ? ['native'] : [])];
    for (const job of required) {
      for (const result of ['failure', 'cancelled', 'skipped', 'neutral', '', undefined]) {
        assert.throws(() => verifyGate(String(full), { ...checks(full), [job]: { result } }), `${full}/${job}/${result}`);
      }
      const missing = checks(full);
      delete missing[job];
      assert.throws(() => verifyGate(String(full), missing));
    }
  }
  for (const full of ['', undefined, 'False']) assert.throws(() => verifyGate(full, checks(false)));
  assert.throws(() => verifyGate('false', checks(true)));
});

test('real selection and gate entry points reject stale tier outputs and missing native proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prts-ci-policy-'));
  try {
    const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_OUTPUT: join(dir, 'output'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_REPOSITORY: 'example/repo',
      MOCK_PR_FILE: join(dir, 'current.json'), PATH: `${dir}:${process.env.PATH}` };
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs');
      if (process.argv.slice(2).join(' ') !== 'api repos/example/repo/pulls/261') process.exit(1);
      process.stdout.write(fs.readFileSync(process.env.MOCK_PR_FILE));\n`, { mode: 0o755 });
    const setCurrent = event => writeFileSync(env.MOCK_PR_FILE, JSON.stringify({ ...event.pull_request, state: 'open' }));
    const args = ['tools/ci/policy.mjs'];
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(pr()));
    setCurrent(pr());
    execFileSync(process.execPath, [...args, 'select'], { env });
    assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'run=true\nfull=false\n');
    execFileSync(process.execPath, [...args, 'gate'], { env: { ...env, CI_FULL: 'false', CI_NEEDS: JSON.stringify(checks(false)) } });
    // An actual rerun reads the old event with internally consistent outputs.
    // It must still fail if the live PR has since opted into the full tier.
    setCurrent(pr('develop', ['ci:full']));
    for (const command of ['select', 'gate']) {
      assert.notEqual(spawnSync(process.execPath, [...args, command], {
        env: { ...env, CI_FULL: 'false', CI_NEEDS: JSON.stringify(checks(false)) },
      }).status, 0);
    }
    for (const event of [pr('main'), pr('develop', ['ci:full'])]) {
      writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
      setCurrent(event);
      for (const [full, needs] of [['false', checks(false)], ['true', checks(false)]]) {
        assert.notEqual(spawnSync(process.execPath, [...args, 'gate'], {
          env: { ...env, CI_FULL: full, CI_NEEDS: JSON.stringify(needs) },
        }).status, 0);
      }
      execFileSync(process.execPath, [...args, 'gate'], { env: { ...env, CI_FULL: 'true', CI_NEEDS: JSON.stringify(checks(true)) } });
    }
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /full, five platforms.*current-head/);
    const metadata = { ...pr(), action: 'edited', changes: { body: { from: 'old' } } };
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(metadata));
    // Metadata filtering must not require a successful network lookup.
    writeFileSync(env.MOCK_PR_FILE, 'invalid JSON');
    execFileSync(process.execPath, [...args, 'select'], { env });
    assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /run=false\nfull=false\n$/);
    assert.notEqual(spawnSync(process.execPath, [...args, 'gate'], { env }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
