import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadDeclarations(root) {
  const doc = JSON.parse(readFileSync(join(root, 'versions.json'), 'utf8'));
  assert.ok(typeof doc.stable === 'string' && doc.stable, 'versions.json: missing stable');
  assert.ok(typeof doc.develop === 'string' && doc.develop, 'versions.json: missing develop');
  assert.ok(doc.lts && typeof doc.lts === 'object', 'versions.json: missing lts');
  assert.ok(typeof doc.ltsEol === 'string' && doc.ltsEol, 'versions.json: missing ltsEol');
  assert.ok(doc.occurrences && typeof doc.occurrences === 'object', 'versions.json: missing occurrences');
  return doc;
}

export function canonicalFor(doc, family) {
  const value = family.startsWith('lts.') ? doc.lts[family.slice(4)] : doc[family];
  assert.ok(typeof value === 'string' && value, `versions.json: no canonical value for ${family}`);
  return value;
}

export function checkOccurrences(root, doc) {
  const problems = [];
  let checked = 0;
  for (const [family, entries] of Object.entries(doc.occurrences)) {
    const expected = canonicalFor(doc, family);
    assert.ok(Array.isArray(entries) && entries.length > 0, `versions.json: empty occurrences for ${family}`);
    for (const { file, pattern } of entries) {
      assert.ok(file && pattern, `versions.json: malformed occurrence under ${family}`);
      const re = new RegExp(pattern, 'g');
      assert.ok(re.source.includes('('), `versions.json: pattern without capture group under ${family}`);
      let text;
      try {
        text = readFileSync(join(root, file), 'utf8');
      } catch {
        problems.push(`${file}: registered file is missing (${family}); restore the file or remove the entry from versions.json`);
        continue;
      }
      const matches = [...text.matchAll(re)];
      if (matches.length === 0) {
        problems.push(`${file}: anchor no longer matches (${family}, expected ${expected}); update the text or the pattern in versions.json`);
        continue;
      }
      for (const match of matches) {
        checked++;
        const actual = match[1];
        if (actual !== expected) {
          const line = text.slice(0, match.index).split('\n').length;
          problems.push(`${file}:${line} ${family}: expected ${expected}, found ${actual}`);
        }
      }
    }
  }
  return { problems, checked };
}

export function cargoExpected(doc, branch) {
  if (branch === 'main') return doc.stable;
  if (branch === 'develop') return doc.develop;
  return null;
}

export function checkCargo(root, doc, branch) {
  const expected = cargoExpected(doc, branch);
  if (expected === null) return { skipped: true, problems: [] };
  const toml = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  const match = toml.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"[ \t]*$/m);
  assert.ok(match, 'Cargo.toml: package version not found');
  if (match[1] === expected) return { skipped: false, problems: [] };
  const line = toml.slice(0, match.index).split('\n').length + (match[0].match(/\n/g) || []).length;
  return { skipped: false, problems: [`Cargo.toml:${line} branch ${branch}: expected ${expected}, found ${match[1]}`] };
}

export function detectBranch(env, cwd = REPO_ROOT) {
  if (env.GITHUB_BASE_REF) return env.GITHUB_BASE_REF;
  if (env.GITHUB_REF_NAME) return env.GITHUB_REF_NAME;
  try {
    return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8', cwd }).trim();
  } catch {
    return '';
  }
}

export function checkAll(root, branch) {
  const doc = loadDeclarations(root);
  const { problems, checked } = checkOccurrences(root, doc);
  const cargo = checkCargo(root, doc, branch);
  return { doc, problems: [...problems, ...cargo.problems], checked, cargoSkipped: cargo.skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--list')) {
    const doc = loadDeclarations(REPO_ROOT);
    for (const [family, entries] of Object.entries(doc.occurrences)) {
      console.log(`${family} = ${canonicalFor(doc, family)}`);
      for (const { file } of entries) console.log(`  ${file}`);
    }
  } else {
    const branch = detectBranch(process.env);
    const { problems, checked, cargoSkipped } = checkAll(REPO_ROOT, branch);
    for (const problem of problems) console.error(`VERSION_DRIFT: ${problem}`);
    if (problems.length > 0) {
      console.error(`Version consistency failed: ${problems.length} problem(s). Canonical values live in versions.json.`);
      process.exit(1);
    }
    console.log(`VERSIONS_PASS: ${checked} occurrence(s) checked against versions.json` +
      (cargoSkipped ? ` (Cargo.toml cross-check skipped on branch '${branch}')` : ` (Cargo.toml matches branch '${branch}')`));
  }
}
