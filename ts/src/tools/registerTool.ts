/**
 * Thin SDK v2 registration adapter for the existing PRTS tool modules.
 *
 * SDK v2 requires a single object schema for every tool. Keeping the legacy
 * raw shape at this boundary preserves the established, strongly typed tool
 * declarations while ensuring every published schema is a Zod object.
 */
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z, type ZodRawShape } from "zod";

export function registerTool<Shape extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Shape,
  callback: (args: z.infer<z.ZodObject<Shape>>) => CallToolResult | Promise<CallToolResult>,
): void {
  server.registerTool(name, { description, inputSchema: z.object(inputSchema) }, callback);
}
