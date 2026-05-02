import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXPECTED_TOOLS = [
  "search_prts",
  "read_prts_page",
  "get_operator_archives",
  "get_operator_voicelines",
  "get_operator_basic_info",
  "list_story_events",
  "list_stories",
  "read_story",
  "read_activity",
];

test("TypeScript MCP tool names are frozen", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf-8");
  // Alpha hardening assumes tool names are registered as direct string literals.
  // Update this parser if server.tool(...) moves to constants or helper wrappers.
  const toolNames = Array.from(source.matchAll(/server\.tool\(\s*"([^"]+)"/g), (match) => match[1]);

  assert.deepEqual(toolNames, EXPECTED_TOOLS);
});
