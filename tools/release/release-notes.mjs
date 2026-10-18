import assert from 'node:assert/strict';
import { nativeArchives } from './github-assets.mjs';

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
  const download = `https://github.com/${repository}/releases/download/${policy.tag}`;
  const labels = ['Linux x64', 'Linux ARM64', 'Windows x64', 'macOS Apple Silicon', 'macOS Intel'];
  const rows = nativeArchives(policy.version).map((row, index) =>
    `| ${labels[index]} | [${row.filename}](${download}/${row.filename}) |`).join('\n');
  const downloads = `## Downloads / 下载\n\n| Platform / 平台 | Archive / 安装包 |\n| --- | --- |\n${rows}\n\n[SHA256SUMS](${download}/SHA256SUMS) · [Release metadata / 验证资料](${download}/prts-mcp-${policy.version}-release-metadata.zip)\n\nArchives include the native executables and fallback data. npm packages are available from npm; Docker images are available from GHCR.\n\n安装包包含原生可执行文件与备用数据。npm 包通过 npm 获取，Docker 镜像通过 GHCR 获取。`;
  return `# PRTS-MCP ${policy.version}\n\n${downloads}\n\n${versionSection(english, policy.version)}\n\n## 中文\n\n${versionSection(chinese, policy.version)}\n\n---\n\nnpm (\`@${policy.npmTag}\`): \`npm install -g prts-mcp@${policy.version}\`\n\nDocker: \`ghcr.io/3akhp/prts-mcp:${policy.version}\`\n\n[2.x → 3.0](${base}/docs/migration-2.x-to-3.0.md) · [Platforms / 平台](${base}/docs/dev/NATIVE-PLATFORMS.md) · [Source / 源码](https://github.com/${repository}/tree/${commit})\n`;
}
