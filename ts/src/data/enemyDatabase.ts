/**
 * Normalize enemy combat databases from supported upstream archive shapes.
 *
 * The legacy archive wraps rows in ``{ enemies: [{ Key, Value }] }`` while
 * AKDP releases the equivalent ``{ enemyId: Value[] }`` mapping directly.
 */

interface EnemyDatabaseValue<T> {
  level?: number | string;
  enemyData?: T;
}

type LegacyEnemyDatabase<T> = {
  enemies?: Array<{ Key?: string; Value?: EnemyDatabaseValue<T>[] }>;
};

function parseLevel(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function addRow<T>(
  index: Record<string, Record<number, T>>,
  enemyId: string,
  values: unknown,
): void {
  if (!Array.isArray(values)) return;
  const levelMap: Record<number, T> = {};
  for (const value of values) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as EnemyDatabaseValue<T>;
    if (row.enemyData && typeof row.enemyData === "object") {
      levelMap[parseLevel(row.level)] = row.enemyData;
    }
  }
  if (Object.keys(levelMap).length > 0) index[enemyId] = levelMap;
}

/** Normalize a supported enemy_database.json payload into an ID/level index. */
export function normalizeEnemyDatabase<T>(raw: unknown): Record<string, Record<number, T>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("enemy_database.json 格式异常：根节点必须是对象。");
  }

  const root = raw as LegacyEnemyDatabase<T> & Record<string, unknown>;
  const index: Record<string, Record<number, T>> = {};
  if (Array.isArray(root.enemies)) {
    for (const row of root.enemies) {
      if (!row?.Key) continue;
      addRow(index, row.Key, row.Value);
    }
    return index;
  }

  for (const [enemyId, values] of Object.entries(root)) {
    addRow(index, enemyId, values);
  }
  if (Object.keys(index).length === 0) {
    throw new Error("enemy_database.json 格式异常：未找到敌人等级数据。");
  }
  return index;
}
