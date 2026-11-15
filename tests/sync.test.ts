import { describe, expect, it } from "vitest";
import { resetSyncState, syncOnce } from "../src/sync/engine";
import { FakeRemote, openTestDb } from "./helpers";

const tick = () => new Promise((r) => setTimeout(r, 3));

describe("同期", () => {
  it("片方で書いた日記・構造・タグ・写真が、もう片方に届く", async () => {
    const remote = new FakeRemote();
    const pc = await openTestDb();
    const phone = await openTestDb();

    const e = await pc.repo.createEntry("2026-11-15");
    await pc.repo.updateEntry(e, { title: "PCで書いた", body: "本文" });
    const s = await pc.repo.addBlankStructure(e, "体調");
    await pc.repo.updateStructure(s, {
      fields: [{ id: "mood", label: "気分", type: "rating" }],
      values: { mood: 5 },
    });
    const tag = (await pc.repo.findOrCreateTag("健康"))!;
    const parent = (await pc.repo.findOrCreateTag("生活"))!;
    await pc.repo.setTagParent(tag.id, parent.id);
    await pc.repo.setTagLinked("structure", s, tag.id, true);
    const photo = await pc.repo.addAttachment(e, { mime: "image/jpeg", width: 1, height: 1, data: "QUJD" });
    await pc.repo.saveStructureAsTemplate(s);

    await syncOnce(pc.db, remote);
    const result = await syncOnce(phone.db, remote);
    expect(result.changed).toBe(true);

    const detail = (await phone.repo.getEntry(e))!;
    expect(detail.title).toBe("PCで書いた");
    expect(detail.structures[0].values).toEqual({ mood: 5 });
    expect(detail.structures[0].tags.map((t) => t.name)).toEqual(["健康"]);
    expect(await phone.repo.getAttachmentUrl(photo)).toBe("data:image/jpeg;base64,QUJD");
    expect((await phone.repo.listTemplates()).map((t) => t.name)).toEqual(["体調"]);
    expect((await phone.repo.listTags()).find((t) => t.name === "健康")!.parent_id).toBe(parent.id);
    // 届いた構造も検索に当たる
    expect((await phone.repo.listEntries({ query: "気分" })).map((x) => x.id)).toEqual([e]);
    // 親タグで絞っても出る
    expect((await phone.repo.listEntries({ tagIds: [parent.id] })).map((x) => x.id)).toEqual([e]);
  });

  it("変更が無ければ、2回目の同期は何も送らず何も変えない", async () => {
    const remote = new FakeRemote();
    const pc = await openTestDb();
    await pc.repo.createEntry("2026-11-15");
    expect((await syncOnce(pc.db, remote)).pushed).toBe(1);
    const again = await syncOnce(pc.db, remote);
    expect(again.pushed).toBe(0);
    expect(again.changed).toBe(false);
  });

  it("同じエントリを両方で編集したら、後から編集した方が残る", async () => {
    const remote = new FakeRemote();
    const pc = await openTestDb();
    const phone = await openTestDb();
    const e = await pc.repo.createEntry("2026-11-15");
    await syncOnce(pc.db, remote);
    await syncOnce(phone.db, remote);

    await pc.repo.updateEntry(e, { body: "PC版" });
    await tick();
    await phone.repo.updateEntry(e, { body: "スマホ版（後）" });

    // 後から編集したスマホが先に同期しても、PCが後から同期しても、結果は同じ
    await syncOnce(phone.db, remote);
    await syncOnce(pc.db, remote);
    await syncOnce(phone.db, remote);
    expect((await pc.repo.getEntry(e))!.body).toBe("スマホ版（後）");
    expect((await phone.repo.getEntry(e))!.body).toBe("スマホ版（後）");
  });

  it("古い方の編集が後から届いても、新しい方を上書きしない", async () => {
    const remote = new FakeRemote();
    const pc = await openTestDb();
    const phone = await openTestDb();
    const e = await pc.repo.createEntry("2026-11-15");
    await syncOnce(pc.db, remote);
    await syncOnce(phone.db, remote);

    await phone.repo.updateEntry(e, { body: "スマホ版（先）" });
    await tick();
    await pc.repo.updateEntry(e, { body: "PC版（後）" });

    await syncOnce(pc.db, remote);
    await syncOnce(phone.db, remote); // スマホの古い編集はサーバーで無視され、PC版を受け取る
    await syncOnce(phone.db, remote);
    await syncOnce(pc.db, remote);
    expect((await pc.repo.getEntry(e))!.body).toBe("PC版（後）");
    expect((await phone.repo.getEntry(e))!.body).toBe("PC版（後）");
  });

  it("削除が他の端末に伝わる。写真の中身もクラウドから消える", async () => {
    const remote = new FakeRemote();
    const pc = await openTestDb();
    const phone = await openTestDb();
    const e = await pc.repo.createEntry("2026-11-15");
    const photo = await pc.repo.addAttachment(e, { mime: "image/png", width: 1, height: 1, data: "QUJD" });
    await syncOnce(pc.db, remote);
    await syncOnce(phone.db, remote);
    expect(remote.blobs.has(photo)).toBe(true);

    await phone.repo.deleteEntry(e);
    await syncOnce(phone.db, remote);
    await syncOnce(pc.db, remote);
    expect(await pc.repo.getEntry(e)).toBeNull();
    expect(await pc.repo.listEntries()).toEqual([]);
    expect(remote.blobs.has(photo)).toBe(false);
  });

  it("同じタグ付けを両方で行っても、1つにまとまる", async () => {
    const remote = new FakeRemote();
    const pc = await openTestDb();
    const phone = await openTestDb();
    const e = await pc.repo.createEntry("2026-11-15");
    const tag = (await pc.repo.findOrCreateTag("旅行"))!;
    await syncOnce(pc.db, remote);
    await syncOnce(phone.db, remote);

    await pc.repo.setTagLinked("entry", e, tag.id, true);
    await phone.repo.setTagLinked("entry", e, tag.id, true);
    await syncOnce(pc.db, remote);
    await syncOnce(phone.db, remote);
    await syncOnce(pc.db, remote);
    expect((await pc.repo.getEntry(e))!.tags).toHaveLength(1);
    expect((await phone.repo.getEntry(e))!.tags).toHaveLength(1);
  });

  it("大量の行も、ページを分けて全部届く", async () => {
    const remote = new FakeRemote();
    const pc = await openTestDb();
    const phone = await openTestDb();
    for (let i = 0; i < 620; i++) await pc.repo.createEntry("2026-01-01");
    expect((await syncOnce(pc.db, remote)).pushed).toBe(620);
    expect((await syncOnce(phone.db, remote)).pulled).toBe(620);
    expect(await phone.repo.listEntries({ limit: 1000 })).toHaveLength(620);
  });

  it("アカウントを切り替えたら、手元のデータを新しい同期先へ送り直す", async () => {
    const first = new FakeRemote();
    const second = new FakeRemote();
    const pc = await openTestDb();
    const e = await pc.repo.createEntry("2026-11-15");
    await syncOnce(pc.db, first);
    await resetSyncState(pc.db);
    await syncOnce(pc.db, second);
    expect(second.records.has(`entry/${e}`)).toBe(true);
    expect(await pc.repo.getEntry(e)).not.toBeNull();
  });
});
