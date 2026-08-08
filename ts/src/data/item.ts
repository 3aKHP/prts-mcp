/**
 * Item/material data reader.
 * Reads item_table.json from local game data.
 * Mirrors python/src/prts_mcp/data/item.py.
 */

import { checkActivationChange, loadConfig, registerActivationListener } from "../config.js";
import { DirectoryStore } from "./stores.js";
import { CacheMetrics } from "./cacheMetrics.js";
import type { CacheStat } from "../cacheStats.js";

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

export interface ItemsListingPayload {
  total: number;
  offset: number;
  limit: number;
  filters: {
    category: string | null;
    category_filter: string | null;
  };
  items: Array<{
    item_id: string;
    name: string;
    rarity_raw: string;
    rarity_label: string;
    classify_raw: string;
    classify_label: string;
    item_type: string;
    usage_excerpt: string;
  }>;
  empty_reason?: "no_match" | "offset_out_of_range";
}

export interface ItemInfoPayload {
  name: string;
  item_id: string;
  rarity_raw: string;
  rarity_label: string;
  classify_raw: string;
  classify_label: string;
  item_type: string;
  icon_id: string | null;
  obtain_approach: string | null;
  description: string | null;
  usage: string | null;
  stage_drop_list: StageDrop[];
  building_product_list: Record<string, unknown>[] | null;
  shop_relate_list: Record<string, unknown>[] | null;
  voucher_relate_list: Record<string, unknown>[] | null;
}

export interface ItemSearchPayload {
  scope: "items";
  pattern: string;
  total: number;
  results: Array<{
    item_id: string;
    name: string;
    classify_raw: string;
    classify_label: string;
    item_type: string;
    rarity_raw: string;
    rarity_label: string;
    usage: string;
    obtain_approach: string;
  }>;
}

let itemTable: Record<string, ItemEntry> | null = null;
let itemLookup: Map<string, string> | null = null;
let itemSearchRecords: ItemSearchRecord[] | null = null;
const itemTableMetrics = new CacheMetrics();
const itemLookupMetrics = new CacheMetrics();
const itemSearchRecordsMetrics = new CacheMetrics();

export function clearItemCaches(): void {
  itemTableMetrics.clear();
  itemLookupMetrics.clear();
  itemSearchRecordsMetrics.clear();
  itemTable = null;
  itemLookup = null;
  itemSearchRecords = null;
}

export function getCacheStats(): Record<string, CacheStat> {
  return {
    items: itemTableMetrics.snapshot(itemTable != null, itemTable ? Object.keys(itemTable).length : 0),
    item_lookup: itemLookupMetrics.snapshot(itemLookup != null, itemLookup ? itemLookup.size : 0),
    item_search_records: itemSearchRecordsMetrics.snapshot(itemSearchRecords != null, itemSearchRecords ? itemSearchRecords.length : 0),
  };
}

registerActivationListener(clearItemCaches);

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
  checkActivationChange();
  itemTableMetrics.access(itemTable !== null);
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
  checkActivationChange();
  itemLookupMetrics.access(itemLookup !== null);
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
  if (!dropList || dropList.length === 0) return "（无）";
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
  const data = buildItemsListing(category, limit, offset);
  if (typeof data === "string") return data;
  return renderItemsListing(data);
}

export function buildItemsListing(
  category?: string | null,
  limit = 50,
  offset = 0,
): ItemsListingPayload | string {
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
    return sa !== sb ? sa - sb : a[0].localeCompare(b[0]);
  });

  const total = entries.length;
  const page = entries.slice(offset, offset + limit);

  if (page.length === 0) {
    return {
      total,
      offset,
      limit,
      filters: { category: category ?? null, category_filter: categoryFilter },
      items: [],
      empty_reason: total === 0 ? "no_match" : "offset_out_of_range",
    };
  }

  const items = page.map(([itemId, info]) => ({
    item_id: itemId,
    name: info.name || "（无名）",
    rarity_raw: String(info.rarity ?? ""),
    rarity_label: rarityLabel(info.rarity ?? ""),
    classify_raw: String(info.classifyType ?? ""),
    classify_label: classifyLabel(info.classifyType ?? ""),
    item_type: info.itemType ?? "-",
    usage_excerpt: shortText(info.usage ?? info.description ?? ""),
  }));

  return {
    total,
    offset,
    limit,
    filters: { category: category ?? null, category_filter: categoryFilter },
    items,
  };
}

export function renderItemsListing(data: ItemsListingPayload): string {
  if (data.empty_reason === "no_match") {
    return `没有匹配的物品（category=${data.filters.category ?? "none"}）。`;
  }
  if (data.empty_reason === "offset_out_of_range") {
    return `offset ${data.offset} 超出范围（共 ${data.total} 条）。`;
  }

  const { total, offset, limit } = data;
  const category = data.filters.category;
  const title = category ? `# 物品列表：${category}（共 ${total} 个）` : `# 物品列表（共 ${total} 个）`;
  const lines = [title];
  for (const item of data.items) {
    let line = `- **${item.name}** [${item.classify_label}/${item.item_type}] ${item.rarity_label}（id: ${item.item_id}）`;
    if (item.usage_excerpt) line += ` — ${item.usage_excerpt}`;
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
  const data = buildItemInfo(name);
  if (typeof data === "string") return data;
  return renderItemInfo(data);
}

export function buildItemInfo(name: string): ItemInfoPayload | string {
  let itemId: string | null;
  try {
    itemId = resolveItemId(name);
  } catch (err) {
    return missingDataMessage() + `（${err instanceof Error ? err.message : String(err)}）`;
  }
  if (itemId === null) return `未找到物品：${JSON.stringify(name)}。`;

  const info = loadItems()[itemId];
  if (!info) return `物品 ${JSON.stringify(name)} 暂无详细信息。`;

  return {
    name: info.name || name,
    item_id: itemId,
    rarity_raw: String(info.rarity ?? ""),
    rarity_label: rarityLabel(info.rarity ?? ""),
    classify_raw: String(info.classifyType ?? ""),
    classify_label: classifyLabel(info.classifyType ?? ""),
    item_type: info.itemType ?? "-",
    icon_id: info.iconId || null,
    obtain_approach: info.obtainApproach || null,
    description: info.description || null,
    usage: info.usage || null,
    stage_drop_list: Array.isArray(info.stageDropList) ? info.stageDropList : [],
    building_product_list: info.buildingProductList ?? null,
    shop_relate_list: info.shopRelateInfoList ?? null,
    voucher_relate_list: info.voucherRelateList ?? null,
  };
}

export function renderItemInfo(data: ItemInfoPayload): string {
  const parts: string[] = [`# ${data.name} — 物品信息`, "", "## 基本信息"];
  parts.push(`- **ID**：${data.item_id}`);
  parts.push(`- **稀有度**：${data.rarity_label}`);
  parts.push(`- **分类**：${data.classify_label}`);
  parts.push(`- **类型**：${data.item_type}`);
  if (data.icon_id) parts.push(`- **图标**：${data.icon_id}`);
  if (data.obtain_approach) parts.push(`- **获取方式**：${data.obtain_approach}`);

  if (data.description) parts.push("", "## 描述", data.description);
  if (data.usage) parts.push("", "## 用途", data.usage);

  parts.push("", "## 掉落关卡", formatStageDrops(data.stage_drop_list));
  parts.push(...formatRelated("基建产出", data.building_product_list));
  parts.push(...formatRelated("商店关联", data.shop_relate_list));
  parts.push(...formatRelated("凭证关联", data.voucher_relate_list));
  return parts.join("\n");
}

export function searchItems(pattern: string, maxResults = 30): string {
  const data = buildItemSearch(pattern, maxResults);
  if (typeof data === "string") return data;
  return renderItemSearch(data);
}

export function buildItemSearch(pattern: string, maxResults = 30): ItemSearchPayload | string {
  if (maxResults < 1) return "max_results 必须 >= 1。";
  if (maxResults > 100) return "max_results 必须 <= 100。";

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
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

  return {
    scope: "items",
    pattern,
    total: results.length,
    results: results.map(itemSearchEntry),
  };
}

export function renderItemSearch(data: ItemSearchPayload): string {
  const { pattern, results } = data;
  if (results.length === 0) return `未找到匹配 '${pattern}' 的物品。`;

  const lines = [`# 搜索结果：${pattern}（共 ${data.total} 个）`];
  for (const item of results) {
    lines.push(
      `\n## ${item.name} [${item.classify_label}/${item.item_type}] ${item.rarity_label}（id: ${item.item_id}）`,
    );
    if (item.usage) lines.push(`- **用途**：${item.usage}`);
    if (item.obtain_approach) lines.push(`- **获取方式**：${item.obtain_approach}`);
  }
  return lines.join("\n");
}

function itemSearchEntry(record: ItemSearchRecord): ItemSearchPayload["results"][number] {
  const info = record.info;
  return {
    item_id: record.itemId,
    name: info.name || "（无名）",
    classify_raw: String(info.classifyType ?? ""),
    classify_label: classifyLabel(info.classifyType ?? ""),
    item_type: info.itemType ?? "-",
    rarity_raw: String(info.rarity ?? ""),
    rarity_label: rarityLabel(info.rarity ?? ""),
    usage: shortText(info.usage ?? info.description ?? "", 120),
    obtain_approach: info.obtainApproach ?? "",
  };
}

function getItemSearchRecords(): ItemSearchRecord[] {
  checkActivationChange();
  itemSearchRecordsMetrics.access(itemSearchRecords !== null);
  if (itemSearchRecords !== null) return itemSearchRecords;
  const entries = visibleItems();
  entries.sort((a, b) => {
    const sa = a[1].sortId ?? 999999;
    const sb = b[1].sortId ?? 999999;
    return sa !== sb ? sa - sb : a[0].localeCompare(b[0]);
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
