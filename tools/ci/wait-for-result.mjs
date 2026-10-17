import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { githubApi, requiresFull, shouldRun, verifyLivePr } from './policy.mjs';

export function resultIdentity(eventName, event, ref) {
  return `CI result / ${eventName} / ${event.number ?? 0} / ${event.pull_request?.base.ref ?? ref} / `;
}

export function inspectResult(jobs, identity, tier, metadata) {
  const result = jobs.find(job => job.name.startsWith(identity));
  if (result) {
    if (result.name !== identity + tier) {
      assert.ok(metadata, 'CI result tier does not match this run');
      return 'mismatch';
    }
    if (result.status === 'completed') assert.equal(result.conclusion, 'success', `${result.name} did not succeed`);
    return result.status === 'completed' ? 'success' : 'pending';
  }
  // A result for a different PR is not proof for this PR, including fork runs
  // whose REST pull_requests array can be empty. Identity is in the job name.
  const other = jobs.find(job => job.name.startsWith('CI result / '));
  if (other) {
    assert.ok(metadata, 'CI result identity does not match this run');
    const prIdentity = identity.split(' / ').slice(0, 3).join(' / ') + ' / ';
    return other.name.startsWith(prIdentity) ? 'mismatch' : 'irrelevant';
  }
  const validationStarted = jobs.some(job => ['msrv', 'rust-validation'].includes(job.name) && job.conclusion !== 'skipped');
  if (metadata && !validationStarted && jobs.some(job => job.name.includes('CI result') && job.conclusion === 'skipped')) {
    return 'irrelevant';
  }
  // The newest real run may not have created its dependent result job yet.
  // Never fall back to older green proof while that run is unclassified.
  return 'pending';
}

export async function findProof(context, api, ignored = new Set()) {
  const { repository, runId, attempt, head, identity, tier, metadata } = context;
  const jobsFor = async (id, runAttempt) => {
    const page = await api(`repos/${repository}/actions/runs/${id}/attempts/${runAttempt}/jobs?per_page=100`);
    assert.equal(page.total_count, page.jobs.length, 'Incomplete CI jobs response');
    for (const job of page.jobs) {
      assert.equal(job.run_id, id, 'Wrong validation run');
      assert.equal(job.run_attempt, runAttempt, 'Wrong validation attempt; rerun all jobs');
      assert.equal(job.head_sha, head, 'Wrong validation HEAD');
    }
    return page.jobs;
  };
  if (!metadata) {
    const state = inspectResult(await jobsFor(runId, attempt), identity, tier, false);
    return state === 'success' ? { runId, attempt } : null;
  }
  const page = await api(`repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${encodeURIComponent(head)}&per_page=100`);
  const runs = page.workflow_runs.filter(run => run.id !== runId && run.head_sha === head && run.event === 'pull_request')
    .sort((a, b) => b.id - a.id);
  for (const run of runs) {
    const key = `${run.id}/${run.run_attempt}`;
    if (ignored.has(key)) continue;
    const state = inspectResult(await jobsFor(run.id, run.run_attempt), identity, tier, true);
    if (state === 'irrelevant') {
      ignored.add(key);
      continue;
    }
    if (state === 'success') return { runId: run.id, attempt: run.run_attempt };
    if (state === 'mismatch') return null;
    assert.ok(run.status !== 'completed', 'Newest matching run has no usable CI result; rerun all jobs');
    return null;
  }
  assert.ok(runs.length < 100, 'Validation proof is outside the newest 100 runs; start a fresh PR validation');
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const full = requiresFull(eventName, event);
  const context = {
    repository: process.env.GITHUB_REPOSITORY, runId: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT), head: event.pull_request?.head.sha ?? process.env.GITHUB_SHA,
    identity: resultIdentity(eventName, event, process.env.GITHUB_REF),
    tier: full ? 'full' : 'ordinary', metadata: !shouldRun(eventName, event),
  };
  const deadline = Date.now() + (full ? 85 : 20) * 60_000;
  const ignored = new Set();
  verifyLivePr(eventName, event);
  while (true) {
    const proof = await findProof(context, githubApi, ignored);
    if (proof) {
      verifyLivePr(eventName, event);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `CI gate passed: ${context.tier}, ${context.head}; validation run ${proof.runId}, attempt ${proof.attempt}.\n`);
      break;
    }
    assert.ok(Date.now() < deadline, 'Timed out waiting for current CI proof; rerun all validation jobs');
    await setTimeout(15_000);
  }
}
