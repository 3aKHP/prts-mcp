/**
 * Wikitext sanitiser — strips markup and returns plain text.
 * Mirrors python/src/prts_mcp/utils/sanitizer.py exactly.
 */

/** Remove common wikitext markup and return plain text. */
export function stripWikitext(text: string): string {
  // Remove {{template}} blocks (non-greedy, single-level)
  text = text.replace(/\{\{[^}]*\}\}/g, "");
  // Remove [[File:...]] / [[文件:...]] image links
  text = text.replace(/\[\[(File|文件|Image|图像):[^\]]*\]\]/g, "");
  // Convert [[link|display]] -> display, [[link]] -> link
  text = text.replace(/\[\[[^|\]]*\|([^\]]+)\]\]/g, "$1");
  text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, "");
  // Remove category links
  text = text.replace(/\[\[(Category|分类):[^\]]*\]\]/g, "");
  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
