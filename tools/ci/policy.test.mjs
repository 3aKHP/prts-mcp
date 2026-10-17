import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requiresFull, verifyGate } from './policy.mjs';

const pr = (base = 'develop', labels = []) => ({
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
      GITHUB_STEP_SUMMARY: join(dir, 'summary') };
    const args = ['tools/ci/policy.mjs'];
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(pr()));
    execFileSync(process.execPath, [...args, 'select'], { env });
    assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'full=false\n');
    execFileSync(process.execPath, [...args, 'gate'], { env: { ...env, CI_FULL: 'false', CI_NEEDS: JSON.stringify(checks(false)) } });
    for (const event of [pr('main'), pr('develop', ['ci:full'])]) {
      writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
      for (const [full, needs] of [['false', checks(false)], ['true', checks(false)]]) {
        assert.notEqual(spawnSync(process.execPath, [...args, 'gate'], {
          env: { ...env, CI_FULL: full, CI_NEEDS: JSON.stringify(needs) },
        }).status, 0);
      }
      execFileSync(process.execPath, [...args, 'gate'], { env: { ...env, CI_FULL: 'true', CI_NEEDS: JSON.stringify(checks(true)) } });
    }
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /full, five platforms.*current-head/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
