import test from "node:test";
import assert from "node:assert/strict";

import { compareArtworkIds } from "../src/data/artworkFormat.ts";

test("compareArtworkIds follows codepoint order like Python sorted()", () => {
  // ICU localeCompare puts punctuation after alphanumerics ("1.png" before
  // "1+.png"); Python sorted() compares codepoints ("+" U+002B < "." U+002E).
  assert.ok(compareArtworkIds("立绘_阿米娅_1+.png", "立绘_阿米娅_1.png") < 0);
  assert.ok(compareArtworkIds("char_002_amiya#1", "char_002_amiya#1+") < 0);
  assert.ok(compareArtworkIds("char_002_amiya#1+", "char_002_amiya#2") < 0);
  assert.equal(compareArtworkIds("a", "a"), 0);
});
