import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type OutputChannel = "content" | "structured" | "both";

const VALID_CHANNELS = new Set<OutputChannel>(["content", "structured", "both"]);

function text(markdown: string): CallToolResult["content"][number] {
  return { type: "text", text: markdown };
}

export function parseChannel(raw: string | undefined): OutputChannel {
  if (!raw) return "content";
  const value = raw.trim().toLowerCase();
  if (VALID_CHANNELS.has(value as OutputChannel)) {
    return value as OutputChannel;
  }
  console.warn(
    `PRTS_OUTPUT_CHANNEL=${JSON.stringify(raw)} 不合法（可选 content/structured/both），回退到 content。`,
  );
  return "content";
}

function summarize(data: Record<string, unknown>, summary?: string): string {
  if (summary) return summary;
  const total = data["total"];
  if (typeof total === "number" && Number.isInteger(total)) {
    return `（结构化结果共 ${total} 条，详见 structuredContent）`;
  }
  return "（结构化结果详见 structuredContent）";
}

export function renderResult(
  data: Record<string, unknown> | null,
  markdown: string,
  channel: OutputChannel,
  summary?: string,
): CallToolResult {
  if (data === null || channel === "content") {
    return { content: [text(markdown)] };
  }
  if (channel === "both") {
    return { content: [text(markdown)], structuredContent: data };
  }
  return { content: [text(summarize(data, summary))], structuredContent: data };
}

export function textResult(markdown: string): CallToolResult {
  return { content: [text(markdown)] };
}
