import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findProof, inspectResult, resultIdentity } from './wait-for-result.mjs';

const event = { number: 42, pull_request: { base: { ref: 'develop' } } };
const identity = resultIdentity('pull_request', event, '');
const context = { repository: 'example/repo', runId: 100, attempt: 2, head: 'head', identity, tier: 'full', metadata: false };
const result = (tier = 'full', conclusion = 'success') => ({ name: identity + tier, status: 'completed', conclusion });
const jobsPage = (jobs, runId = 100, attempt = 2) => ({ total_count: jobs.length,
  jobs: jobs.map(job => ({ ...job, run_id: runId, run_attempt: attempt, head_sha: 'head' })) });
const run = (id, status = 'completed', attempt = 1) => ({ id, status, run_attempt: attempt, head_sha: 'head', event: 'pull_request', pull_requests: [] });

test('result identity binds event, PR number and base, including empty fork PR arrays', () => {
  assert.equal(identity, 'CI result / pull_request / 42 / develop / ');
  assert.equal(resultIdentity('push', {}, 'refs/heads/main'), 'CI result / push / 0 / refs/heads/main / ');
  assert.equal(inspectResult([result()], identity, 'full', false), 'success');
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral']) {
    assert.throws(() => inspectResult([result('full', conclusion)], identity, 'full', false));
  }
  assert.throws(() => inspectResult([result('ordinary')], identity, 'full', false));
});

test('normal gate waits only for its own run and attempt and rejects cross-run proof', async () => {
  const requests = [];
  const api = path => { requests.push(path); return jobsPage([result()]); };
  assert.deepEqual(await findProof(context, api), { runId: 100, attempt: 2 });
  assert.deepEqual(requests, ['repos/example/repo/actions/runs/100/jobs?filter=latest&per_page=100']);
  assert.equal(await findProof(context, () => jobsPage([])), null);
  for (const field of ['run_id', 'run_attempt', 'head_sha']) {
    const page = jobsPage([result()]);
    page.jobs[0][field] = 'old';
    await assert.rejects(findProof(context, () => page));
  }
  for (const attempt of [1, 3]) {
    await assert.rejects(findProof(context, () => jobsPage([result()], 100, attempt)), /Wrong validation attempt/);
  }
  await assert.rejects(findProof(context, () => ({ ...jobsPage([result()]), total_count: 101 })));
});

test('metadata uses the newest real matching proof, never itself or an older green', async () => {
  const metadata = { ...context, metadata: true };
  let newestJobs = [];
  const paths = [];
  const api = path => {
    paths.push(path);
    if (path.includes('/workflows/')) return { workflow_runs: [run(100), run(99, 'in_progress', 3), run(98)] };
    if (path.includes('/99/')) return jobsPage(newestJobs, 99, 3);
    if (path.includes('/98/')) return jobsPage([result()], 98, 1);
    throw new Error(`Unexpected request ${path}`);
  };
  assert.equal(await findProof(metadata, api), null);
  assert.ok(!paths.some(path => path.includes('/98/') || path.includes('/100/')));
  newestJobs = [result('full', 'failure')];
  await assert.rejects(findProof(metadata, api));
  newestJobs = [result()];
  assert.deepEqual(await findProof(metadata, api), { runId: 99, attempt: 3 });
  newestJobs = [result('ordinary')];
  assert.equal(await findProof(metadata, api), null);
});

test('metadata skips metadata runs and other PRs, but waits for an unclassified newer run', async () => {
  const metadata = { ...context, metadata: true };
  const ignored = new Set();
  const seen = [];
  const api = path => {
    seen.push(path);
    if (path.includes('/workflows/')) return { workflow_runs: [run(101), run(99), run(98)] };
    if (path.includes('/101/')) return jobsPage([{ name: 'format(CI result)', status: 'completed', conclusion: 'skipped' }], 101, 1);
    if (path.includes('/99/')) return jobsPage([{ ...result(), name: 'CI result / pull_request / 999 / develop / full' }], 99, 1);
    return jobsPage([result()], 98, 1);
  };
  assert.deepEqual(await findProof(metadata, api, ignored), { runId: 98, attempt: 1 });
  assert.ok(ignored.has('101/1') && ignored.has('99/1'));
  seen.length = 0;
  await findProof(metadata, api, ignored);
  assert.ok(!seen.some(path => path.includes('/101/') || path.includes('/99/')));
  const unknown = path => path.includes('/workflows/') ? { workflow_runs: [run(105, 'queued'), run(98)] } : jobsPage([], 105, 1);
  assert.equal(await findProof(metadata, unknown), null);
});

test('metadata refuses wrong base/tier, failed latest runs and stale attempts without fallback', async () => {
  const metadata = { ...context, metadata: true };
  for (const name of [identity + 'ordinary', 'CI result / pull_request / 42 / main / full']) {
    const api = path => path.includes('/workflows/') ? { workflow_runs: [run(99), run(98)] }
      : jobsPage([{ ...result(), name }], 99, 1);
    assert.equal(await findProof(metadata, api), null);
  }
  const noResult = path => path.includes('/workflows/') ? { workflow_runs: [run(99)] } : jobsPage([], 99, 1);
  await assert.rejects(findProof(metadata, noResult), /no usable CI result/);
  const staleAttempt = path => path.includes('/workflows/') ? { workflow_runs: [run(99, 'in_progress', 2)] } : jobsPage([result()], 99, 1);
  await assert.rejects(findProof(metadata, staleAttempt), /Wrong validation attempt/);
  const wrongHead = path => path.includes('/workflows/') ? { workflow_runs: [{ ...run(99), head_sha: 'old' }] }
    : assert.fail('An old HEAD must not be queried');
  assert.equal(await findProof(metadata, wrongHead), null);
});
