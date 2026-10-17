import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const full = String(requiresFull(process.env.GITHUB_EVENT_NAME, event));
  switch (process.argv[2]) {
    case 'select':
      appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
      console.log(`CI tier: ${full === 'true' ? 'full (five platforms)' : 'ordinary (Linux)'}; PR HEAD: ${event.pull_request?.head?.sha ?? process.env.GITHUB_SHA}`);
      break;
    case 'gate':
      // Recompute from this run's event, rather than trusting an absent output
      // after a failed or cancelled selection job.
      assert.equal(process.env.CI_FULL, full, 'Selected tier does not match this event');
      verifyGate(full, JSON.parse(process.env.CI_NEEDS));
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `CI passed: ${full === 'true' ? 'full, five platforms' : 'ordinary, Linux'} (${event.pull_request?.head?.sha ?? process.env.GITHUB_SHA}).\n`);
      break;
    default:
      throw new Error('Usage: node tools/ci/policy.mjs select|gate');
  }
}
