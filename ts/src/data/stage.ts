import { checkActivationChange, registerActivationListener } from "../activation.js";
import { loadConfig } from "../config.js";
import { DirectoryStore } from "./stores.js";
import { getItemNameById } from "./item.js";
import { CacheMetrics } from "./cacheMetrics.js";
import type { CacheStat } from "../cacheStats.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StageEntry {
  stageId?: string;
  code?: string | null;
  name?: string | null;
  stageType?: string | null;
  difficulty?: string | null;
  zoneId?: string | null;
  levelId?: string | null;
  apCost?: number | null;
  dangerLevel?: string | null;
  description?: string | null;
  stageDropInfo?: Record<string, unknown> | null;
  unlockCondition?: { stageId: string; completeState: string }[] | null;
  hardStagedId?: string | null;
  sixStarStageId?: string | null;
  bossMark?: boolean | null;
}

type StageTable = Record<string, StageEntry>;

interface ZoneEntry {
  zoneID?: string;
  zoneNameFirst?: string | null;
  zoneNameSecond?: string | null;
}

type ZoneTable = Record<string, ZoneEntry>;

interface StageSearchRecord {
  stageId: string;
  entry: StageEntry;
  searchText: string;
}

export interface StageListingEntry {
  stage_id: string;
  name: string;
  code: string;
  type: string;
  type_label: string;
  difficulty_label: string;
  zone_id: string;
  zone_display: string;
}

export interface StagesListingPayload {
  total: number;
  offset: number;
  limit: number;
  filters: {
    chapter: string | null;
    type: string | null;
  };
  stages: StageListingEntry[];
}

export interface StageInfoPayload {
  stage_id: string;
  name: string;
  code: string;
  type_raw: string;
  type_label: string;
  difficulty_raw: string;
  difficulty_label: string;
  zone_id: string;
  zone_display: string;
  ap_cost: number | string;
  danger_level: string;
  boss_mark: boolean;
  description: string;
  drop_info: Record<string, unknown> | null;
  unlock_conditions: { stageId: string; completeState: string }[];
  level_id: string | null;
  hard_stage: { id: string | null; name: string | null };
  six_star_stage: { id: string | null; name: string | null };
}

export interface StageSearchPayload {
  scope: "stages";
  pattern: string;
  total: number;
  results: Array<{
    stage_id: string;
    name: string;
    code: string;
    type: string;
    type_label: string;
    difficulty: string;
    difficulty_label: string;
    zone_id: string;
    zone_display: string;
    ap: number | string;
    description: string;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STAGE_FILE = "stage_table.json";
const ZONE_FILE = "zone_table.json";

const STAGE_TYPE_LABELS: Record<string, string> = {
  MAIN: "主线",
  ACTIVITY: "活动",
  SUB: "支线",
  DAILY: "每日",
  CAMPAIGN: "剿灭",
  CLIMB_TOWER: "爬塔",
  SPECIAL_STORY: "特殊故事",
  GUIDE: "教程",
};

const DIFFICULTY_LABELS: Record<string, string> = {
  NORMAL: "普通",
  FOUR_STAR: "突袭",
  SIX_STAR: "六星",
};

// ---------------------------------------------------------------------------
// Module-level caches
// ---------------------------------------------------------------------------

let _stageTable: StageTable | null = null;
let _zoneTable: ZoneTable | null = null;
let _zoneTableFailed = false;
let _stageSearchRecords: StageSearchRecord[] | null = null;
const stageTableMetrics = new CacheMetrics();
const zoneTableMetrics = new CacheMetrics();
const stageSearchRecordsMetrics = new CacheMetrics();

export function clearStageCaches(): void {
  stageTableMetrics.clear();
  zoneTableMetrics.clear();
  stageSearchRecordsMetrics.clear();
  _stageTable = null;
  _zoneTable = null;
  _zoneTableFailed = false;
  _stageSearchRecords = null;
}

export function getCacheStats(): Record<string, CacheStat> {
  return {
    stage_table: stageTableMetrics.snapshot(_stageTable != null, _stageTable ? Object.keys(_stageTable).length : 0),
    zone_table: zoneTableMetrics.snapshot(_zoneTable != null, _zoneTable ? Object.keys(_zoneTable).length : 0),
    stage_search_records: stageSearchRecordsMetrics.snapshot(_stageSearchRecords != null, _stageSearchRecords ? _stageSearchRecords.length : 0),
  };
}

registerActivationListener(clearStageCaches);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stageTypeLabel(t: string): string {
  return STAGE_TYPE_LABELS[t] ?? t;
}

function difficultyLabel(d: string): string {
  return DIFFICULTY_LABELS[d] ?? d;
}

function cleanDescription(desc: string): string {
  if (!desc) return "";
  return desc.replace(/<[^>]+>/g, "").trim();
}

function formatUnlock(conditions: { stageId: string; completeState: string }[] | null): string {
  if (!conditions || conditions.length === 0) return "（无条件）";
  const labels: Record<string, (sid: string) => string> = {
    PASS: (sid) => `通关 ${sid}`,
    STAR_3: (sid) => `三星通关 ${sid}`,
  };
  const parts = conditions.map((c) => {
    const fn = labels[c.completeState] ?? ((s: string) => `${c.completeState} ${s}`);
    return fn(c.stageId);
  });
  return parts.join("；");
}

function formatDrops(dropInfo: Record<string, unknown> | null | undefined): string {
  if (!dropInfo) return "（无）";
  const display = (dropInfo["displayRewards"] ?? []) as Record<string, unknown>[];
  if (!Array.isArray(display) || display.length === 0) return "（无）";
  const parts = display.map((d) => {
    const itemId = String(d["id"] ?? "");
    const itemName = itemId ? getItemNameById(itemId) : null;
    let name = String(itemName ?? d["type"] ?? d["dropType"] ?? itemId ?? "?");
    if (itemId && itemName) name = `${name}（${itemId}）`;
    else if (itemId && name !== itemId) name = `${name}（${itemId}）`;
    const count = (d["count"] as number) ?? 1;
    const dropType = d["dropType"] ? ` [${String(d["dropType"])}]` : "";
    return `- ${name} ×${count}${dropType}`;
  });
  return parts.length > 0 ? parts.join("\n") : "（无）";
}

// ---------------------------------------------------------------------------
// Lazy loaders
// ---------------------------------------------------------------------------

function getStageTable(): StageTable {
  checkActivationChange();
  stageTableMetrics.access(_stageTable !== null);
  if (_stageTable === null) {
    const cfg = loadConfig();
    if (!cfg.effectiveExcelPath) {
      throw new Error("关卡数据暂不可用。请检查 GAMEDATA_PATH 配置。");
    }
    const store = new DirectoryStore(cfg.effectiveExcelPath);
    if (!store.exists(STAGE_FILE)) {
      throw new Error(`关卡数据文件不存在：${STAGE_FILE}`);
    }
    const raw = store.readJson<{ stages?: StageTable }>(STAGE_FILE);
    if (!raw || typeof raw !== "object" || !raw.stages || typeof raw.stages !== "object") {
      throw new Error(`${STAGE_FILE} 格式异常`);
    }
    _stageTable = raw.stages;
  }
  return _stageTable;
}

function getZoneTable(): ZoneTable | null {
  checkActivationChange();
  zoneTableMetrics.access(_zoneTable !== null || _zoneTableFailed);
  if (_zoneTable === null && !_zoneTableFailed) {
    const cfg = loadConfig();
    if (!cfg.effectiveExcelPath) {
      _zoneTableFailed = true;
      return null;
    }
    const store = new DirectoryStore(cfg.effectiveExcelPath);
    if (!store.exists(ZONE_FILE)) {
      _zoneTableFailed = true;
      return null;
    }
    const raw = store.readJson<{ zones?: ZoneTable }>(ZONE_FILE);
    if (!raw || typeof raw !== "object" || !raw.zones || typeof raw.zones !== "object") {
      _zoneTableFailed = true;
      return null;
    }
    _zoneTable = raw.zones;
  }
  return _zoneTable;
}

function zoneDisplay(zoneId: string): string {
  const zones = getZoneTable();
  if (!zones) return zoneId;
  const z = zones[zoneId];
  if (!z) return zoneId;
  const first = z.zoneNameFirst || "";
  const second = z.zoneNameSecond || "";
  if (first && second) return `${first}-${second}`;
  if (first) return first;
  return zoneId;
}

function missingDataMessage(): string {
  return (
    "关卡数据暂不可用。请检查 GAMEDATA_PATH 配置，" +
    "或等待服务器自动从 GitHub Release 同步数据完成后重试。"
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listStages(
  chapter?: string | null,
  type?: string | null,
  limit: number = 50,
  offset: number = 0,
): string {
  const data = buildStagesListing(chapter, type, limit, offset);
  if (typeof data === "string") return data;
  return renderStagesListing(data);
}

export function buildStagesListing(
  chapter?: string | null,
  type?: string | null,
  limit: number = 50,
  offset: number = 0,
): StagesListingPayload | string {
  if (limit < 1) return "limit 必须 >= 1。";
  if (limit > 200) return "limit 必须 <= 200。";
  if (offset < 0) return "offset 必须 >= 0。";
  if (type != null && !(type.toUpperCase() in STAGE_TYPE_LABELS)) {
    const allowed = Object.keys(STAGE_TYPE_LABELS).join("、");
    return `无效的 type：${JSON.stringify(type)}。可选值：${allowed}。`;
  }

  let stages: StageTable;
  try {
    stages = getStageTable();
  } catch (e) {
    return missingDataMessage() + `（${e instanceof Error ? e.message : String(e)}）`;
  }

  const filtered: StageEntry[] = [];
  for (const [, entry] of Object.entries(stages).sort(([a], [b]) => a.localeCompare(b))) {
    if (chapter != null && entry.zoneId !== chapter) continue;
    if (type != null && entry.stageType !== type.toUpperCase()) continue;
    filtered.push(entry);
  }

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  const entries: StageListingEntry[] = page.map((e) => {
    const typeRaw = e.stageType ?? "";
    const zoneId = e.zoneId ?? "";
    return {
      stage_id: e.stageId ?? "",
      name: e.name || "（无名）",
      code: e.code || "?",
      type: typeRaw,
      type_label: stageTypeLabel(typeRaw),
      difficulty_label: difficultyLabel(e.difficulty ?? ""),
      zone_id: zoneId,
      zone_display: zoneDisplay(zoneId),
    };
  });

  return {
    total,
    offset,
    limit,
    filters: {
      chapter: chapter ?? null,
      type: type ? type.toUpperCase() : null,
    },
    stages: entries,
  };
}

export function renderStagesListing(data: StagesListingPayload): string {
  if (data.stages.length === 0) {
    if (data.total === 0) {
      const filters: string[] = [];
      if (data.filters.chapter) filters.push(`zoneId=${data.filters.chapter}`);
      if (data.filters.type) filters.push(`stageType=${data.filters.type}`);
      return `没有匹配的关卡（filter: ${filters.join(", ") || "none"}）。`;
    }
    return `offset ${data.offset} 超出范围（共 ${data.total} 条）。`;
  }

  const lines = [`# 关卡列表（共 ${data.total} 个）`];
  for (const s of data.stages) {
    lines.push(
      `- **${s.name}** [${s.type_label}] ${s.code} — ` +
      `${s.difficulty_label} — ${s.zone_display}（id: ${s.stage_id}）`,
    );
  }

  const { offset, limit, total } = data;
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  lines.push(
    `\n（显示第 ${start}–${end} 条，共 ${total} 条。` +
    `使用 offset=${offset + limit} 查看下一页）`,
  );
  return lines.join("\n");
}

export function getStageInfo(stageId: string): string {
  const data = buildStageInfo(stageId);
  if (typeof data === "string") return data;
  return renderStageInfo(data);
}

export function buildStageInfo(stageId: string): StageInfoPayload | string {
  let stages: StageTable;
  try {
    stages = getStageTable();
  } catch (e) {
    return missingDataMessage() + `（${e instanceof Error ? e.message : String(e)}）`;
  }

  const entry = stages[stageId];
  if (!entry) return `未找到关卡：${JSON.stringify(stageId)}。`;

  const name = entry.name || "（无名）";
  const code = entry.code || "?";
  const tLabel = stageTypeLabel(entry.stageType ?? "");
  const dLabel = difficultyLabel(entry.difficulty ?? "");
  const zd = zoneDisplay(entry.zoneId ?? "");
  const ap = entry.apCost ?? "?";
  const danger = entry.dangerLevel || "?";
  const boss = entry.bossMark === true;
  const rawDesc = entry.description || "";
  const desc = cleanDescription(rawDesc) || "（无描述）";
  const drops = entry.stageDropInfo as Record<string, unknown> | null | undefined;
  const unlocks = Array.isArray(entry.unlockCondition) ? entry.unlockCondition : [];
  const hardId = entry.hardStagedId;
  const levelId = entry.levelId;
  const sixStarId = entry.sixStarStageId;
  const hardEntry = hardId ? stages[hardId] : undefined;
  const sixStarEntry = sixStarId ? stages[sixStarId] : undefined;

  return {
    stage_id: stageId,
    name,
    code,
    type_raw: entry.stageType ?? "",
    type_label: tLabel,
    difficulty_raw: entry.difficulty ?? "",
    difficulty_label: dLabel,
    zone_id: entry.zoneId ?? "",
    zone_display: zd,
    ap_cost: ap,
    danger_level: danger,
    boss_mark: boss,
    description: desc,
    drop_info: drops ?? null,
    unlock_conditions: unlocks,
    level_id: levelId ?? null,
    hard_stage: { id: hardId ?? null, name: hardEntry?.name ?? null },
    six_star_stage: { id: sixStarId ?? null, name: sixStarEntry?.name ?? null },
  };
}

export function renderStageInfo(data: StageInfoPayload): string {
  const parts: string[] = [`# ${data.name} — 关卡详情`, "", "## 基本信息"];
  parts.push(`- **ID**：${data.stage_id}`);
  parts.push(`- **编号**：${data.code}`);
  parts.push(`- **类型**：${data.type_label}`);
  parts.push(`- **难度**：${data.difficulty_label}`);
  parts.push(`- **所属区域**：${data.zone_display}`);
  parts.push(`- **理智消耗**：${data.ap_cost}`);
  parts.push(`- **危险等级**：${data.danger_level}`);
  if (data.boss_mark) parts.push("- **BOSS标记**：是");
  if (data.level_id) parts.push(`- **关卡数据**：${data.level_id}`);

  parts.push("", "## 描述", data.description);
  parts.push("", "## 掉落信息", formatDrops(data.drop_info));
  parts.push("", "## 解锁条件", formatUnlock(data.unlock_conditions));

  parts.push("", "## 关联关卡");
  if (data.hard_stage.id) {
    parts.push(
      `- 突袭模式：${data.hard_stage.id}` +
      (data.hard_stage.name ? `（${data.hard_stage.name}）` : ""),
    );
  } else {
    parts.push("- 突袭模式：无");
  }
  if (data.six_star_stage.id) {
    parts.push(
      `- 六星模式：${data.six_star_stage.id}` +
      (data.six_star_stage.name ? `（${data.six_star_stage.name}）` : ""),
    );
  }

  return parts.join("\n");
}

export function searchStages(pattern: string, maxResults: number = 30): string {
  const data = buildStageSearch(pattern, maxResults);
  if (typeof data === "string") return data;
  return renderStageSearch(data);
}

export function buildStageSearch(pattern: string, maxResults: number = 30): StageSearchPayload | string {
  if (maxResults < 1) return "max_results 必须 >= 1。";
  if (maxResults > 100) return "max_results 必须 <= 100。";

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "iu");
  } catch (e) {
    return `正则表达式无效：${e instanceof Error ? e.message : String(e)}`;
  }

  let records: StageSearchRecord[];
  try {
    records = getStageSearchRecords();
  } catch (e) {
    return missingDataMessage() + `（${e instanceof Error ? e.message : String(e)}）`;
  }

  const matched: StageSearchRecord[] = [];
  for (const record of records) {
    if (regex.test(record.searchText)) {
      matched.push(record);
      if (matched.length >= maxResults) break;
    }
  }

  return {
    scope: "stages",
    pattern,
    total: matched.length,
    results: matched.map(stageSearchEntry),
  };
}

export function renderStageSearch(data: StageSearchPayload): string {
  const { pattern, results } = data;
  if (results.length === 0) return `未找到匹配 '${pattern}' 的关卡。`;

  const lines = [`# 搜索结果：${pattern}（共 ${data.total} 个）`];
  for (const entry of results) {
    lines.push(`\n## ${entry.name} [${entry.type_label}] ${entry.code}（id: ${entry.stage_id}）`);
    lines.push(`- **区域**：${entry.zone_display}`);
    lines.push(`- **难度**：${entry.difficulty_label}`);
    lines.push(`- **理智**：${entry.ap}`);
    if (entry.description) {
      lines.push(
        `- **描述**：${entry.description.slice(0, 120)}${entry.description.length > 120 ? "..." : ""}`,
      );
    }
  }

  return lines.join("\n");
}

function stageSearchEntry(record: StageSearchRecord): StageSearchPayload["results"][number] {
  const e = record.entry;
  const typeRaw = e.stageType ?? "";
  const difficultyRaw = e.difficulty ?? "";
  const zoneId = e.zoneId ?? "";
  const ap = e.apCost;
  return {
    stage_id: record.stageId,
    name: e.name || "（无名）",
    code: e.code || "?",
    type: typeRaw,
    type_label: stageTypeLabel(typeRaw),
    difficulty: difficultyRaw,
    difficulty_label: difficultyLabel(difficultyRaw),
    zone_id: zoneId,
    zone_display: zoneDisplay(zoneId),
    ap: ap ?? "?",
    description: cleanDescription(e.description ?? ""),
  };
}

function getStageSearchRecords(): StageSearchRecord[] {
  checkActivationChange();
  stageSearchRecordsMetrics.access(_stageSearchRecords !== null);
  if (_stageSearchRecords !== null) return _stageSearchRecords;
  _stageSearchRecords = Object.entries(getStageTable())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stageId, entry]) => ({
      stageId,
      entry,
      searchText: [
        entry.name ?? "",
        entry.code ?? "",
        cleanDescription(entry.description ?? ""),
        entry.stageType ?? "",
        stageId,
      ].join(" "),
    }));
  return _stageSearchRecords;
}
