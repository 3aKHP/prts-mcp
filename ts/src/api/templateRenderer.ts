import { XMLParser } from "fast-xml-parser";

export class TemplateRenderError extends Error {}

type XmlEntry = Record<string, unknown>;
type XmlContent = XmlEntry[];

interface XmlElement {
  content: XmlContent;
  attrs: Record<string, string>;
}

interface TemplatePart {
  name?: string;
  value: string;
  needsRender: boolean;
}

interface TemplateEntry {
  name: string;
  parts: TemplatePart[];
  comment: string;
}

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  commentPropName: "#comment",
  parseTagValue: false,
  trimValues: false,
});

function isRecord(value: unknown): value is XmlEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asContent(value: unknown): XmlContent {
  return Array.isArray(value) && value.every(isRecord) ? value : [];
}

function attributes(entry: XmlEntry): Record<string, string> {
  const attrs = entry[":@"];
  if (!isRecord(attrs)) return {};
  return Object.fromEntries(
    Object.entries(attrs).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function elements(content: XmlContent, tag: string): XmlElement[] {
  return content.flatMap((entry) => {
    const children = entry[tag];
    if (!Array.isArray(children)) return [];
    return [{ content: asContent(children), attrs: attributes(entry) }];
  });
}

function firstElement(content: XmlContent, tag: string): XmlElement | undefined {
  return elements(content, tag)[0];
}

function textWithoutComments(content: XmlContent): string {
  let text = "";
  for (const entry of content) {
    if (typeof entry["#text"] === "string") text += entry["#text"];
    for (const [tag, value] of Object.entries(entry)) {
      if (tag === "#text" || tag === "#comment" || tag === "comment" || tag === ":@" || !Array.isArray(value)) continue;
      text += textWithoutComments(asContent(value));
    }
  }
  return text;
}

function partToWikitext(part: XmlElement): string {
  const value = firstElement(part.content, "value");
  if (!value) throw new TemplateRenderError("模板字段缺少 value 节点。");
  const name = firstElement(part.content, "name");
  const renderedValue = contentToWikitext(value.content);
  if (!name || "@_index" in name.attrs) return `|${renderedValue}`;
  const renderedName = textWithoutComments(name.content).trim();
  return renderedName ? `|${renderedName}=${renderedValue}` : `|${renderedValue}`;
}

function elementToWikitext(tag: string, element: XmlElement): string {
  if (tag === "template") {
    const title = firstElement(element.content, "title");
    const name = title ? textWithoutComments(title.content).trim() : "";
    if (!name) throw new TemplateRenderError("嵌套模板缺少 title 节点。");
    return `{{${name}${elements(element.content, "part").map(partToWikitext).join("")}}}`;
  }

  if (tag === "tplarg") {
    const title = firstElement(element.content, "title");
    const name = title ? textWithoutComments(title.content).trim() : "";
    if (!name) throw new TemplateRenderError("模板参数缺少 title 节点。");
    return `{{{${name}${elements(element.content, "part").map(partToWikitext).join("")}}}`;
  }

  if (tag === "link") {
    const target = firstElement(element.content, "target");
    const targetText = target ? contentToWikitext(target.content).trim() : "";
    if (!targetText) throw new TemplateRenderError("链接缺少 target 节点。");
    return `[[${targetText}${elements(element.content, "part").map(partToWikitext).join("")}]]`;
  }

  throw new TemplateRenderError(`不支持的模板字段节点：${tag}。`);
}

function contentToWikitext(content: XmlContent): string {
  let text = "";
  for (const entry of content) {
    if (typeof entry["#text"] === "string") text += entry["#text"];
    if (typeof entry["#comment"] === "string") text += `<!--${entry["#comment"]}-->`;
    for (const [tag, value] of Object.entries(entry)) {
      if (tag === "#text" || tag === "#comment" || tag === ":@" || !Array.isArray(value)) continue;
      if (tag === "comment") {
        text += `<!--${textWithoutComments(asContent(value))}-->`;
      } else {
        text += elementToWikitext(tag, { content: asContent(value), attrs: attributes(entry) });
      }
    }
  }
  return text;
}

function parseTemplates(xml: string): TemplateEntry[] {
  let parsed: XmlContent;
  try {
    parsed = asContent(xmlParser.parse(xml));
  } catch (error) {
    throw new TemplateRenderError("页面模板数据格式无效。", { cause: error });
  }
  const root = firstElement(parsed, "root");
  if (!root) throw new TemplateRenderError("页面模板数据格式无效。");

  return elements(root.content, "template").flatMap((template) => {
    const title = firstElement(template.content, "title");
    const name = title ? textWithoutComments(title.content).trim() : "";
    if (!name) return [];
    const commentElement = title ? firstElement(title.content, "comment") : undefined;
    const comment = commentElement ? textWithoutComments(commentElement.content).trim() : "";
    const parts = elements(template.content, "part").flatMap((part) => {
      const value = firstElement(part.content, "value");
      if (!value) return [];
      const nameElement = firstElement(part.content, "name");
      const partName = nameElement && !("@_index" in nameElement.attrs)
        ? textWithoutComments(nameElement.content).trim() || undefined
        : undefined;
      const needsRender = value.content.some((entry) => Object.keys(entry).some(
        (key) => key !== "#text" && key !== "#comment" && key !== "comment" && key !== ":@",
      ));
      const rawValue = needsRender ? contentToWikitext(value.content) : textWithoutComments(value.content);
      return rawValue.trim() ? [{ name: partName, value: rawValue, needsRender }] : [];
    });
    return [{ name, parts, comment }];
  });
}

export async function renderTemplateData(
  title: string,
  xml: string,
  renderBatch: (title: string, values: string[]) => Promise<string[]>,
): Promise<Record<string, Record<string, unknown>>> {
  const templates = parseTemplates(xml);
  const sources = templates.flatMap((template) => template.parts
    .filter((part) => part.needsRender)
    .map((part) => part.value));
  const rendered = sources.length > 0 ? await renderBatch(title, sources) : [];
  if (rendered.length !== sources.length) {
    throw new TemplateRenderError("模板字段渲染结果数量不匹配。");
  }

  const iterator = rendered.values();
  const result: Record<string, Record<string, unknown>> = {};
  for (const template of templates) {
    const entry: Record<string, unknown> = {};
    const positional: string[] = [];
    for (const part of template.parts) {
      const value = part.needsRender ? iterator.next().value : part.value;
      if (!value) continue;
      if (part.name) entry[part.name] = value;
      else positional.push(value);
    }
    if (positional.length > 0) entry._positional = positional;
    if (template.comment) entry._comment = template.comment;
    if (Object.keys(entry).length > 0) result[template.name] = entry;
  }
  return result;
}
