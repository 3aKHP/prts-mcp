#!/usr/bin/env node
/**
 * Capture the Bun oracle's verdicts for the regex corpus
 * (contracts/cases/regex-corpus.json -> golden/regex-oracle.json).
 *
 * Each case: new RegExp(pattern, "iu").test(text). Invalid patterns record
 * rejected=true; the engine's message text is D-003 material (compared only
 * for presence, not wording).
 *
 * Usage: bun tools/capture-regex.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const corpus = JSON.parse(readFileSync(join(ROOT, "contracts", "cases", "regex-corpus.json"), "utf-8"));

const results = [];
for (const c of corpus.cases) {
  const entry = { id: c.id };
  try {
    const re = new RegExp(c.pattern, "iu");
    entry.match = re.test(c.text);
    entry.rejected = false;
  } catch (err) {
    entry.rejected = true;
    entry.match = null;
    entry.engine_message = err instanceof Error ? err.message : String(err);
  }
  results.push(entry);
}

const out = {
  oracle: `bun ${Bun.version}`,
  captured_at: new Date().toISOString(),
  flags: "iu",
  results,
};
const target = join(ROOT, "contracts", "cases", "golden", "regex-oracle.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 2) + "\n", "utf-8");
console.log(`regex oracle golden: ${results.length} cases -> contracts/cases/golden/regex-oracle.json`);
