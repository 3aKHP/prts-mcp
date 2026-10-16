import assert from 'node:assert/strict';

function versionSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const headings = lines.flatMap((line, index) =>
    /^## /.test(line) ? [{ line, index }] : []);
  const matches = headings.filter(({ line }) =>
    line === `## [${version}]` || line.startsWith(`## [${version}] `));
  assert.equal(matches.length, 1, `CHANGELOG requires one section for ${version}`);
  const start = matches[0].index;
  const end = headings.find(({ index }) => index > start)?.index ?? lines.length;
  const section = lines.slice(start + 1, end).join('\n').trim();
  assert(section, `CHANGELOG section is empty for ${version}`);
  return section;
}

// Preserve the reviewed bilingual release text; only installation metadata is generated.
export function releaseNotes({ english, chinese, policy, repository, commit }) {
  const base = `https://github.com/${repository}/blob/${commit}`;
  return `# PRTS-MCP ${policy.version}\n\n${versionSection(english, policy.version)}\n\n## 中文\n\n${versionSection(chinese, policy.version)}\n\n---\n\nnpm (\`@${policy.npmTag}\`): \`npm install -g prts-mcp@${policy.version}\`\n\nDocker: \`ghcr.io/3akhp/prts-mcp:${policy.version}\`\n\n[2.x → 3.0](${base}/docs/migration-2.x-to-3.0.md) · [Platforms / 平台](${base}/docs/dev/NATIVE-PLATFORMS.md) · [Source / 源码](https://github.com/${repository}/tree/${commit})\n`;
}
