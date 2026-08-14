/**
 * Artwork result shapes and the shared markdown list renderer.
 * Mirrors python/src/prts_mcp/data/artwork_format.py.
 *
 * Both artwork backends (data/artworkLocal.ts and data/artworkMediawiki.ts)
 * return either a plain string (content-only message) or one of the outcome
 * interfaces defined here; the tool layer (tools/artworkTools.ts) owns the
 * output-channel wrapping, so data modules never import output.js.
 */

export interface ArtworkListItem {
  artwork_id: string;
  label: string;
  kind: string;
  variants: Record<string, unknown>;
}

/** A successful list action: structured payload + markdown + summary. */
export interface ListOutcome {
  data: Record<string, unknown>;
  markdown: string;
  summary: string;
}

/** A successful get action: image bytes (base64) + metadata payload. */
export interface GetOutcome {
  markdown: string;
  imageB64: string;
  mime: string;
  data: Record<string, unknown>;
  summary: string;
}

export function normalizedArtworkFormName(operatorName: string): string {
  return operatorName.trim().replaceAll("（", "(").replaceAll("）", ")");
}

/** Render the shared artwork list markdown (used by both backends). */
export function renderList(operatorName: string, artworks: ArtworkListItem[]): string {
  const header = `# 「${operatorName}」的立绘（共 ${artworks.length} 张）\n`;
  const lines = artworks.map((art) => {
    const variants = Object.keys(art.variants).join("/");
    return `- **${art.label}**｜\`${art.artwork_id}\`｜变体：${variants}`;
  });
  return header + lines.join("\n");
}
