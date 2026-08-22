import test from "node:test";
import assert from "node:assert/strict";

import { compareIds } from "../src/data/sort.ts";

test("compareIds follows codepoint order like Python sorted()", () => {
  // ICU localeCompare orders punctuation after alphanumerics ("1.png"
  // before "1+.png"); Python sorted() compares codepoints ("+" U+002B <
  // "." U+002E).
  assert.ok(compareIds("立绘_阿米娅_1+.png", "立绘_阿米娅_1.png") < 0);
  assert.ok(compareIds("char_002_amiya#1", "char_002_amiya#1+") < 0);
  assert.ok(compareIds("char_002_amiya#1+", "char_002_amiya#2") < 0);
  // ICU folds uppercase ids after lowercase ones; codepoint order puts
  // all uppercase ("A" U+0041) before lowercase ("a" U+0061). This is the
  // order the item listing tie-break must match against Python.
  assert.ok(compareIds("AP_GAMEPLAY", "ap_item_base") < 0);
  assert.equal(compareIds("a", "a"), 0);
});
