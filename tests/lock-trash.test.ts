import { describe, expect, it } from "vitest";
import { EntryLockedError } from "../src/db/repo";
import { TRASH_DAYS } from "../src/db/types";
import { openTestDb } from "./helpers";

const tick = () => new Promise((r) => setTimeout(r, 3));
const DAY = 86_400_000;

/** 構造・タグ・写真まで付いた日記を1件作る */
async function richEntry(repo: Awaited<ReturnType<typeof openTestDb>>["repo"]) {
  const id = await repo.createEntry();
  await repo.updateEntry(id, { title: "題", body: "本文", date: "2026-01-01" });
  const structure = await repo.addBlankStructure(id, "体調");
  await repo.updateStructure(structure, { fields: [{ id: "a", label: "気分", type: "rating" }], values: { a: 3 } });
  const tag = (await repo.findOrCreateTag("健康"))!;
  await repo.setTagLinked("entry", id, tag.id, true);
  await repo.setTagLinked("structure", structure, tag.id, true);
  const photo = await repo.addAttachment(id, { mime: "image/jpeg", width: 1, height: 1, data: "QUJD" });
  const templateId = await repo.createTemplate("テンプレ");
  return { id, structure, tag, photo, templateId };
}

describe("ロック", () => {
  it("ロックしても外しても、最終更新・作成・中身は変わらない", async () => {
    const { repo } = await openTestDb();
    const { id } = await richEntry(repo);
    const before = (await repo.getEntry(id))!;
    expect(before.locked).toBe(false);
    await tick();
    await repo.setLocked(id, true);
    const locked = (await repo.getEntry(id))!;
    expect(locked.locked).toBe(true);
    expect(locked.edited_at).toBe(before.edited_at);
    expect(locked.updated_at).toBe(before.updated_at);
    expect(locked.created_at).toBe(before.created_at);
    expect({ ...locked, locked: false }).toEqual(before);
    await tick();
    await repo.setLocked(id, false);
    expect((await repo.getEntry(id))!).toEqual(before);
  });

  it("ロック中は、日記の中身を変える操作がすべて断られ、何も変わらない", async () => {
    const { repo } = await openTestDb();
    const { id, structure, tag, photo, templateId } = await richEntry(repo);
    await repo.setLocked(id, true);
    const before = (await repo.getEntry(id))!;
    const other = (await repo.findOrCreateTag("別のタグ"))!;

    const attempts: [string, () => Promise<unknown>][] = [
      ["題", () => repo.updateEntry(id, { title: "変えた" })],
      ["本文", () => repo.updateEntry(id, { body: "変えた" })],
      ["日付", () => repo.updateEntry(id, { date: "2000-01-01" })],
      ["日付を外す", () => repo.updateEntry(id, { date: "" })],
      ["空の構造を付ける", () => repo.addBlankStructure(id, "新")],
      ["テンプレから構造を付ける", () => repo.addStructureFromTemplate(id, templateId)],
      ["構造の名前", () => repo.updateStructure(structure, { name: "変えた" })],
      ["構造の項目", () => repo.updateStructure(structure, { fields: [] })],
      ["構造の値", () => repo.updateStructure(structure, { values: { a: 5 } })],
      ["構造を外す", () => repo.removeStructure(structure)],
      ["構造をテンプレとして保存", () => repo.saveStructureAsTemplate(structure)],
      ["日記にタグを付ける", () => repo.setTagLinked("entry", id, other.id, true)],
      ["日記のタグを外す", () => repo.setTagLinked("entry", id, tag.id, false)],
      ["構造にタグを付ける", () => repo.setTagLinked("structure", structure, other.id, true)],
      ["構造のタグを外す", () => repo.setTagLinked("structure", structure, tag.id, false)],
      ["写真を付ける", () => repo.addAttachment(id, { mime: "image/jpeg", width: 1, height: 1, data: "QUJD" })],
      ["写真を外す", () => repo.removeAttachment(photo)],
      ["ゴミ箱に入れる", () => repo.trashEntry(id)],
      ["完全に削除する", () => repo.purgeEntry(id)],
    ];
    for (const [what, attempt] of attempts) {
      await expect(attempt(), what).rejects.toBeInstanceOf(EntryLockedError);
    }
    expect((await repo.getEntry(id))!, "何も変わっていない").toEqual(before);
    expect((await repo.listTemplates()).map((t) => t.name)).toEqual(["テンプレ"]);
    expect(await repo.listEntries()).toHaveLength(1);
  });

  it("ロックを外せば、また変えられる", async () => {
    const { repo } = await openTestDb();
    const { id } = await richEntry(repo);
    await repo.setLocked(id, true);
    await repo.setLocked(id, false);
    await repo.updateEntry(id, { body: "書き足した" });
    expect((await repo.getEntry(id))!.body).toBe("書き足した");
  });

  it("タグを消しても、ロック中の日記の最終更新は動かない。ロックしていない日記からはタグが外れる", async () => {
    const { repo } = await openTestDb();
    const a = await richEntry(repo);
    const b = await repo.createEntry();
    await repo.setTagLinked("entry", b, a.tag.id, true);
    await repo.setLocked(a.id, true);
    const before = (await repo.getEntry(a.id))!;
    await tick();
    await repo.deleteTag(a.tag.id);
    const after = (await repo.getEntry(a.id))!;
    expect(after.edited_at).toBe(before.edited_at);
    expect(after.tags).toEqual([]);
    expect(after.structures[0].tags).toEqual([]);
    expect((await repo.getEntry(b))!.tags).toEqual([]);
  });

  it("ロックは一覧にも出て、検索やタグでの絞り込みは今までどおり効く", async () => {
    const { repo } = await openTestDb();
    const { id, tag } = await richEntry(repo);
    await repo.setLocked(id, true);
    expect((await repo.listEntries())[0].locked).toBe(true);
    expect((await repo.listEntries({ query: "本文" })).map((e) => e.id)).toEqual([id]);
    expect((await repo.listEntries({ tagIds: [tag.id] })).map((e) => e.id)).toEqual([id]);
  });

  it("テンプレやタグの管理は、ロック中の日記があってもできる", async () => {
    const { repo } = await openTestDb();
    const { id, tag, templateId } = await richEntry(repo);
    await repo.setLocked(id, true);
    await repo.updateTemplate(templateId, { name: "変えた" });
    await repo.updateTag(tag.id, { name: "体調管理" });
    expect((await repo.getEntry(id))!.tags.map((t) => t.name)).toEqual(["体調管理"]);
  });
});

describe("ゴミ箱", () => {
  it("ゴミ箱に入れると一覧・検索・絞り込み・タグの件数から消え、ゴミ箱に出る", async () => {
    const { repo } = await openTestDb();
    const { id, tag } = await richEntry(repo);
    const keep = await repo.createEntry();
    await repo.updateEntry(keep, { body: "残す日記" });
    await repo.trashEntry(id);

    expect((await repo.listEntries()).map((e) => e.id)).toEqual([keep]);
    expect(await repo.listEntries({ query: "本文" })).toEqual([]);
    expect(await repo.listEntries({ tagIds: [tag.id] })).toEqual([]);
    expect((await repo.listTags()).find((t) => t.id === tag.id)!.use_count).toBe(0);
    const trash = await repo.listTrash();
    expect(trash.map((e) => e.id)).toEqual([id]);
    expect(trash[0].trashed_at).toBeGreaterThan(0);
    expect(trash[0].structure_names).toEqual(["体調"]);
    expect(trash[0].photo_count).toBe(1);
    // 開けば中身は見られる
    expect((await repo.getEntry(id))!.body).toBe("本文");
  });

  it("元に戻すと、中身も最終更新もそのままで一覧に帰ってくる", async () => {
    const { repo } = await openTestDb();
    const { id, tag } = await richEntry(repo);
    const before = (await repo.getEntry(id))!;
    await tick();
    await repo.trashEntry(id);
    expect((await repo.getEntry(id))!.edited_at).toBe(before.edited_at);
    await tick();
    await repo.restoreEntry(id);
    expect((await repo.getEntry(id))!).toEqual(before);
    expect((await repo.listEntries()).map((e) => e.id)).toEqual([id]);
    expect(await repo.listTrash()).toEqual([]);
    expect((await repo.listTags()).find((t) => t.id === tag.id)!.use_count).toBe(2);
  });

  it("ゴミ箱の中では中身を変えられず、ロックもできない", async () => {
    const { repo } = await openTestDb();
    const { id, structure } = await richEntry(repo);
    await repo.trashEntry(id);
    await expect(repo.updateEntry(id, { body: "x" })).rejects.toBeInstanceOf(EntryLockedError);
    await expect(repo.updateStructure(structure, { name: "x" })).rejects.toBeInstanceOf(EntryLockedError);
    await expect(repo.setLocked(id, true)).rejects.toBeInstanceOf(EntryLockedError);
  });

  it("完全に削除すると、ゴミ箱からも消えて戻せない", async () => {
    const { repo } = await openTestDb();
    const { id, photo } = await richEntry(repo);
    await repo.trashEntry(id);
    await repo.purgeEntry(id);
    expect(await repo.getEntry(id)).toBeNull();
    expect(await repo.listTrash()).toEqual([]);
    expect(await repo.getAttachmentUrl(photo)).toBeNull();
    await repo.restoreEntry(id); // 何も起きない
    expect(await repo.listEntries()).toEqual([]);
  });

  it(`入れてから${TRASH_DAYS}日を過ぎたものだけが、自動で完全に削除される`, async () => {
    const { repo } = await openTestDb();
    const old = await repo.createEntry();
    const recent = await repo.createEntry();
    await repo.trashEntry(old);
    await repo.trashEntry(recent);
    const trashedAt = (await repo.listTrash()).find((e) => e.id === old)!.trashed_at!;

    expect(await repo.purgeExpiredTrash(trashedAt + (TRASH_DAYS - 1) * DAY)).toBe(0);
    expect(await repo.listTrash()).toHaveLength(2);
    // old だけ期限を過ぎた時点
    await repo.restoreEntry(recent);
    await repo.trashEntry(recent);
    const recentAt = (await repo.listTrash()).find((e) => e.id === recent)!.trashed_at!;
    expect(recentAt).toBeGreaterThan(trashedAt);
    expect(await repo.purgeExpiredTrash(trashedAt + TRASH_DAYS * DAY)).toBe(1);
    expect((await repo.listTrash()).map((e) => e.id)).toEqual([recent]);
    expect(await repo.getEntry(old)).toBeNull();
  });

  it("ゴミ箱を空にすると全部消え、ゴミ箱に入っていない日記は残る", async () => {
    const { repo } = await openTestDb();
    const a = await repo.createEntry();
    const b = await repo.createEntry();
    const keep = await repo.createEntry();
    await repo.trashEntry(a);
    await repo.trashEntry(b);
    expect(await repo.emptyTrash()).toBe(2);
    expect(await repo.listTrash()).toEqual([]);
    expect((await repo.listEntries()).map((e) => e.id)).toEqual([keep]);
  });
});
