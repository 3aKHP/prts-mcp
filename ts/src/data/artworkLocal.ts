/**
 * Local AKDP-backed artwork backend (LOCAL_IMAGE=true).
 * Mirrors python/src/prts_mcp/data/artwork_local.py.
 *
 * Reads the synced images generation directory (index.json + PNG files) and
 * owns artwork-specific char-id resolution (the Amiya form aliases). Stays
 * free of sync/api/output imports: the generation directory is resolved by
 * the tool layer and passed in, and results are returned as string messages
 * or ListOutcome / GetOutcome for the tool layer to wrap.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute, resolve, sep } from "node:path";
import { resolveCharId } from "./operator.js";
import {
  buildArtworkLabel,
  getCharSkins,
  parseIndex,
  DEFAULT_VARIANT,
  VARIANT_ORDER,
  type ArtworkEntry,
  type ImagesIndex,
  type VariantName,
} from "./images.js";
import { compareIds } from "./sort.js";
import {
  normalizedArtworkFormName,
  renderList,
  type ArtworkListItem,
  type GetOutcome,
  type ListOutcome,
} from "./artworkFormat.js";

// These IDs represent forms that deliberately share the base character's
// display name in the game table. Keep this resolver local to artwork: other
// operator tools must retain their ordinary exact-name lookup contract.
export const ARTWORK_FORM_CHAR_IDS: Readonly<Record<string, string>> = {
  "阿米娅(近卫)": "char_1001_amiya2",
  "阿米娅(医疗)": "char_1037_amiya3",
};

export function resolveArtworkCharId(operatorName: string): string | null {
  return ARTWORK_FORM_CHAR_IDS[normalizedArtworkFormName(operatorName)] ?? resolveCharId(operatorName);
}

export function charIdOf(skinId: string): string {
  return skinId.split("#")[0].split("@")[0];
}

function availableVariants(entry: ArtworkEntry): VariantName[] {
  return VARIANT_ORDER.filter((v) => entry.variants[v] !== undefined);
}

export function dataNotReadyMessage(): string {
  return (
    "立绘数据未就绪。可能原因：IMAGES_ENABLED 未开启，或图片同步仍在进行中。" +
    "请稍后重试；若持续不可用，请检查网络或 GITHUB_TOKEN。"
  );
}

export function loadIndex(genDir: string): ImagesIndex | null {
  try {
    return parseIndex(JSON.parse(readFileSync(join(genDir, "index.json"), "utf-8")));
  } catch {
    return null;
  }
}

/** Coerce a displaySkin text field to a non-empty string or null. */
function displayText(
  display: { skinGroupName?: unknown; obtainApproach?: unknown; description?: unknown } | undefined,
  field: "skinGroupName" | "obtainApproach" | "description",
): string | null {
  const value = display?.[field];
  return typeof value === "string" && value ? value : null;
}

export function listArtworksLocal(
  operatorName: string,
  genDir: string | null,
): ListOutcome | string {
  let charId: string | null;
  try {
    charId = resolveArtworkCharId(operatorName);
  } catch {
    // gamedata not synced yet (effectiveExcelPath null or table missing).
    return dataNotReadyMessage();
  }
  if (charId === null) {
    return `找不到干员「${operatorName}」。建议先用 search_prts 确认准确的中文名称。`;
  }
  if (genDir === null) return dataNotReadyMessage();
  const index = loadIndex(genDir);
  if (index === null) return dataNotReadyMessage();

  const matched = Object.entries(index.artworks)
    .filter(([sid]) => charIdOf(sid) === charId)
    .sort(([a], [b]) => compareIds(a, b));
  if (matched.length === 0) {
    return `未找到「${operatorName}」的立绘数据。`;
  }

  const charSkins = getCharSkins();
  const artworks = matched.map(([sid, entry]): ArtworkListItem => {
    const variants: Record<string, { width: number; height: number; bytes: number }> = {};
    for (const v of availableVariants(entry)) {
      const vm = entry.variants[v]!;
      variants[v] = { width: vm.width, height: vm.height, bytes: vm.bytes };
    }
    const display = charSkins[sid]?.displaySkin;
    return {
      artwork_id: sid,
      label: buildArtworkLabel(sid, charSkins),
      kind: entry.kind,
      variants,
      // Bounded skin metadata from skin_table.json's displaySkin
      // (ROADMAP 2.7.0). Absent for base illusts without entries.
      skin_group: displayText(display, "skinGroupName"),
      acquisition: displayText(display, "obtainApproach"),
      description: displayText(display, "description"),
    };
  });

  const data = {
    operator_name: operatorName,
    char_id: charId,
    total: artworks.length,
    artworks,
  };
  const markdown = renderList(operatorName, artworks);
  return {
    data,
    markdown,
    summary: `「${operatorName}」共 ${artworks.length} 张立绘，详见 structuredContent`,
  };
}

export function getArtworkLocal(
  operatorName: string,
  artworkId: string,
  variant: VariantName | undefined,
  genDir: string | null,
): GetOutcome | string {
  const chosen: VariantName = variant ?? DEFAULT_VARIANT;
  if (genDir === null) return dataNotReadyMessage();
  const index = loadIndex(genDir);
  if (index === null) return dataNotReadyMessage();

  const entry = index.artworks[artworkId];
  if (entry === undefined) {
    return `找不到 artwork_id「${artworkId}」。该 ID 不透明，请用 action=list 重新获取。`;
  }
  let charId: string | null;
  try {
    charId = resolveArtworkCharId(operatorName);
  } catch {
    return dataNotReadyMessage();
  }
  if (charId === null) {
    return `找不到干员「${operatorName}」。建议先用 search_prts 确认准确的中文名称。`;
  }
  if (charIdOf(artworkId) !== charId) {
    return (
      `该 artwork_id 不属于干员「${operatorName}」。artwork_id 为不透明 token，请用 action=list 重新获取。`
    );
  }
  const variantMeta = entry.variants[chosen];
  if (variantMeta === undefined) {
    const available = availableVariants(entry).join("、") || "无";
    return `artwork_id「${artworkId}」不提供「${chosen}」变体（可用：${available}）。`;
  }
  // The file field comes from the network-downloaded index; contain it to
  // the generation dir so a malformed upstream cannot read an arbitrary host
  // file and exfiltrate it base64-encoded. Lexical containment alone is not
  // enough — a symlink inside the generation dir could point outside and be
  // followed by readFileSync — so both paths are realpath-resolved before
  // the check. Existence/stat/read operate on the resolved path — the same
  // one the containment check verified — so a symlink swap between check and
  // read cannot divert the read.
  const pngPath = resolve(genDir, variantMeta.file);
  let pngReal: string | null = null;
  let contained = false;
  try {
    const genReal = realpathSync(genDir);
    pngReal = realpathSync(pngPath);
    const relCheck = relative(genReal, pngReal);
    contained = relCheck !== ".." && !relCheck.startsWith(`..${sep}`) && !isAbsolute(relCheck);
  } catch {
    contained = false;
  }
  if (
    !contained
    || pngReal === null
    || !existsSync(pngReal)
    || !statSync(pngReal).isFile()
  ) {
    return `图片文件缺失：${variantMeta.file}。同步可能不完整，请稍后重试。`;
  }
  let imageBytes: Buffer;
  try {
    imageBytes = readFileSync(pngReal);
  } catch (err) {
    return `读取图片文件失败：${err instanceof Error ? err.message : String(err)}`;
  }

  const imageBase64 = imageBytes.toString("base64");
  const charSkins = getCharSkins();
  const label = buildArtworkLabel(artworkId, charSkins);
  const markdown =
    `**${label}**（${operatorName}）\n` +
    `变体：${chosen}｜尺寸：${variantMeta.width}×${variantMeta.height}` +
    `｜${variantMeta.bytes} bytes\n` +
    `artwork_id：\`${artworkId}\``;
  const data = {
    operator_name: operatorName,
    artwork_id: artworkId,
    label,
    variant: chosen,
    width: variantMeta.width,
    height: variantMeta.height,
    bytes: variantMeta.bytes,
    sha256: variantMeta.sha256,
  };
  return {
    markdown,
    imageB64: imageBase64,
    mime: "image/png",
    data,
    summary: `${operatorName} 的「${label}」（${chosen}）`,
  };
}
