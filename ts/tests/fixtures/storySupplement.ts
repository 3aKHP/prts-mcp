/** Shared roguelike story supplement fixture payload.
 *
 * Mirrors python/tests/fixtures.py story_supplement_files(): the catalog
 * plus its two chapter JSONs. Used by both storySupplement.test.ts and
 * storyOutputChannel.test.ts so the two suites cannot drift apart.
 */

import { STORY_SUPPLEMENT } from "../../src/data/storyReader.ts";

export const STORY_SUPPLEMENT_PATH = STORY_SUPPLEMENT;
export const ROGUE_ENDING_KEY = "Obt/Roguelike/RO6/level_rogue6_ending_1";
export const ROGUE_MONTH_KEY = "Obt/Rogue/rogue_6/MonthRecord/month_record_rogue_6_4_1";

export function storySupplementFiles(): Record<string, unknown> {
  return {
    [STORY_SUPPLEMENT_PATH]: {
      version: 1,
      generated_from: {
        tables: ["gamedata/excel/roguelike_topic_table.json"],
        source_version: "v-test",
      },
      events: [
        {
          event_id: "rogue_6",
          name: "沉沦者的黑流树海",
          entry_type: "ROGUELIKE",
          sort: 6,
          chapters: [
            {
              key: ROGUE_ENDING_KEY, name: "强制重启", code: "RO6-E1",
              avg_tag: "结局", sort: 110, group: "ending",
              source: "topic:endbook.avgId",
            },
            {
              key: ROGUE_MONTH_KEY, name: "南方往事·1", code: "RO6-M4-1",
              avg_tag: "月度记录·南方往事", sort: 10401, group: "month",
              source: "topic:chat.chatStoryId",
            },
          ],
        },
      ],
    },
    [`zh_CN/gamedata/story/${ROGUE_ENDING_KEY}.json`]: {
      storyCode: "RO6-E1",
      storyName: "强制重启",
      avgTag: "结局",
      eventName: "沉沦者的黑流树海",
      storyInfo: "官方梗概：强制重启。",
      storyList: [
        { prop: "name", attributes: { name: "卡德霍", content: "落幕。" } },
      ],
    },
    [`zh_CN/gamedata/story/${ROGUE_MONTH_KEY}.json`]: {
      storyCode: "RO6-M4-1",
      storyName: "南方往事·1",
      avgTag: "月度记录·南方往事",
      eventName: "沉沦者的黑流树海",
      storyInfo: "",
      storyList: [
        { prop: "name", attributes: { name: "", content: "独特旁白词项xyz。" } },
        { prop: "name", attributes: { name: "帕尤卡卡", content: "蛋糕烤好了。" } },
      ],
    },
  };
}
