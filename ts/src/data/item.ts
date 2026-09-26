/**
 * Item/material data reader.
 * Reads item_table.json from local game data.
 * Mirrors python/src/prts_mcp/data/item.py.
 */

import { loadConfig } from "../config.js";
import { compareIds } from "./sort.js";
import { DirectoryStore } from "./stores.js";

const ITEM_FILE = "item_table.json";

const CLASSIFY_LABELS: Record<string, string> = {
  MATERIAL: "材料",
  NORMAL: "普通",
  CONSUME: "消耗品",
  NONE: "其他",
};

const OCCURRENCE_LABELS: Record<string, string> = {
  ALWAYS: "固定",
  ALMOST: "大概率",
  USUAL: "常规",
  OFTEN: "较高概率",
  SOMETIMES: "小概率",
};

const CATEGORY_ALIASES: Record<string, string> = {
  MATERIALS: "MATERIAL",
  "材料": "MATERIAL",
  "物资": "MATERIAL",
  NORMAL: "NORMAL",
  "普通": "NORMAL",
  CONSUME: "CONSUME",
  "消耗品": "CONSUME",
  NONE: "NONE",
  "其他": "NONE",
};

interface StageDrop {
  stageId?: string;
  occPer?: string;
  sortId?: number;
}

interface ItemEntry {
  itemId?: string;
  name?: string;
  description?: string | null;
  rarity?: string | null;
  iconId?: string | null;
  sortId?: number | null;
  usage?: string | null;
  obtainApproach?: string | null;
  hideInItemGet?: boolean | null;
  classifyType?: string | null;
  itemType?: string | null;
  stageDropList?: StageDrop[] | null;
  buildingProductList?: Record<string, unknown>[] | null;
  voucherRelateList?: Record<string, unknown>[] | null;
  shopRelateInfoList?: Record<string, unknown>[] | null;
}

interface ItemTable {
  items?: Record<string, ItemEntry>;
}

interface ItemSearchRecord {
  itemId: string;
  info: ItemEntry;
  searchText: string;
}

let itemTable: Record<string, ItemEntry> | null = null;
let itemLookup: Map<string, string> | null = null;
let itemSearchRecords: ItemSearchRecord[] | null = null;

export function clearItemCaches(): void {
  itemTable = null;
  itemLookup = null;
  itemSearchRecords = null;
}

function itemStore(): DirectoryStore {
  const ep = loadConfig().effectiveExcelPath;
  if (ep === null) throw new Error("effectiveExcelPath is null");
  return new DirectoryStore(ep);
}

function missingDataMessage(): string {
  const cfg = loadConfig();
  return (
    "物品数据暂不可用。请检查 GAMEDATA_PATH 配置，" +
    "或等待服务器自动从 GitHub Release 同步数据完成后重试。" +
    `（当前同步目标路径：${cfg.excelPath}）`
  );
}

function normalizeCategory(category: string): string {
  const raw = category.trim();
  const upper = raw.toUpperCase();
  return CATEGORY_ALIASES[upper] ?? CATEGORY_ALIASES[raw] ?? upper;
}

function rarityLabel(raw: string): string {
  return raw.startsWith("TIER_") ? raw.replace("TIER_", "T") : raw;
}

function classifyLabel(raw: string): string {
  return CLASSIFY_LABELS[raw] ?? (raw || "-");
}

function occurrenceLabel(raw: string): string {
  return OCCURRENCE_LABELS[raw] ?? (raw || "?");
}

function shortText(text: string, limit = 80): string {
  const cleaned = text.split(/\s+/).filter(Boolean).join(" ");
  return cleaned.length > limit ? cleaned.slice(0, limit) + "..." : cleaned;
}

function loadItems(): Record<string, ItemEntry> {
  if (itemTable === null) {
    const store = itemStore();
    if (!store.exists(ITEM_FILE)) {
      throw new Error(`物品数据文件不存在：${store.resolveForDiagnostics(ITEM_FILE)}。`);
    }
    const raw = store.readJson<ItemTable>(ITEM_FILE);
    if (!raw || typeof raw !== "object" || !raw.items || typeof raw.items !== "object") {
      throw new Error(`${ITEM_FILE} missing 'items' dict`);
    }
    itemTable = raw.items;
  }
  return itemTable;
}

function buildItemLookup(): Map<string, string> {
  if (itemLookup === null) {
    itemLookup = new Map<string, string>();
    for (const [itemId, info] of Object.entries(loadItems())) {
      itemLookup.set(itemId, itemId);
      if (info.name && !itemLookup.has(info.name)) itemLookup.set(info.name, itemId);
    }
  }
  return itemLookup;
}

export function getItemNameById(itemId: string): string | null {
  if (!itemId) return null;
  try {
    const item = loadItems()[itemId];
    return item?.name ?? null;
  } catch {
    return null;
  }
}

function resolveItemId(name: string): string | null {
  return buildItemLookup().get(name) ?? null;
}

function visibleItems(): Array<[string, ItemEntry]> {
  return Object.entries(loadItems()).filter(([, info]) => !info.hideInItemGet && info.name);
}

function formatStageDrops(dropList: StageDrop[] | null | undefined, maxEntries = 12): string {
  if (!Array.isArray(dropList) || dropList.length === 0) return "（无）";
  const lines = [...dropList]
    .sort((a, b) => (a.sortId ?? 9999) - (b.sortId ?? 9999))
    .slice(0, maxEntries)
    .map((entry) => `- ${entry.stageId ?? "?"}（${occurrenceLabel(entry.occPer ?? "")}）`);
  if (dropList.length > maxEntries) {
    lines.push(`- ...另有 ${dropList.length - maxEntries} 个关卡`);
  }
  return lines.join("\n");
}

function formatRelated(label: string, entries: Record<string, unknown>[] | null | undefined): string[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const lines = [`\n## ${label}`];
  for (const entry of entries.slice(0, 10)) {
    const bits = Object.entries(entry)
      .filter(([, value]) => value !== null && value !== "")
      .map(([key, value]) => `${key}=${String(value)}`);
    lines.push("- " + (bits.length > 0 ? bits.join("，") : "（空）"));
  }
  if (entries.length > 10) lines.push(`- ...另有 ${entries.length - 10} 条`);
  return lines;
}

export function listItems(
  category?: string | null,
  limit = 50,
  offset = 0,
): string {
  if (limit < 1) return "limit 必须 >= 1。";
  if (limit > 200) return "limit 必须 <= 200。";
  if (offset < 0) return "offset 必须 >= 0。";

  let entries: Array<[string, ItemEntry]>;
  try {
    entries = visibleItems();
  } catch (err) {
    return missingDataMessage() + `（${err instanceof Error ? err.message : String(err)}）`;
  }

  const categoryFilter = category ? normalizeCategory(category) : null;
  if (categoryFilter) {
    entries = entries.filter(([, info]) =>
      info.classifyType === categoryFilter || info.itemType === categoryFilter
    );
  }

  entries.sort((a, b) => {
    const sa = a[1].sortId ?? 999999;
    const sb = b[1].sortId ?? 999999;
    return sa !== sb ? sa - sb : compareIds(a[0], b[0]);
  });

  const total = entries.length;
  const page = entries.slice(offset, offset + limit);

  if (page.length === 0) {
    if (total === 0) return `没有匹配的物品（category=${category ?? "none"}）。`;
    return `offset ${offset} 超出范围（共 ${total} 条）。`;
  }

  const title = category
    ? `# 物品列表：${category}（共 ${total} 个）`
    : `# 物品列表（共 ${total} 个）`;
  const lines = [title];
  for (const [itemId, info] of page) {
    const name = info.name || "（无名）";
    const rarity = rarityLabel(info.rarity ?? "");
    const classify = classifyLabel(info.classifyType ?? "");
    const itemType = info.itemType ?? "-";
    const usage = shortText(info.usage ?? info.description ?? "");
    let line = `- **${name}** [${classify}/${itemType}] ${rarity}（id: ${itemId}）`;
    if (usage) line += ` — ${usage}`;
    lines.push(line);
  }

  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  lines.push(
    `\n（显示第 ${start}–${end} 条，共 ${total} 条。` +
    `使用 offset=${offset + limit} 查看下一页）`,
  );
  return lines.join("\n");
}

export function getItemInfo(name: string): string {
  let itemId: string | null;
  try {
    itemId = resolveItemId(name);
  } catch (err) {
    return missingDataMessage() + `（${err instanceof Error ? err.message : String(err)}）`;
  }
  if (itemId === null) return `未找到物品：${JSON.stringify(name)}。`;

  const info = loadItems()[itemId];
  if (!info) return `物品 ${JSON.stringify(name)} 暂无详细信息。`;

  const itemName = info.name || name;
  const parts: string[] = [`# ${itemName} — 物品信息`, "", "## 基本信息"];
  parts.push(`- **ID**：${itemId}`);
  parts.push(`- **稀有度**：${rarityLabel(info.rarity ?? "")}`);
  parts.push(`- **分类**：${classifyLabel(info.classifyType ?? "")}`);
  parts.push(`- **类型**：${info.itemType ?? "-"}`);
  if (info.iconId) parts.push(`- **图标**：${info.iconId}`);
  if (info.obtainApproach) parts.push(`- **获取方式**：${info.obtainApproach}`);

  if (info.description) parts.push("", "## 描述", info.description);
  if (info.usage) parts.push("", "## 用途", info.usage);

  parts.push("", "## 掉落关卡", formatStageDrops(info.stageDropList));
  parts.push(...formatRelated("基建产出", info.buildingProductList));
  parts.push(...formatRelated("商店关联", info.shopRelateInfoList));
  parts.push(...formatRelated("凭证关联", info.voucherRelateList));
  return parts.join("\n");
}

export function searchItems(pattern: string, maxResults = 30): string {
  if (maxResults < 1) return "max_results 必须 >= 1。";
  if (maxResults > 100) return "max_results 必须 <= 100。";

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "iu");
  } catch (err) {
    return `正则表达式无效：${err instanceof Error ? err.message : String(err)}`;
  }

  let records: ItemSearchRecord[];
  try {
    records = getItemSearchRecords();
  } catch (err) {
    return missingDataMessage() + `（${err instanceof Error ? err.message : String(err)}）`;
  }

  const results: ItemSearchRecord[] = [];
  for (const record of records) {
    if (regex.test(record.searchText)) {
      results.push(record);
      if (results.length >= maxResults) break;
    }
  }

  if (results.length === 0) return `未找到匹配 '${pattern}' 的物品。`;

  const lines = [`# 搜索结果：${pattern}（共 ${results.length} 个）`];
  for (const record of results) {
    const itemId = record.itemId;
    const info = record.info;
    const itemName = info.name || "（无名）";
    const classify = classifyLabel(info.classifyType ?? "");
    const itemType = info.itemType ?? "-";
    const rarity = rarityLabel(info.rarity ?? "");
    const usage = shortText(info.usage ?? info.description ?? "", 120);
    lines.push(`\n## ${itemName} [${classify}/${itemType}] ${rarity}（id: ${itemId}）`);
    if (usage) lines.push(`- **用途**：${usage}`);
    if (info.obtainApproach) lines.push(`- **获取方式**：${info.obtainApproach}`);
  }
  return lines.join("\n");
}

function getItemSearchRecords(): ItemSearchRecord[] {
  if (itemSearchRecords !== null) return itemSearchRecords;
  const entries = visibleItems();
  entries.sort((a, b) => {
    const sa = a[1].sortId ?? 999999;
    const sb = b[1].sortId ?? 999999;
    return sa !== sb ? sa - sb : compareIds(a[0], b[0]);
  });
  itemSearchRecords = entries.map(([itemId, info]) => ({
    itemId,
    info,
    searchText: [
      info.name,
      info.description,
      info.usage,
      info.obtainApproach,
      info.classifyType,
      info.itemType,
      itemId,
    ].filter(Boolean).join(" "),
  }));
  return itemSearchRecords;
}
