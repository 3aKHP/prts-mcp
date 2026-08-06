/**
 * Operator artwork (立绘) tool — list illusts/skins and get image variants.
 * Mirrors python/src/prts_mcp/tools_artwork.py.
 *
 * Consumes AKDP image assets synced in LOCAL_IMAGE=true mode. Registered
 * only when IMAGES_ENABLED=true (see server.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { loadConfig, withActivationSnapshot } from "../config.js";
import {
  buildArtworkLabel,
  getCharSkins,
  parseIndex,
  DEFAULT_VARIANT,
  VARIANT_ORDER,
  type ArtworkEntry,
  type ImagesIndex,
  type VariantName,
} from "../data/images.js";
import { activeGenerationSync } from "../data/imagesSync.js";
import { resolveCharId } from "../data/operator.js";
import { renderImageResult, renderResult, textResult, type OutputChannel } from "../output.js";

// ---------------------------------------------------------------------------
// Synchronous data access (runs inside withActivationSnapshot)
// ---------------------------------------------------------------------------

function loadIndexSync(genDir: string): ImagesIndex | null {
  try {
    return parseIndex(JSON.parse(readFileSync(join(genDir, "index.json"), "utf-8")));
  } catch {
    return null;
  }
}

function charIdOf(skinId: string): string {
  return skinId.split("#")[0].split("@")[0];
}

function availableVariants(entry: ArtworkEntry): VariantName[] {
  return VARIANT_ORDER.filter((v) => entry.variants[v] !== undefined);
}

function dataNotReady(): CallToolResult {
  return textResult(
    "立绘数据未就绪。可能原因：IMAGES_ENABLED 未开启，或图片同步仍在进行中。" +
      "请稍后重试；若持续不可用，请检查网络或 GITHUB_TOKEN。",
  );
}

// ---------------------------------------------------------------------------
// Tool actions
// ---------------------------------------------------------------------------

function doList(operatorName: string, channel: OutputChannel): CallToolResult {
  let charId: string | null;
  try {
    charId = resolveCharId(operatorName);
  } catch {
    // gamedata not synced yet (effectiveExcelPath null or table missing).
    return dataNotReady();
  }
  if (charId === null) {
    return textResult(
      `找不到干员「${operatorName}」。建议先用 search_prts 确认准确的中文名称。`,
    );
  }
  const cfg = loadConfig();
  const genDir = activeGenerationSync(cfg.imagesPath);
  if (genDir === null) return dataNotReady();
  const index = loadIndexSync(genDir);
  if (index === null) return dataNotReady();

  const matched = Object.entries(index.artworks)
    .filter(([sid]) => charIdOf(sid) === charId)
    .sort(([a], [b]) => a.localeCompare(b));
  if (matched.length === 0) {
    return textResult(`未找到「${operatorName}」的立绘数据。`);
  }

  const charSkins = getCharSkins();
  const artworks = matched.map(([sid, entry]) => {
    const variants: Record<string, { width: number; height: number; bytes: number }> = {};
    for (const v of availableVariants(entry)) {
      const vm = entry.variants[v]!;
      variants[v] = { width: vm.width, height: vm.height, bytes: vm.bytes };
    }
    return {
      artwork_id: sid,
      label: buildArtworkLabel(sid, charSkins),
      kind: entry.kind,
      variants,
    };
  });

  const data = {
    operator_name: operatorName,
    char_id: charId,
    total: artworks.length,
    artworks,
  };
  const markdown = renderList(operatorName, artworks);
  return renderResult(
    data,
    markdown,
    channel,
    `「${operatorName}」共 ${artworks.length} 张立绘，详见 structuredContent`,
  );
}

function doGet(
  operatorName: string,
  artworkId: string | undefined,
  variant: VariantName | undefined,
  channel: OutputChannel,
): CallToolResult {
  if (!artworkId) {
    return textResult("action=get 时必须提供 artwork_id。请先用 action=list 获取。");
  }
  const chosen: VariantName = variant ?? DEFAULT_VARIANT;
  const cfg = loadConfig();
  const genDir = activeGenerationSync(cfg.imagesPath);
  if (genDir === null) return dataNotReady();
  const index = loadIndexSync(genDir);
  if (index === null) return dataNotReady();

  const entry = index.artworks[artworkId];
  if (entry === undefined) {
    return textResult(
      `找不到 artwork_id「${artworkId}」。该 ID 不透明，请用 action=list 重新获取。`,
    );
  }
  const variantMeta = entry.variants[chosen];
  if (variantMeta === undefined) {
    const available = availableVariants(entry).join("、") || "无";
    return textResult(
      `artwork_id「${artworkId}」不提供「${chosen}」变体（可用：${available}）。`,
    );
  }
  // The file field comes from the network-downloaded index; contain it to
  // the generation dir so a malformed upstream cannot read an arbitrary host
  // file and exfiltrate it base64-encoded.
  const pngPath = resolve(genDir, variantMeta.file);
  const relCheck = relative(genDir, pngPath);
  if (
    relCheck === ".."
    || relCheck.startsWith(`..${sep}`)
    || isAbsolute(relCheck)
    || !existsSync(pngPath)
    || !statSync(pngPath).isFile()
  ) {
    return textResult(
      `图片文件缺失：${variantMeta.file}。同步可能不完整，请稍后重试。`,
    );
  }
  let imageBytes: Buffer;
  try {
    imageBytes = readFileSync(pngPath);
  } catch (err) {
    return textResult(
      `读取图片文件失败：${err instanceof Error ? err.message : String(err)}`,
    );
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
  return renderImageResult(
    markdown,
    imageBase64,
    "image/png",
    data,
    channel,
    `${operatorName} 的「${label}」（${chosen}）`,
  );
}

function renderList(
  operatorName: string,
  artworks: Array<{
    artwork_id: string;
    label: string;
    kind: string;
    variants: Record<string, unknown>;
  }>,
): string {
  const header = `# 「${operatorName}」的立绘（共 ${artworks.length} 张）\n`;
  const lines = artworks.map((art) => {
    const variants = Object.keys(art.variants).join("/");
    return `- **${art.label}**｜\`${art.artwork_id}\`｜变体：${variants}`;
  });
  return header + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerArtworkTools(
  server: McpServer,
  channel: OutputChannel = "content",
): void {
  server.tool(
    "operator_artwork",
    [
      "查询干员立绘（精英化立绘、时装等）并获取图片。",
      "先用 action=\"list\" 拿到该干员所有立绘的 artwork_id 与元数据（不返回图片），",
      "再用 action=\"get\" + artwork_id 获取一张图片（base64 编码，默认 large 变体）。",
      "单次 get 最多返回一张图片。",
    ].join(" "),
    {
      operator_name: z.string().describe("干员名称（中文），如「阿米娅」。"),
      action: z
        .enum(["list", "get"])
        .describe(
          "操作（必填）：list=列出该干员所有立绘及 artwork_id；get=按 artwork_id 获取一张图片。",
        ),
      artwork_id: z
        .string()
        .optional()
        .describe(
          "仅 action=get 必填：list 返回的不透明 token，原样回传即可，不可自行构造。",
        ),
      variant: z
        .enum(["original", "large", "preview"])
        .optional()
        .describe(
          "仅 action=get 生效：图片变体。large=max 1024px（默认），preview=max 256px，original=原图（需服务端开启 ORIGINAL_IMAGE 同步）。",
        ),
    },
    ({ operator_name, action, artwork_id, variant }) =>
      withActivationSnapshot(() => {
        if (action === "list") return doList(operator_name, channel);
        return doGet(operator_name, artwork_id, variant, channel);
      }),
  );
}
