import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { canonicalFor, checkAll, checkCargo, checkOccurrences, detectBranch, loadDeclarations } from './versions.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'versions-test-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const DOC = {
  stable: '3.1.2',
  develop: '3.1.3-dev.0',
  lts: { '1.7': '1.7.3', '2.8': '2.8.2' },
  ltsEol: '2027-07-02',
  occurrences: {
    stable: [{ file: 'DOC.md', pattern: 'stable `([0-9]+\\.[0-9]+\\.[0-9]+)`' }],
    'lts.1.7': [{ file: 'DOC.md', pattern: 'lts `([0-9]+\\.[0-9]+\\.[0-9]+)`' }],
  },
};

function withDoc(doc, files) {
  return fixture({ 'versions.json': JSON.stringify(doc), ...files });
}

test('canonicalFor resolves plain and lts families', () => {
  assert.equal(canonicalFor(DOC, 'stable'), '3.1.2');
  assert.equal(canonicalFor(DOC, 'lts.1.7'), '1.7.3');
});

test('consistent occurrences pass', () => {
  const root = withDoc(DOC, { 'DOC.md': 'stable `3.1.2`\nlts `1.7.3`\n' });
  const { problems, checked } = checkOccurrences(root, loadDeclarations(root));
  assert.deepEqual(problems, []);
  assert.equal(checked, 2);
});

test('stale value is reported with file and line', () => {
  const root = withDoc(DOC, { 'DOC.md': 'first\nstable `3.1.1`\nlts `1.7.3`\n' });
  const { problems } = checkOccurrences(root, loadDeclarations(root));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^DOC\.md:2 stable: expected 3\.1\.2, found 3\.1\.1$/);
});

test('every match of a global pattern is checked', () => {
  const root = withDoc(DOC, { 'DOC.md': 'stable `3.1.2` and stable `3.0.9`\nlts `1.7.3`\n' });
  const { problems, checked } = checkOccurrences(root, loadDeclarations(root));
  assert.equal(checked, 3);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /found 3\.0\.9/);
});

test('disappeared anchor is a failure, not a pass', () => {
  const root = withDoc(DOC, { 'DOC.md': 'nothing here\n' });
  const { problems } = checkOccurrences(root, loadDeclarations(root));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /anchor no longer matches/);
});

test('Cargo.toml cross-check follows the branch', () => {
  const cargo = { 'Cargo.toml': '[package]\nname = "prts-mcp"\nversion = "3.1.2"\n' };
  assert.deepEqual(checkCargo(withDoc(DOC, cargo), DOC, 'main'), { skipped: false, problems: [] });
  const dev = checkCargo(withDoc(DOC, cargo), DOC, 'develop');
  assert.equal(dev.problems.length, 1);
  assert.match(dev.problems[0], /Cargo\.toml:3 branch develop: expected 3\.1\.3-dev\.0, found 3\.1\.2/);
  assert.deepEqual(checkCargo(withDoc(DOC, cargo), DOC, 'docs/topic'), { skipped: true, problems: [] });
});

test('missing registered file is a friendly failure', () => {
  const root = withDoc(DOC, {});
  const { problems } = checkOccurrences(root, loadDeclarations(root));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /DOC\.md: registered file is missing/);
});

test('detectBranch prefers CI environment over the local branch', () => {
  assert.equal(detectBranch({ GITHUB_BASE_REF: 'develop', GITHUB_REF_NAME: 'merge' }), 'develop');
  assert.equal(detectBranch({ GITHUB_REF_NAME: 'main' }), 'main');
});

test('checkAll combines occurrence and Cargo problems', () => {
  const root = withDoc(DOC, {
    'DOC.md': 'stable `3.1.0`\nlts `1.7.3`\n',
    'Cargo.toml': '[package]\nversion = "3.1.1"\n',
  });
  const { problems } = checkAll(root, 'main');
  assert.equal(problems.length, 2);
});
