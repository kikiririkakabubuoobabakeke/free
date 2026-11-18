import { describe, expect, it } from "vitest";
import { TAG_COLORS, tagColor } from "../src/db/types";

describe("タグの色", () => {
  it("今の色はそのまま", () => {
    for (const c of TAG_COLORS) expect(tagColor(c)).toBe(c);
    expect(tagColor(TAG_COLORS[0].toUpperCase())).toBe(TAG_COLORS[0]);
  });

  it("以前の版の色は、同じ並びのパステルで見せる", () => {
    expect(tagColor("#c2553f")).toBe(TAG_COLORS[0]); // 赤 → 赤
    expect(tagColor("#3b74c4")).toBe(TAG_COLORS[4]); // 青 → 青
    expect(tagColor("#1c1c1c")).toBe(TAG_COLORS[0]); // モノトーンの版の濃淡 → 並び順
    expect(tagColor("#c1c1c1")).toBe(TAG_COLORS[5]);
  });

  it("知らない色は灰色", () => {
    expect(tagColor("")).toBe(TAG_COLORS[TAG_COLORS.length - 1]);
    expect(tagColor("#123456")).toBe(TAG_COLORS[TAG_COLORS.length - 1]);
  });
});
