import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXPECTED_TOOLS = [
  "search_prts",
  "read_prts_page",
  "list_prts_sections",
  "get_prts_categories",
  "get_prts_links",
  "get_prts_template",
  "get_operator_archives",
  "get_operator_voicelines",
  "get_operator_basic_info",
  "list_enemies",
  "get_enemy_info",
  "get_stage_enemies",
  "get_enemy_appearances",
  "list_stages",
  "get_stage_info",
  "list_items",
  "get_item_info",
  "list_story_events",
  "list_stories",
  "get_event_summary",
  "get_story_summary",
  "read_story",
  "read_activity",
  "search",
  "search_stories",
  "get_operator_memoirs",
  "find_character_appearances",
  "find_speakers_in",
];

test("TypeScript MCP tool names are frozen", () => {
  // The tool registrations were split into modules under src/tools/.
  // Alpha hardening assumes tool names are registered as direct string literals.
  // Update this parser if tool registration moves to constants or helper wrappers.
  const toolsDir = join(import.meta.dirname, "..", "src", "tools");
  const toolFiles = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
  const source = toolFiles
    .map((f) => readFileSync(join(toolsDir, f), "utf-8"))
    .join("\n");
  const toolNames = Array.from(source.matchAll(/server\.tool\(\s*"([^"]+)"/g), (match) => match[1]);

  // Compare as sets — tool registration order is not part of the frozen surface.
  assert.deepEqual(toolNames.sort(), [...EXPECTED_TOOLS].sort());
  assert.equal(toolNames.length, EXPECTED_TOOLS.length, "tool count mismatch");
});
