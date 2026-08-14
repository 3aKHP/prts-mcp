/**
 * Pure parsing of zh_CN-levels per-stage level JSON files.
 *
 * Extracted from data/stageEnemy.ts (P3.A): path derivation, SPAWN action
 * counting, enemyDbRefs keying, and the level-number parse (previously
 * duplicated in stageEnemy.ts and enemyDatabase.ts). Store access stays in
 * data/stageEnemy.ts — this module is pure dict/JSON-shape logic only.
 * Mirrors python/src/prts_mcp/data/level_parser.ts.
 */

export interface SpawnAction {
  actionType?: string | number;
  key?: string;
  count?: number;
}

export interface EnemyRef {
  id?: string;
  level?: number | string;
  overwrittenData?: Record<string, unknown> | null;
}

export interface LevelJson {
  enemyDbRefs?: EnemyRef[];
  waves?: Array<{
    fragments?: Array<{
      actions?: SpawnAction[];
    }>;
  }>;
}

export function levelPath(levelId: string): string {
  return `${levelId.toLowerCase().replace(/\\/g, "/")}.json`;
}

/** Best-effort int conversion for level numbers (bad values → 0). */
export function parseLevel(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** Count SPAWN actions per enemy key across waves→fragments→actions. */
export function spawnCounts(level: LevelJson): Map<string, number> {
  const counts = new Map<string, number>();
  for (const wave of Array.isArray(level.waves) ? level.waves : []) {
    for (const fragment of Array.isArray(wave.fragments) ? wave.fragments : []) {
      for (const action of Array.isArray(fragment.actions) ? fragment.actions : []) {
        if (action.actionType !== "SPAWN" && action.actionType !== 0) continue;
        if (!action.key) continue;
        const rawCount = Number(action.count ?? 1);
        const count = Math.max(Number.isFinite(rawCount) ? Math.trunc(rawCount) : 1, 1);
        counts.set(action.key, (counts.get(action.key) ?? 0) + count);
      }
    }
  }
  return counts;
}

/** Key ``enemyDbRefs`` entries by enemy id. */
export function enemyRefs(level: LevelJson): Map<string, EnemyRef> {
  const refs = new Map<string, EnemyRef>();
  for (const ref of Array.isArray(level.enemyDbRefs) ? level.enemyDbRefs : []) {
    if (ref.id) refs.set(ref.id, ref);
  }
  return refs;
}
