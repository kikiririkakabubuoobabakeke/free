import { describe, expect, it } from "vitest";
import { toDateString } from "../src/db/util";
import { openTestDb } from "./helpers";

describe("エントリ", () => {
  it("作って、書いて、一覧に出て、消せる", async () => {
    const { repo } = await openTestDb();
    const id = await repo.createEntry("2026-11-15");
    await repo.updateEntry(id, { title: "初日", body: "今日は日記アプリを作った。" });
    const older = await repo.createEntry("2026-11-01");
    await repo.updateEntry(older, { body: "月初め" });

    const list = await repo.listEntries();
    expect(list.map((e) => e.id)).toEqual([id, older]); // 新しい日付が先
    expect(list[0].title).toBe("初日");

    await repo.deleteEntry(id);
    expect((await repo.listEntries()).map((e) => e.id)).toEqual([older]);
    expect(await repo.getEntry(id)).toBeNull();
  });

  it("本文・題・構造の中身・タグ名で検索できる", async () => {
    const { repo } = await openTestDb();
    const a = await repo.createEntry("2026-11-10");
    await repo.updateEntry(a, { title: "散歩", body: "川沿いを歩いた" });
    const b = await repo.createEntry("2026-11-11");
    await repo.updateEntry(b, { body: "雨で家にいた" });
    const s = await repo.addBlankStructure(b, "読書");
    await repo.updateStructure(s, {
      fields: [{ id: "f1", label: "書名", type: "text" }],
      values: { f1: "吾輩は猫である" },
    });
    const c = await repo.createEntry("2026-11-12");
    const tag = (await repo.findOrCreateTag("旅行"))!;
    await repo.setTagLinked("entry", c, tag.id, true);

    const ids = async (query: string) => (await repo.listEntries({ query })).map((e) => e.id);
    expect(await ids("川沿い")).toEqual([a]);
    expect(await ids("散歩")).toEqual([a]);
    expect(await ids("猫")).toEqual([b]);
    expect(await ids("書名")).toEqual([b]);
    expect(await ids("旅行")).toEqual([c]);
    expect(await ids("雨 家")).toEqual([b]); // 空白区切りは全部を満たすもの
    expect(await ids("雨 川")).toEqual([]);
    expect(await ids("f1")).toEqual([]); // 内部のIDには当たらない
    expect(await ids("100%")).toEqual([]); // 記号はそのままの文字として扱う
  });
});

describe("構造とテンプレ", () => {
  it("構造を付け、値を入れ、テンプレとして保存し、別のエントリに付けられる", async () => {
    const { repo } = await openTestDb();
    const e1 = await repo.createEntry("2026-11-15");
    const s1 = await repo.addBlankStructure(e1, "体調");
    await repo.updateStructure(s1, {
      fields: [
        { id: "sleep", label: "睡眠時間", type: "number" },
        { id: "mood", label: "気分", type: "rating" },
      ],
      values: { sleep: 7, mood: 4 },
    });
    const health = (await repo.findOrCreateTag("健康"))!;
    await repo.setTagLinked("structure", s1, health.id, true);

    const templateId = (await repo.saveStructureAsTemplate(s1))!;
    const template = (await repo.getTemplate(templateId))!;
    expect(template.name).toBe("体調");
    expect(template.fields.map((f) => f.label)).toEqual(["睡眠時間", "気分"]);
    expect(template.tags.map((t) => t.name)).toEqual(["健康"]);

    const e2 = await repo.createEntry("2026-11-16");
    await repo.addStructureFromTemplate(e2, templateId);
    const detail = (await repo.getEntry(e2))!;
    expect(detail.structures).toHaveLength(1);
    expect(detail.structures[0].fields.map((f) => f.label)).toEqual(["睡眠時間", "気分"]);
    expect(detail.structures[0].values).toEqual({}); // 値は写さない
    expect(detail.structures[0].tags.map((t) => t.name)).toEqual(["健康"]);

    // テンプレを消しても、付けた構造は残る
    await repo.deleteTemplate(templateId);
    expect((await repo.getEntry(e2))!.structures).toHaveLength(1);
    expect(await repo.listTemplates()).toEqual([]);
  });

  it("構造を外せる・並べ替えられる・項目を消すと値も消える", async () => {
    const { repo } = await openTestDb();
    const e = await repo.createEntry("2026-11-15");
    const a = await repo.addBlankStructure(e, "A");
    const b = await repo.addBlankStructure(e, "B");
    const c = await repo.addBlankStructure(e, "C");
    const names = async () => (await repo.getEntry(e))!.structures.map((s) => s.name);
    expect(await names()).toEqual(["A", "B", "C"]);
    await repo.moveStructure(c, -1);
    expect(await names()).toEqual(["A", "C", "B"]);
    await repo.moveStructure(a, -1); // 端では何も起きない
    expect(await names()).toEqual(["A", "C", "B"]);
    await repo.removeStructure(a);
    expect(await names()).toEqual(["C", "B"]);

    await repo.updateStructure(b, {
      fields: [
        { id: "x", label: "X", type: "text" },
        { id: "y", label: "Y", type: "text" },
      ],
      values: { x: "1", y: "2" },
    });
    await repo.updateStructure(b, { fields: [{ id: "y", label: "Y", type: "text" }] });
    const structure = (await repo.getEntry(e))!.structures.find((s) => s.id === b)!;
    expect(structure.values).toEqual({ y: "2" });
  });
});

describe("タグ", () => {
  it("同じ名前は1つにまとまり、付け外しできる", async () => {
    const { repo } = await openTestDb();
    const t1 = (await repo.findOrCreateTag("Work"))!;
    const t2 = (await repo.findOrCreateTag(" work "))!;
    const t3 = (await repo.findOrCreateTag("#work"))!;
    expect(t2.id).toBe(t1.id);
    expect(t3.id).toBe(t1.id);
    expect(await repo.findOrCreateTag("  ")).toBeNull();

    const e = await repo.createEntry("2026-11-15");
    await repo.setTagLinked("entry", e, t1.id, true);
    expect((await repo.getEntry(e))!.tags.map((t) => t.name)).toEqual(["Work"]);
    await repo.setTagLinked("entry", e, t1.id, false);
    expect((await repo.getEntry(e))!.tags).toEqual([]);
    await repo.setTagLinked("entry", e, t1.id, true); // 付け直せる
    expect((await repo.getEntry(e))!.tags).toHaveLength(1);
  });

  it("親タグで絞ると子孫のタグが付いたものも出る。構造に付いたタグも見る", async () => {
    const { repo } = await openTestDb();
    const sport = (await repo.findOrCreateTag("運動"))!;
    const run = (await repo.findOrCreateTag("ランニング"))!;
    const trail = (await repo.findOrCreateTag("トレイル"))!;
    const food = (await repo.findOrCreateTag("食事"))!;
    expect(await repo.setTagParent(run.id, sport.id)).toBe(true);
    expect(await repo.setTagParent(trail.id, run.id)).toBe(true);

    const e1 = await repo.createEntry("2026-11-01");
    await repo.setTagLinked("entry", e1, trail.id, true);
    const e2 = await repo.createEntry("2026-11-02");
    const s = await repo.addBlankStructure(e2, "記録");
    await repo.setTagLinked("structure", s, run.id, true);
    const e3 = await repo.createEntry("2026-11-03");
    await repo.setTagLinked("entry", e3, food.id, true);
    await repo.setTagLinked("entry", e1, food.id, true);

    const ids = async (...tagIds: string[]) => (await repo.listEntries({ tagIds })).map((e) => e.id);
    expect(await ids(sport.id)).toEqual([e2, e1]);
    expect(await ids(run.id)).toEqual([e2, e1]);
    expect(await ids(trail.id)).toEqual([e1]);
    expect(await ids(sport.id, food.id)).toEqual([e1]); // 複数指定は全部を満たすもの

    // 構造を外すと、そのタグでは出なくなる
    await repo.removeStructure(s);
    expect(await ids(run.id)).toEqual([e1]);
  });

  it("親子が輪になる指定は断る。関連は向きなしで結べる", async () => {
    const { repo } = await openTestDb();
    const a = (await repo.findOrCreateTag("A"))!;
    const b = (await repo.findOrCreateTag("B"))!;
    const c = (await repo.findOrCreateTag("C"))!;
    await repo.setTagParent(b.id, a.id);
    await repo.setTagParent(c.id, b.id);
    expect(await repo.setTagParent(a.id, c.id)).toBe(false);
    expect(await repo.setTagParent(a.id, a.id)).toBe(false);

    await repo.setTagsRelated(c.id, a.id, true);
    let tags = await repo.listTags();
    const find = (id: string) => tags.find((t) => t.id === id)!;
    expect(find(b.id).parent_id).toBe(a.id);
    expect(find(a.id).related_ids).toEqual([c.id]);
    expect(find(c.id).related_ids).toEqual([a.id]);

    await repo.setTagsRelated(a.id, c.id, false);
    await repo.setTagParent(b.id, null);
    tags = await repo.listTags();
    expect(find(a.id).related_ids).toEqual([]);
    expect(find(b.id).parent_id).toBeNull();
  });

  it("タグを消すと付与も関係も消える", async () => {
    const { repo } = await openTestDb();
    const a = (await repo.findOrCreateTag("A"))!;
    const b = (await repo.findOrCreateTag("B"))!;
    await repo.setTagParent(b.id, a.id);
    const e = await repo.createEntry("2026-11-15");
    await repo.setTagLinked("entry", e, a.id, true);
    await repo.deleteTag(a.id);
    expect((await repo.getEntry(e))!.tags).toEqual([]);
    const tags = await repo.listTags();
    expect(tags.map((t) => t.name)).toEqual(["B"]);
    expect(tags[0].parent_id).toBeNull();
  });
});

describe("写真", () => {
  it("付けて、読めて、外せる", async () => {
    const { repo } = await openTestDb();
    const e = await repo.createEntry("2026-11-15");
    const id = await repo.addAttachment(e, { mime: "image/jpeg", width: 4, height: 3, data: "QUJD" });
    expect((await repo.listEntries())[0].photo_count).toBe(1);
    expect(await repo.getAttachmentUrl(id)).toBe("data:image/jpeg;base64,QUJD");
    await repo.removeAttachment(id);
    expect((await repo.getEntry(e))!.attachments).toEqual([]);
    expect(await repo.getAttachmentUrl(id)).toBeNull();
  });
});

describe("同時の保存", () => {
  it("構造の名前と値を同時に保存しても、どちらも残る", async () => {
    const { repo } = await openTestDb();
    const e = await repo.createEntry("2026-11-15");
    const s = await repo.addBlankStructure(e, "旧名");
    await repo.updateStructure(s, { fields: [{ id: "a", label: "A", type: "text" }] });
    await Promise.all([
      repo.updateStructure(s, { name: "新名" }),
      repo.updateStructure(s, { values: { a: "値" } }),
    ]);
    const structure = (await repo.getEntry(e))!.structures[0];
    expect(structure.name).toBe("新名");
    expect(structure.values).toEqual({ a: "値" });
  });

  it("同じ名前のタグを同時に作ろうとしても1つだけできる", async () => {
    const { repo } = await openTestDb();
    const [a, b] = await Promise.all([repo.findOrCreateTag("同時"), repo.findOrCreateTag("同時")]);
    expect(a!.id).toBe(b!.id);
    expect(await repo.listTags()).toHaveLength(1);
  });
});

describe("3つの日時（日付・作成・最終更新）", () => {
  const tick = () => new Promise((r) => setTimeout(r, 3));

  it("日付を付けずに作ると日付は空で、作成した日の位置に並ぶ", async () => {
    // 端末の日付とUTCの日付が食い違う時間帯にして、端末の時間帯で数えていることを確かめる
    const before = process.env.TZ;
    process.env.TZ = new Date().getUTCHours() >= 10 ? "Pacific/Kiritimati" : "Etc/GMT+12";
    try {
      const { repo } = await openTestDb();
      const id = await repo.createEntry();
      const entry = (await repo.getEntry(id))!;
      const localDay = toDateString(new Date(entry.created_at));
      expect(localDay).not.toBe(new Date(entry.created_at).toISOString().slice(0, 10));
      expect(entry.date).toBe("");
      expect(entry.day).toBe(localDay);
      expect((await repo.listEntries())[0].day).toBe(localDay);
    } finally {
      process.env.TZ = before;
    }
  });

  it("明示的に付けた日付があれば、その日の位置に並ぶ。外すと作成日に戻る", async () => {
    const { repo } = await openTestDb();
    const plain = await repo.createEntry();
    const past = await repo.createEntry();
    const future = await repo.createEntry();
    await repo.updateEntry(past, { date: "2020-01-01" });
    await repo.updateEntry(future, { date: "2099-12-31" });
    const order = async () => (await repo.listEntries()).map((e) => e.id);
    expect(await order()).toEqual([future, plain, past]);
    expect((await repo.getEntry(past))!.day).toBe("2020-01-01");

    await repo.updateEntry(past, { date: "" });
    const entry = (await repo.getEntry(past))!;
    expect(entry.date).toBe("");
    expect(entry.day).toBe(toDateString(new Date(entry.created_at)));
    // 日付なし同士は、作成が新しい方が先
    expect(await order()).toEqual([future, past, plain]);
  });

  it("作成の時刻は、何を変えても動かない", async () => {
    const { repo } = await openTestDb();
    const id = await repo.createEntry();
    const created = (await repo.getEntry(id))!.created_at;
    await tick();
    await repo.updateEntry(id, { title: "題", body: "本文", date: "2021-05-05" });
    const s = await repo.addBlankStructure(id, "構造");
    await repo.removeStructure(s);
    expect((await repo.getEntry(id))!.created_at).toBe(created);
  });

  it("最終更新は、本文だけでなく構造・タグ・写真・日付の変更でも進む", async () => {
    const { repo } = await openTestDb();
    const id = await repo.createEntry();
    const other = await repo.createEntry();
    let last = (await repo.getEntry(id))!.edited_at;
    expect(last).toBe((await repo.getEntry(id))!.created_at);

    const advanced = async (what: string) => {
      const now = (await repo.getEntry(id))!.edited_at;
      expect(now, what).toBeGreaterThan(last);
      last = now;
      await tick();
    };
    await tick();
    await repo.updateEntry(id, { body: "書いた" });
    await advanced("本文");
    await repo.updateEntry(id, { date: "2022-02-02" });
    await advanced("日付");
    const s = await repo.addBlankStructure(id, "体調");
    await advanced("構造を付ける");
    await repo.updateStructure(s, { fields: [{ id: "a", label: "A", type: "text" }], values: { a: "x" } });
    await advanced("構造の値");
    const tag = (await repo.findOrCreateTag("タグ"))!;
    await repo.setTagLinked("structure", s, tag.id, true);
    await advanced("構造のタグ");
    await repo.setTagLinked("entry", id, tag.id, true);
    await advanced("日記のタグ");
    await repo.setTagLinked("entry", id, tag.id, false);
    await advanced("タグを外す");
    const photo = await repo.addAttachment(id, { mime: "image/jpeg", width: 1, height: 1, data: "QUJD" });
    await advanced("写真を付ける");
    await repo.removeAttachment(photo);
    await advanced("写真を外す");
    await repo.removeStructure(s);
    await advanced("構造を外す");

    // 別の日記を変えても、この日記の最終更新は動かない
    await repo.updateEntry(other, { body: "別の日記" });
    await repo.setTagLinked("entry", other, tag.id, true);
    expect((await repo.getEntry(id))!.edited_at).toBe(last);
    // 開いて読むだけでも動かない
    await repo.listEntries();
    expect((await repo.getEntry(id))!.edited_at).toBe(last);
  });
});
