import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type OutputChannel = "content" | "structured" | "both";

const VALID_CHANNELS = new Set<OutputChannel>(["content", "structured", "both"]);
type StructuredContent = NonNullable<CallToolResult["structuredContent"]>;

function text(markdown: string): CallToolResult["content"][number] {
  return { type: "text", text: markdown };
}

export function parseChannel(
  raw: string | undefined,
  source: string = "PRTS_OUTPUT_CHANNEL",
  warn: (message: string) => void = console.warn,
): OutputChannel {
  if (!raw) return "content";
  const value = raw.trim().toLowerCase();
  if (VALID_CHANNELS.has(value as OutputChannel)) {
    return value as OutputChannel;
  }
  warn(`${source}=${JSON.stringify(raw)} 不合法（可选 content/structured/both），回退到 content。`);
  return "content";
}

function summarize<T extends object>(data: T, summary?: string): string {
  if (summary) return summary;
  const total = (data as { total?: unknown }).total;
  if (typeof total === "number" && Number.isInteger(total)) {
    return `（结构化结果共 ${total} 条，详见 structuredContent）`;
  }
  return "（结构化结果详见 structuredContent）";
}

export function renderResult<T extends object>(
  data: T | null,
  markdown: string,
  channel: OutputChannel,
  summary?: string,
): CallToolResult {
  if (data === null || channel === "content") {
    return { content: [text(markdown)] };
  }
  const structuredContent = data as StructuredContent;
  if (channel === "both") {
    return { content: [text(markdown)], structuredContent };
  }
  return { content: [text(summarize(data, summary))], structuredContent };
}

export function textResult(markdown: string): CallToolResult {
  return { content: [text(markdown)] };
}
