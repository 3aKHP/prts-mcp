/** MCP-level parity for operator actions. Mirrors python/tests/test_operator_query.py. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { clearBuildingCaches } from "../src/data/building.js";
import { clearOperatorCaches } from "../src/data/operator.js";
import { clearSkillCaches } from "../src/data/skill.js";
import { registerGamedataTools } from "../src/tools/gamedataTools.js";
import { writeMinimalGamedata } from "./fixtures/operatorData.ts";

const parity = join(import.meta.dirname, "..", "..", "tests", "parity-fixtures");
interface QueryCase {
  args: Record<string, unknown>;
  fixture?: string;
  text?: string;
  error?: string;
}
const cases: QueryCase[] = JSON.parse(readFileSync(join(parity, "operator-query-cases.json"), "utf-8"));

interface RegisteredTool {
  inputSchema: z.ZodObject;
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}
class CapturingServer {
  tools = new Map<string, RegisteredTool>();
  registerTool(name: string, config: { inputSchema: z.ZodObject }, handler: RegisteredTool["handler"]): void {
    this.tools.set(name, { inputSchema: config.inputSchema, handler });
  }
}

function resetCaches(): void {
  clearOperatorCaches();
  clearBuildingCaches();
  clearSkillCaches();
}

function operatorData(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "prts-operator-query-"));
  const oldRoot = process.env["GAMEDATA_PATH"];
  process.env["GAMEDATA_PATH"] = root;
  writeMinimalGamedata(root);
  resetCaches();
  t.after(() => {
    if (oldRoot === undefined) delete process.env["GAMEDATA_PATH"];
    else process.env["GAMEDATA_PATH"] = oldRoot;
    resetCaches();
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("operator actions match shared payload/error contracts in every channel", async (t) => {
  operatorData(t);
  for (const channel of ["content", "structured", "both"] as const) {
    const server = new CapturingServer();
    registerGamedataTools(server as unknown as McpServer, channel);
    assert.equal(server.tools.has("get_operator_skills"), false);
    assert.equal(server.tools.has("get_operator_stats"), false);
    const tool = server.tools.get("get_operator_basic_info")!;
    assert.equal(tool.inputSchema.parse({ name: "阿米娅" })["action"], "basic");
    assert.equal(tool.inputSchema.safeParse({ name: "阿米娅", action: "unknown" }).success, false);
    for (const query of cases) {
      const result = await tool.handler(tool.inputSchema.parse(query.args));
      const content = result.content[0];
      assert.ok(content.type === "text");
      if (query.error) {
        assert.equal(content.text, query.error);
        assert.equal(result.structuredContent, undefined);
      } else {
        if (channel !== "content") {
          const expected = JSON.parse(readFileSync(join(parity, query.fixture!), "utf-8"));
          assert.deepEqual(result.structuredContent, expected);
        } else {
          assert.equal(result.structuredContent, undefined);
        }
        if (channel !== "structured") assert.ok(content.text.includes(query.text!));
      }
    }
  }
});

test("basic and stats do not require the skill table", async (t) => {
  const root = operatorData(t);
  unlinkSync(join(root, "zh_CN/gamedata/excel/skill_table.json"));
  const server = new CapturingServer();
  registerGamedataTools(server as unknown as McpServer, "both");
  const tool = server.tools.get("get_operator_basic_info")!;
  for (const action of ["basic", "stats"]) {
    assert.ok((await tool.handler(tool.inputSchema.parse({ name: "阿米娅", action }))).structuredContent);
  }
  const result = await tool.handler(tool.inputSchema.parse({ name: "阿米娅", action: "skills" }));
  assert.equal(result.structuredContent, undefined);
  assert.ok(JSON.stringify(result.content).includes("战斗技能数据文件不存在"));
});
