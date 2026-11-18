import { describe, expect, it } from "vitest";
import { syncOnce } from "../src/sync/engine";
import { FakeRemote, openTestDb } from "./helpers";

describe("カレンダーの集計", () => {
  it("日ごとに、日記の数と題・本文の文字数（改行を除く）を数える", async () => {
    const { repo } = await openTestDb();
    const a = await repo.createEntry("2026-11-10");
    await repo.updateEntry(a, { title: "散歩", body: "川沿いを\n歩いた。" }); // 2 + 8
    const b = await repo.createEntry("2026-11-10");
    await repo.updateEntry(b, { body: "😀あい" }); // 3
    const c = await repo.createEntry("2026-11-12");
    await repo.updateEntry(c, { body: "x".repeat(1200) });
    await repo.createEntry("2026-10-31"); // 範囲の外

    const stats = await repo.dayStats("2026-11-01", "2026-11-30");
    expect(Object.fromEntries(stats)).toEqual({
      "2026-11-10": { entries: 2, chars: 13 },
      "2026-11-12": { entries: 1, chars: 1200 },
    });
  });

  it("ゴミ箱の中は数えず、元に戻すとまた数える", async () => {
    const { repo } = await openTestDb();
    const a = await repo.createEntry("2026-11-10");
    await repo.updateEntry(a, { body: "あいう" });
    await repo.trashEntry(a);
    expect((await repo.dayStats("2026-11-01", "2026-11-30")).size).toBe(0);
    expect(await repo.entriesOnDay("2026-11-10")).toEqual([]);
    await repo.restoreEntry(a);
    expect((await repo.dayStats("2026-11-01", "2026-11-30")).get("2026-11-10")).toEqual({ entries: 1, chars: 3 });
  });

  it("日付を付けていない日記は、作成した日で数える", async () => {
    const { repo } = await openTestDb();
    const id = await repo.createEntry();
    await repo.updateEntry(id, { body: "今日" });
    const day = (await repo.getEntry(id))!.day;
    expect((await repo.dayStats(day, day)).get(day)).toEqual({ entries: 1, chars: 2 });
    expect((await repo.entriesOnDay(day)).map((e) => e.id)).toEqual([id]);
    expect(await repo.writtenDays()).toEqual([day]);
  });

  it("書いた日の一覧は新しい順で、同じ日は1回だけ", async () => {
    const { repo } = await openTestDb();
    for (const d of ["2026-11-01", "2026-11-03", "2026-11-03", "2026-10-30"]) await repo.createEntry(d);
    expect(await repo.writtenDays()).toEqual(["2026-11-03", "2026-11-01", "2026-10-30"]);
  });
});

describe("予定", () => {
  it("作って、並べて、変えて、消して、戻せる", async () => {
    const { repo } = await openTestDb();
    const lunch = await repo.createPlan("2026-11-20", { time: "12:00", title: "昼食" });
    const allDay = await repo.createPlan("2026-11-20", { title: "締め切り" });
    const morning = await repo.createPlan("2026-11-20", { time: "09:30", title: "歯医者" });
    const later = await repo.createPlan("2026-12-01", { title: "旅行" });
    await repo.createPlan("2026-10-01", { title: "範囲の外" });

    const titles = async () => (await repo.listPlans("2026-11-01", "2026-12-31")).map((p) => p.title);
    expect(await titles()).toEqual(["締め切り", "歯医者", "昼食", "旅行"]); // 日付 → 終日 → 時刻順

    await repo.updatePlan(morning, { done: true, title: "歯医者（済）" });
    await repo.updatePlan(later, { date: "2026-11-19", time: "18:00" });
    const plans = await repo.listPlans("2026-11-01", "2026-12-31");
    expect(plans.map((p) => [p.date, p.time, p.title, p.done])).toEqual([
      ["2026-11-19", "18:00", "旅行", false],
      ["2026-11-20", "", "締め切り", false],
      ["2026-11-20", "09:30", "歯医者（済）", true],
      ["2026-11-20", "12:00", "昼食", false],
    ]);

    await repo.deletePlan(lunch);
    expect(await titles()).not.toContain("昼食");
    await repo.restorePlan(lunch);
    expect(await titles()).toContain("昼食");
    expect(allDay).toBeTruthy();
  });

  it("予定は日記のロックやゴミ箱、日記の数とは関係しない", async () => {
    const { repo } = await openTestDb();
    await repo.createPlan("2026-11-20", { title: "予定" });
    expect((await repo.dayStats("2026-11-01", "2026-11-30")).size).toBe(0);
    expect(await repo.listEntries()).toEqual([]);
  });

  it("予定も他の端末に届く（作る・変える・消す）", async () => {
    const remote = new FakeRemote();
    const pc = await openTestDb();
    const phone = await openTestDb();
    const id = await pc.repo.createPlan("2026-11-20", { time: "10:00", title: "会議" });
    await syncOnce(pc.db, remote);
    await syncOnce(phone.db, remote);
    expect(await phone.repo.listPlans("2026-11-20", "2026-11-20")).toEqual([
      { id, date: "2026-11-20", time: "10:00", title: "会議", done: false },
    ]);
    await phone.repo.updatePlan(id, { done: true });
    await syncOnce(phone.db, remote);
    await syncOnce(pc.db, remote);
    expect((await pc.repo.listPlans("2026-11-20", "2026-11-20"))[0].done).toBe(true);
    await pc.repo.deletePlan(id);
    await syncOnce(pc.db, remote);
    await syncOnce(phone.db, remote);
    expect(await phone.repo.listPlans("2026-11-20", "2026-11-20")).toEqual([]);
  });
});
