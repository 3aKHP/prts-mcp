import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function shouldRun(eventName, event) {
  if (eventName !== 'pull_request') return true;
  if (event.action === 'edited') return Boolean(event.changes?.base);
  if (['labeled', 'unlabeled'].includes(event.action)) return event.label?.name === 'ci:full';
  return true;
}

export function requiresFull(eventName, event) {
  if (eventName !== 'pull_request') {
    assert.ok(['push', 'workflow_dispatch'].includes(eventName), `Unexpected CI event: ${eventName}`);
    return false;
  }
  const pr = event.pull_request;
  assert.ok(pr?.base?.ref && pr?.head?.sha && Array.isArray(pr.labels), 'Incomplete PR event');
  return pr.base.ref === 'main' || pr.labels.some(label => label.name === 'ci:full');
}

export function verifyGate(full, needs) {
  assert.ok(['true', 'false'].includes(full), 'Missing or invalid verification tier');
  for (const job of ['workflow-lint', 'msrv', 'rust-validation']) {
    assert.equal(needs[job]?.result, 'success', `${job} must succeed`);
  }
  assert.equal(needs.native?.result, full === 'true' ? 'success' : 'skipped',
    'Native verification must match the selected tier and succeed when selected');
}

export function verifyCurrentPr(event, current) {
  assert.equal(current.state, 'open', 'PR is no longer open');
  assert.equal(current.head.sha, event.pull_request.head.sha, 'PR HEAD changed; use the latest PR run');
  assert.equal(current.base.ref, event.pull_request.base.ref, 'PR base changed; use the latest PR run');
  assert.equal(requiresFull('pull_request', { pull_request: current }), requiresFull('pull_request', event),
    'PR verification tier changed; use the latest PR run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const run = shouldRun(process.env.GITHUB_EVENT_NAME, event);
  const full = String(requiresFull(process.env.GITHUB_EVENT_NAME, event));
  if (run && process.env.GITHUB_EVENT_NAME === 'pull_request') {
    // Reruns retain their original event. Check live metadata both before the
    // expensive jobs and at the final gate, with a read-only token.
    assert.ok(Number.isSafeInteger(event.number) && event.number > 0, 'Missing PR number');
    const current = JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/pulls/${event.number}`],
      { encoding: 'utf8', timeout: 30_000 }));
    verifyCurrentPr(event, current);
  }
  switch (process.argv[2]) {
    case 'select':
      appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\nfull=${full}\n`);
      if (!run) {
        console.log('CI metadata update: existing verification continues unchanged');
        break;
      }
      console.log(`CI tier: ${full === 'true' ? 'full (five platforms)' : 'ordinary (Linux)'}; PR HEAD: ${event.pull_request?.head?.sha ?? process.env.GITHUB_SHA}`);
      break;
    case 'gate':
      assert.equal(run, true, 'Metadata-only events do not produce a CI gate');
      assert.equal(process.env.CI_FULL, full, 'Selected tier does not match this event');
      verifyGate(full, JSON.parse(process.env.CI_NEEDS));
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `CI passed: ${full === 'true' ? 'full, five platforms' : 'ordinary, Linux'} (${event.pull_request?.head?.sha ?? process.env.GITHUB_SHA}).\n`);
      break;
    default:
      throw new Error('Usage: node tools/ci/policy.mjs select|gate');
  }
}
