/**
 * Shared user-facing message builders for gamedata data modules.
 *
 * Canonical families so every domain renders missing-data and validation
 * messages identically (the audit found four drifted wording families).
 * Importable without the dataset-access contract — story modules adopt the
 * validation helpers too. Mirrors python/src/prts_mcp/data/messages.py.
 */
import { loadConfig } from "../config.js";

export function excelMissingMessage(label: string): () => string {
  return () => {
    const cfg = loadConfig();
    return (
      `${label}数据暂不可用。容器启动时的 auto-sync 可能仍在进行中，请稍后重试；`
      + "若持续出现此提示，请检查网络连接或提供 GITHUB_TOKEN 以降低限速风险。"
      + `（当前同步目标路径：${cfg.excelPath}）`
    );
  };
}

export function levelsMissingMessage(label: string): () => string {
  return () => {
    const cfg = loadConfig();
    return (
      `${label}数据暂不可用。请等待服务器自动从 GitHub Release 同步 `
      + `zh_CN-levels.zip 完成后重试。（当前同步目标路径：${cfg.levelsPath}）`
    );
  };
}

export function validateBounds(
  name: string,
  value: number,
  opts: { minimum?: number; maximum?: number },
): string | null {
  if (opts.minimum !== undefined && value < opts.minimum) {
    return `${name} 必须 >= ${opts.minimum}。`;
  }
  if (opts.maximum !== undefined && value > opts.maximum) {
    return `${name} 必须 <= ${opts.maximum}。`;
  }
  return null;
}

export function regexErrorMessage(exc: unknown): string {
  return `正则表达式无效：${exc instanceof Error ? exc.message : String(exc)}`;
}
