import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REQUIRED_OPERATOR_FILES = [
  "character_table.json",
  "handbook_info_table.json",
  "charword_table.json",
  "story_review_table.json",
] as const;

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data), "utf-8");
}

export function writeMinimalGamedata(root: string): void {
  const excel = join(root, "zh_CN", "gamedata", "excel");
  mkdirSync(excel, { recursive: true });
  writeJson(join(excel, "character_table.json"), {
    char_002_amiya: {
      name: "阿米娅",
      appellation: "Amiya",
      displayNumber: "R001",
      description: "<@ba.kw>法术伤害</>",
      rarity: "TIER_5",
      profession: "CASTER",
      subProfessionId: "corecaster",
      position: "RANGED",
      nationId: "rhodes",
      groupId: "",
      teamId: "",
      tagList: ["输出", "支援"],
      itemUsage: "罗德岛的公开领袖。",
      itemDesc: "阿米娅的信物。",
      itemObtainApproach: "主线获得",
      talents: [
        {
          candidates: [
            { name: "？？？", description: "" },
            { name: "情绪吸收", description: "攻击回复技力" },
          ],
        },
      ],
    },
  });
  writeJson(join(excel, "handbook_info_table.json"), {
    handbookDict: {
      char_002_amiya: {
        storyTextAudio: [
          {
            storyTitle: "档案资料一",
            stories: [{ storyText: "阿米娅的档案文本。" }],
          },
        ],
      },
    },
  });
  writeJson(join(excel, "charword_table.json"), {
    charWords: {
      amiya_001: {
        charId: "char_002_amiya",
        voiceTitle: "任命助理",
        voiceText: "博士，今天也请多指教。",
      },
    },
  });
  writeJson(join(excel, "story_review_table.json"), {});
}
