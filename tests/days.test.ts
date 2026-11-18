import { describe, expect, it } from "vitest";
import { addDays, level, streak, weekStart } from "../src/ui/days";

describe("日付の計算", () => {
  it("月や年をまたいで足し引きできる", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("夏時間のある時間帯でも、日がずれない", () => {
    const before = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
      expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
      expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    } finally {
      process.env.TZ = before;
    }
  });

  it("週の始まりは日曜日", () => {
    expect(weekStart("2026-11-18")).toBe("2026-11-15"); // 水 → 日
    expect(weekStart("2026-11-15")).toBe("2026-11-15");
    expect(weekStart("2026-11-21")).toBe("2026-11-15"); // 土
    expect(weekStart("2027-01-01")).toBe("2026-12-27");
  });

  it("文字数の濃さは5段階", () => {
    expect([0, 1, 199, 200, 499, 500, 999, 1000, 5000].map(level)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("続けて書いた日数は、今日か昨日から数える", () => {
    expect(streak(["2026-11-18", "2026-11-17", "2026-11-16", "2026-11-14"], "2026-11-18")).toBe(3);
    expect(streak(["2026-11-17", "2026-11-16"], "2026-11-18")).toBe(2); // 今日はまだ書いていない
    expect(streak(["2026-11-16"], "2026-11-18")).toBe(0);
    expect(streak([], "2026-11-18")).toBe(0);
    expect(streak(["2026-11-30", "2026-12-01"], "2026-12-01")).toBe(2);
  });
});
