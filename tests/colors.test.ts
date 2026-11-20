import { describe, expect, it } from "vitest";
import { TAG_COLORS, tagColor } from "../src/db/types";

const gray = (c: string) => /^#([0-9a-f]{2})\1\1$/.test(c);

describe("タグの色", () => {
  it("今の色はモノトーンの濃淡だけで、濃い順に並ぶ", () => {
    expect(TAG_COLORS.every(gray)).toBe(true);
    const levels = TAG_COLORS.map((c) => parseInt(c.slice(1, 3), 16));
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
    expect(new Set(TAG_COLORS).size).toBe(TAG_COLORS.length);
  });

  it("今の色はそのまま", () => {
    for (const c of TAG_COLORS) expect(tagColor(c)).toBe(c);
    expect(tagColor(TAG_COLORS[0].toUpperCase())).toBe(TAG_COLORS[0]);
  });

  it("パステルの版の色は、同じ並びの濃淡で見せる（違う色が同じ濃淡にならない）", () => {
    const pastel = ["#e88a8f", "#f0b37a", "#a5cf8f", "#86cbbf", "#8eb6e6", "#b3a1e3", "#eaa0c8", "#b8b0b4"];
    expect(pastel.map(tagColor)).toEqual(TAG_COLORS);
  });

  it("最初の版の色も、同じ並びの濃淡で見せる", () => {
    expect(tagColor("#c2553f")).toBe(TAG_COLORS[0]); // 赤
    expect(tagColor("#3b74c4")).toBe(TAG_COLORS[4]); // 青
    expect(tagColor("#8a8f98")).toBe(TAG_COLORS[7]); // 灰
  });

  it("前のモノトーンの版（6段）は、濃い端・淡い端をそろえて割り当てる", () => {
    expect(tagColor("#1c1c1c")).toBe(TAG_COLORS[0]);
    expect(tagColor("#c1c1c1")).toBe(TAG_COLORS[TAG_COLORS.length - 1]);
    const six = ["#1c1c1c", "#3d3d3d", "#5e5e5e", "#7f7f7f", "#a0a0a0", "#c1c1c1"].map(tagColor);
    expect(new Set(six).size).toBe(6);
  });

  it("知らない色は、いちばん淡い灰色", () => {
    expect(tagColor("")).toBe(TAG_COLORS[TAG_COLORS.length - 1]);
    expect(tagColor("#123456")).toBe(TAG_COLORS[TAG_COLORS.length - 1]);
  });
});
