import { verifyVersion, releasePolicy, run, json } from './common.mjs';
const version = verifyVersion();
const ref = process.env.GITHUB_REF ?? '';
if (process.argv.includes('--release')) {
  const policy = releasePolicy(version, ref, { repository: process.env.GITHUB_REPOSITORY,
    stableEnabled: process.env.RUST_STABLE_RELEASE_ENABLED === 'true' });
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  const actual = run('git', ['rev-parse', `${policy.tag}^{commit}`]).trim();
  if (actual !== commit) throw new Error('Tag does not resolve to the checked-out commit');
  if (policy.prerelease) {
    const branch = `refs/remotes/origin/release/v${version}`;
    run('git', ['merge-base', '--is-ancestor', commit, branch]);
  } else run('git', ['merge-base', '--is-ancestor', commit, 'origin/main']);
  json('artifacts/release-policy.json', { ...policy, commit });
}
console.log(`PRODUCT_VERSION_PASS: ${version}`);
