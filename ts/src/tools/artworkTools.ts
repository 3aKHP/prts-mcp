/**
 * Operator artwork (立绘) tool — registration and local/MediaWiki dispatch.
 * Mirrors python/src/prts_mcp/tools_artwork.py.
 *
 * The data-source backends live in data/artworkLocal.ts and
 * data/artworkMediawiki.ts; they return string messages or
 * artworkFormat outcome objects, and this module owns the output-channel
 * wrapping and the images-generation resolution (the only sync-tier touch).
 *
 * Consumes AKDP image assets synced in LOCAL_IMAGE=true mode. Registered
 * only when IMAGES_ENABLED=true (see server-core.ts).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { withActivationSnapshot } from "../activation.js";
import { loadConfig, type Config } from "../config.js";
import { activeGenerationSync } from "../data/imagesSync.js";
import {
  getArtworkLocal,
  listArtworksLocal,
} from "../data/artworkLocal.js";
import {
  getArtworkMediawiki,
  listArtworksMediawiki,
} from "../data/artworkMediawiki.js";
import type { VariantName } from "../data/images.js";
import { renderImageResult, renderResult, textResult, type OutputChannel } from "../output.js";
import { registerTool } from "./registerTool.js";

// ---------------------------------------------------------------------------
// MediaWiki dispatch (LOCAL_IMAGE=false — PRTS is the source of truth, not a
// local generation that can swap mid-call, hence no activation snapshot)
// ---------------------------------------------------------------------------

async function doListMediawiki(
  operatorName: string,
  channel: OutputChannel,
): Promise<ReturnType<typeof renderResult>> {
  const outcome = await listArtworksMediawiki(operatorName);
  if (typeof outcome === "string") return textResult(outcome);
  return renderResult(outcome.data, outcome.markdown, channel, outcome.summary);
}

async function doGetMediawiki(
  operatorName: string,
  artworkId: string | undefined,
  variant: VariantName | undefined,
  channel: OutputChannel,
  cfg: Config,
): Promise<ReturnType<typeof renderImageResult>> {
  const outcome = await getArtworkMediawiki(operatorName, artworkId, variant, cfg);
  if (typeof outcome === "string") return textResult(outcome);
  return renderImageResult(
    outcome.markdown, outcome.imageB64, outcome.mime, outcome.data, channel, outcome.summary,
  );
}

// ---------------------------------------------------------------------------
// Local dispatch (runs inside withActivationSnapshot)
// ---------------------------------------------------------------------------

function doList(operatorName: string, channel: OutputChannel): ReturnType<typeof renderResult> {
  const cfg = loadConfig();
  const genDir = activeGenerationSync(cfg.imagesPath);
  const outcome = listArtworksLocal(operatorName, genDir);
  if (typeof outcome === "string") return textResult(outcome);
  return renderResult(outcome.data, outcome.markdown, channel, outcome.summary);
}

function doGet(
  operatorName: string,
  artworkId: string | undefined,
  variant: VariantName | undefined,
  channel: OutputChannel,
): ReturnType<typeof renderImageResult> {
  if (!artworkId) {
    return textResult("action=get 时必须提供 artwork_id。请先用 action=list 获取。");
  }
  const cfg = loadConfig();
  const genDir = activeGenerationSync(cfg.imagesPath);
  const outcome = getArtworkLocal(operatorName, artworkId, variant, genDir);
  if (typeof outcome === "string") return textResult(outcome);
  return renderImageResult(
    outcome.markdown, outcome.imageB64, outcome.mime, outcome.data, channel, outcome.summary,
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerArtworkTools(
  server: McpServer,
  channel: OutputChannel = "content",
): void {
  registerTool(server,
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
    async ({ operator_name, action, artwork_id, variant }) => {
      const cfg = loadConfig();
      if (!cfg.localImage) {
        // LOCAL_IMAGE=false: MediaWiki path, no activation snapshot (PRTS is
        // the source of truth, not a local generation that can swap mid-call).
        if (action === "list") return doListMediawiki(operator_name, channel);
        return doGetMediawiki(operator_name, artwork_id, variant, channel, cfg);
      }
      return withActivationSnapshot(() => {
        if (action === "list") return doList(operator_name, channel);
        return doGet(operator_name, artwork_id, variant, channel);
      });
    },
  );
}
