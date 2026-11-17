import type { Driver } from "./driver";
import {
  TAG_COLORS,
  type AttachmentMeta,
  type Entry,
  type EntryDetail,
  type EntrySummary,
  type FieldDef,
  type FieldValues,
  type Structure,
  type Tag,
  type TagInfo,
  type TagTarget,
  type Template,
  TRASH_DAYS,
} from "./types";
import { chunk, likePattern, now, parseJson, structureSearchText, uid } from "./util";

interface StructureRow {
  id: string;
  entry_id: string;
  template_id: string | null;
  name: string;
  fields: string;
  vals: string;
  position: number;
  updated_at: number;
}

const EXCERPT_LENGTH = 160;

/**
 * 一覧で並べるときの日。明示的に付けた日付があればそれ、無ければ作成した日。
 * 作成した日は、端末の時間帯での日付にする（夜中に書いたものが前後の日にずれないように）。
 */
const DAY = `CASE WHEN e.date <> '' THEN e.date
  ELSE strftime('%Y-%m-%d', e.created_at / 1000, 'unixepoch', 'localtime') END`;

/**
 * 最終更新。エントリの行そのものに加え、そこに付いた構造・写真・タグ付けのうち、最後に変わった時刻。
 * 外した構造や写真も「変更」なので、削除済みの行も含めて見る。
 */
const EDITED_AT = `max(
  e.updated_at,
  coalesce((SELECT max(s.updated_at) FROM structures s WHERE s.entry_id = e.id), 0),
  coalesce((SELECT max(a.updated_at) FROM attachments a WHERE a.entry_id = e.id), 0),
  coalesce((SELECT max(l.updated_at) FROM tag_links l WHERE
    (l.target_type = 'entry' AND l.target_id = e.id) OR
    (l.target_type = 'structure' AND l.target_id IN (SELECT s.id FROM structures s WHERE s.entry_id = e.id))), 0)
)`;

/** 日記ごとの状態（ロック・ゴミ箱）。一覧などで entries e に LEFT JOIN して使う。 */
const META_JOIN = `LEFT JOIN entry_meta m ON m.id = e.id AND m.deleted = 0`;
const META_COLS = `coalesce(m.locked, 0) AS locked, m.trashed_at AS trashed_at`;

/** タグ付け（別名 alias）が、どの日記のものか。日記か構造に付いたものだけで、テンプレのものは NULL。 */
const linkEntry = (alias: string) => `(CASE ${alias}.target_type
  WHEN 'entry' THEN ${alias}.target_id
  WHEN 'structure' THEN (SELECT s2.entry_id FROM structures s2 WHERE s2.id = ${alias}.target_id)
END)`;

/** ロック中やゴミ箱の中の日記を変えようとしたときのエラー */
export class EntryLockedError extends Error {
  constructor(readonly reason: "locked" | "trashed") {
    super(reason === "locked" ? "ロック中の日記は変更できません" : "ゴミ箱の中の日記は変更できません。先に元に戻してください");
    this.name = "EntryLockedError";
  }
}

interface EntryRow extends Omit<Entry, "locked"> {
  locked: number;
}

const toEntry = <T extends EntryRow>(row: T): Omit<T, "locked"> & { locked: boolean } => ({
  ...row,
  locked: !!row.locked,
});

/**
 * 日記データへの操作をまとめた層。画面はここだけを通して読み書きする。
 * 変更系の操作は updated_at を進めて dirty=1 にし、onChange を呼ぶ（同期と画面更新の合図）。
 */
export class Repo {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly db: Driver,
    private readonly onChange: () => void = () => {},
  ) {}

  /**
   * 「読んでから書く」操作を1つずつ順に実行する。
   * 名前と値を同時に保存したときなどに、片方がもう片方を古い内容で上書きしないようにする。
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- エントリ

  /** 日記を作る。date は明示的に付ける日付で、省けば「付けていない」状態になる。 */
  async createEntry(date = ""): Promise<string> {
    const id = uid();
    const t = now();
    await this.db.run(
      `INSERT INTO entries (id, date, title, body, created_at, updated_at) VALUES (?, ?, '', '', ?, ?)`,
      [id, date, t, t],
    );
    this.onChange();
    return id;
  }

  async updateEntry(id: string, patch: Partial<Pick<Entry, "date" | "title" | "body">>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of ["date", "title", "body"] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(patch[key]);
      }
    }
    if (!sets.length) return;
    await this.assertEditable(id);
    await this.db.run(`UPDATE entries SET ${sets.join(", ")}, updated_at = ?, dirty = 1 WHERE id = ?`, [
      ...params,
      now(),
      id,
    ]);
    this.onChange();
  }

  // ---------------------------------------------------------------- ロック

  /**
   * ロックする／外す。ロック中は日記の中身（日付・題・本文・構造・タグ・写真）を何も変えられず、ゴミ箱にも入れられない。
   * ロックの付け外しそのものは、日記の「最終更新」を動かさない。
   */
  async setLocked(id: string, locked: boolean): Promise<void> {
    const state = await this.entryState(id);
    if (!state) return;
    if (state.trashed_at !== null) throw new EntryLockedError("trashed");
    await this.db.run(
      `INSERT INTO entry_meta (id, locked, trashed_at, updated_at, deleted, dirty) VALUES (?, ?, NULL, ?, 0, 1)
       ON CONFLICT(id) DO UPDATE SET locked = excluded.locked, updated_at = excluded.updated_at, deleted = 0, dirty = 1`,
      [id, locked ? 1 : 0, now()],
    );
    this.onChange();
  }

  // ---------------------------------------------------------------- ゴミ箱

  /**
   * ゴミ箱に入れる。一覧や検索には出なくなるが、TRASH_DAYS 日の間は元に戻せる。中身はそのまま残る。
   * ゴミ箱への出し入れは、日記の「最終更新」を動かさない。
   */
  async trashEntry(id: string): Promise<void> {
    const state = await this.entryState(id);
    if (!state || state.trashed_at !== null) return;
    if (state.locked) throw new EntryLockedError("locked");
    await this.setTrashedAt(id, now());
  }

  /** ゴミ箱から元に戻す */
  async restoreEntry(id: string): Promise<void> {
    const state = await this.entryState(id);
    if (!state || state.trashed_at === null) return;
    await this.setTrashedAt(id, null);
  }

  private async setTrashedAt(id: string, trashedAt: number | null): Promise<void> {
    await this.db.run(
      `INSERT INTO entry_meta (id, locked, trashed_at, updated_at, deleted, dirty) VALUES (?, 0, ?, ?, 0, 1)
       ON CONFLICT(id) DO UPDATE SET trashed_at = excluded.trashed_at, updated_at = excluded.updated_at,
         deleted = 0, dirty = 1`,
      [id, trashedAt, now()],
    );
    this.onChange();
  }

  /** ゴミ箱の中身。新しく入れたものが先。 */
  async listTrash(): Promise<EntrySummary[]> {
    const rows = await this.db.all<EntryRow>(
      `SELECT e.id, e.date, ${DAY} AS day, e.title, substr(e.body, 1, ${EXCERPT_LENGTH}) AS body,
              e.created_at, e.updated_at, ${META_COLS}
       FROM entries e ${META_JOIN}
       WHERE e.deleted = 0 AND m.trashed_at IS NOT NULL
       ORDER BY m.trashed_at DESC`,
    );
    return this.summarize(rows.map(toEntry));
  }

  /** ゴミ箱の中の日記を、元に戻せない形で削除する */
  async purgeEntry(id: string): Promise<void> {
    const state = await this.entryState(id);
    if (!state) return;
    if (state.locked) throw new EntryLockedError("locked");
    await this.purgeNow(id);
    this.onChange();
  }

  /** ゴミ箱を空にする */
  async emptyTrash(): Promise<number> {
    return this.purgeWhere(`m.trashed_at IS NOT NULL`, []);
  }

  /** ゴミ箱に入れてから TRASH_DAYS 日を過ぎたものを、完全に削除する。消した件数を返す。 */
  async purgeExpiredTrash(at = Date.now()): Promise<number> {
    return this.purgeWhere(`m.trashed_at IS NOT NULL AND m.trashed_at <= ?`, [at - TRASH_DAYS * 86_400_000]);
  }

  private async purgeWhere(condition: string, params: unknown[]): Promise<number> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT e.id FROM entries e ${META_JOIN} WHERE e.deleted = 0 AND coalesce(m.locked, 0) = 0 AND ${condition}`,
      params,
    );
    for (const r of rows) await this.purgeNow(r.id);
    if (rows.length) this.onChange();
    return rows.length;
  }

  /** エントリと、それに付いている構造・タグ付け・写真・状態をまとめて削除する */
  private async purgeNow(id: string): Promise<void> {
    const t = now();
    const structures = await this.db.all<{ id: string }>(
      `SELECT id FROM structures WHERE entry_id = ? AND deleted = 0`,
      [id],
    );
    for (const s of structures) await this.unlinkAll("structure", s.id, t);
    await this.unlinkAll("entry", id, t);
    await this.db.run(
      `UPDATE structures SET deleted = 1, updated_at = ?, dirty = 1 WHERE entry_id = ? AND deleted = 0`,
      [t, id],
    );
    await this.db.run(
      `UPDATE attachments SET deleted = 1, data = NULL, updated_at = ?, dirty = 1 WHERE entry_id = ? AND deleted = 0`,
      [t, id],
    );
    await this.db.run(`UPDATE entry_meta SET deleted = 1, updated_at = ?, dirty = 1 WHERE id = ? AND deleted = 0`, [
      t,
      id,
    ]);
    await this.db.run(`UPDATE entries SET deleted = 1, updated_at = ?, dirty = 1 WHERE id = ?`, [t, id]);
  }

  // ---------------------------------------------------------------- 状態の確認

  /** 日記のロックとゴミ箱の状態。日記が無ければ null。 */
  private async entryState(id: string): Promise<{ locked: boolean; trashed_at: number | null } | null> {
    const rows = await this.db.all<{ locked: number; trashed_at: number | null }>(
      `SELECT ${META_COLS} FROM entries e ${META_JOIN} WHERE e.id = ? AND e.deleted = 0`,
      [id],
    );
    return rows.length ? { locked: !!rows[0].locked, trashed_at: rows[0].trashed_at } : null;
  }

  /** ロック中かゴミ箱の中なら、変更を断る */
  private async assertEditable(entryId: string): Promise<void> {
    const state = await this.entryState(entryId);
    if (state?.locked) throw new EntryLockedError("locked");
    if (state && state.trashed_at !== null) throw new EntryLockedError("trashed");
  }

  private async assertStructureEditable(structureId: string): Promise<void> {
    const rows = await this.db.all<{ entry_id: string }>(`SELECT entry_id FROM structures WHERE id = ?`, [structureId]);
    if (rows.length) await this.assertEditable(rows[0].entry_id);
  }

  private async assertAttachmentEditable(attachmentId: string): Promise<void> {
    const rows = await this.db.all<{ entry_id: string }>(`SELECT entry_id FROM attachments WHERE id = ?`, [attachmentId]);
    if (rows.length) await this.assertEditable(rows[0].entry_id);
  }

  // ---------------------------------------------------------------- 読み出し

  /** 日記を1件。ゴミ箱の中のものも返す（trashed_at で見分ける）。 */
  async getEntry(id: string): Promise<EntryDetail | null> {
    const rows = await this.db.all<EntryRow & { edited_at: number }>(
      `SELECT e.id, e.date, ${DAY} AS day, e.title, e.body, e.created_at, e.updated_at, ${META_COLS},
              ${EDITED_AT} AS edited_at
       FROM entries e ${META_JOIN} WHERE e.id = ? AND e.deleted = 0`,
      [id],
    );
    if (!rows.length) return null;
    const structureRows = await this.db.all<StructureRow>(
      `SELECT id, entry_id, template_id, name, fields, vals, position, updated_at
       FROM structures WHERE entry_id = ? AND deleted = 0 ORDER BY position, created_at`,
      [id],
    );
    const structureTags = await this.tagsFor(
      "structure",
      structureRows.map((s) => s.id),
    );
    const entryTags = await this.tagsFor("entry", [id]);
    return {
      ...toEntry(rows[0]),
      tags: entryTags.get(id) ?? [],
      structures: structureRows.map((s) => toStructure(s, structureTags.get(s.id) ?? [])),
      attachments: await this.listAttachments(id),
    };
  }

  /**
   * 一覧と検索。
   * query は空白区切りの各語が、題・本文・構造の中身・タグ名のどこかに含まれるものに絞る。
   * tagIds は指定した全タグを満たすものに絞る。親タグを指定すると子孫のタグが付いたものも含む。
   * タグはエントリ自体に付いたものと、そのエントリの構造に付いたものの両方を見る。
   */
  async listEntries(opts: { query?: string; tagIds?: string[]; limit?: number } = {}): Promise<EntrySummary[]> {
    const where: string[] = [`e.deleted = 0`, `m.trashed_at IS NULL`];
    const params: unknown[] = [];

    // このエントリ、またはその構造に付いたタグ付けを探す部分
    const linkedHere = `(
      (l.target_type = 'entry' AND l.target_id = e.id) OR
      (l.target_type = 'structure' AND l.target_id IN
        (SELECT s.id FROM structures s WHERE s.entry_id = e.id AND s.deleted = 0))
    )`;

    for (const term of (opts.query ?? "").split(/\s+/).filter(Boolean)) {
      const p = likePattern(term);
      where.push(`(
        e.title LIKE ? ESCAPE '\\' OR e.body LIKE ? ESCAPE '\\' OR
        EXISTS (SELECT 1 FROM structures s
                WHERE s.entry_id = e.id AND s.deleted = 0 AND s.search_text LIKE ? ESCAPE '\\') OR
        EXISTS (SELECT 1 FROM tag_links l JOIN tags t ON t.id = l.tag_id
                WHERE l.deleted = 0 AND t.deleted = 0 AND t.name LIKE ? ESCAPE '\\' AND ${linkedHere})
      )`);
      params.push(p, p, p, p);
    }

    if (opts.tagIds?.length) {
      const children = await this.childrenMap();
      for (const tagId of opts.tagIds) {
        const family = [tagId, ...descendants(children, tagId)];
        where.push(`EXISTS (SELECT 1 FROM tag_links l
          WHERE l.deleted = 0 AND l.tag_id IN (${family.map(() => "?").join(", ")}) AND ${linkedHere})`);
        params.push(...family);
      }
    }

    const entries = await this.db.all<EntryRow>(
      `SELECT e.id, e.date, ${DAY} AS day, e.title, substr(e.body, 1, ${EXCERPT_LENGTH}) AS body,
              e.created_at, e.updated_at, ${META_COLS}
       FROM entries e ${META_JOIN} WHERE ${where.join(" AND ")}
       ORDER BY day DESC, e.created_at DESC LIMIT ?`,
      [...params, opts.limit ?? 500],
    );
    return this.summarize(entries.map(toEntry));
  }

  /** 一覧の1行に要るもの（タグ・構造名・写真の数）を添える */
  private async summarize(entries: Entry[]): Promise<EntrySummary[]> {
    const ids = entries.map((e) => e.id);
    const tags = await this.tagsFor("entry", ids);
    const names = new Map<string, string[]>();
    const photos = new Map<string, number>();
    for (const part of chunk(ids, 400)) {
      const marks = part.map(() => "?").join(", ");
      const structureRows = await this.db.all<{ entry_id: string; name: string }>(
        `SELECT entry_id, name FROM structures WHERE deleted = 0 AND entry_id IN (${marks})
         ORDER BY position, created_at`,
        part,
      );
      for (const s of structureRows) names.set(s.entry_id, [...(names.get(s.entry_id) ?? []), s.name]);
      const photoRows = await this.db.all<{ entry_id: string; n: number }>(
        `SELECT entry_id, COUNT(*) AS n FROM attachments WHERE deleted = 0 AND entry_id IN (${marks})
         GROUP BY entry_id`,
        part,
      );
      for (const p of photoRows) photos.set(p.entry_id, p.n);
    }
    return entries.map((e) => ({
      ...e,
      tags: tags.get(e.id) ?? [],
      structure_names: names.get(e.id) ?? [],
      photo_count: photos.get(e.id) ?? 0,
    }));
  }

  // ---------------------------------------------------------------- 構造

  /** 何も無い構造を付ける */
  async addBlankStructure(entryId: string, name: string): Promise<string> {
    return this.insertStructure(entryId, null, name, [], []);
  }

  /** テンプレを写し取って構造として付ける。テンプレのタグも引き継ぐ。 */
  async addStructureFromTemplate(entryId: string, templateId: string): Promise<string | null> {
    await this.assertEditable(entryId);
    const template = await this.getTemplate(templateId);
    if (!template) return null;
    return this.insertStructure(
      entryId,
      template.id,
      template.name,
      template.fields,
      template.tags.map((t) => t.id),
    );
  }

  private async insertStructure(
    entryId: string,
    templateId: string | null,
    name: string,
    fields: FieldDef[],
    tagIds: string[],
  ): Promise<string> {
    await this.assertEditable(entryId);
    const id = uid();
    const t = now();
    const last = await this.db.all<{ p: number | null }>(
      `SELECT MAX(position) AS p FROM structures WHERE entry_id = ? AND deleted = 0`,
      [entryId],
    );
    await this.db.run(
      `INSERT INTO structures (id, entry_id, template_id, name, fields, vals, position, search_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
      [
        id,
        entryId,
        templateId,
        name,
        JSON.stringify(fields),
        (last[0]?.p ?? 0) + 1,
        structureSearchText(name, fields, {}),
        t,
        t,
      ],
    );
    for (const tagId of tagIds) await this.setLink("structure", id, tagId, true, t);
    this.onChange();
    return id;
  }

  updateStructure(id: string, patch: { name?: string; fields?: FieldDef[]; values?: FieldValues }): Promise<void> {
    return this.exclusive(() => this.updateStructureNow(id, patch));
  }

  private async updateStructureNow(
    id: string,
    patch: { name?: string; fields?: FieldDef[]; values?: FieldValues },
  ): Promise<void> {
    const rows = await this.db.all<StructureRow>(
      `SELECT id, entry_id, template_id, name, fields, vals, position, updated_at FROM structures WHERE id = ?`,
      [id],
    );
    if (!rows.length) return;
    // 何も変えない呼び出しは、先に並んだ保存が終わるのを待つためだけに使える
    if (patch.name === undefined && patch.fields === undefined && patch.values === undefined) return;
    await this.assertEditable(rows[0].entry_id);
    const current = toStructure(rows[0], []);
    const name = patch.name ?? current.name;
    const fields = patch.fields ?? current.fields;
    // 消された項目の値は一緒に捨てる
    const values: FieldValues = {};
    const source = patch.values ?? current.values;
    for (const f of fields) if (source[f.id] !== undefined) values[f.id] = source[f.id];
    await this.db.run(
      `UPDATE structures SET name = ?, fields = ?, vals = ?, search_text = ?, updated_at = ?, dirty = 1 WHERE id = ?`,
      [name, JSON.stringify(fields), JSON.stringify(values), structureSearchText(name, fields, values), now(), id],
    );
    this.onChange();
  }

  /** 構造を1つ上か下へ動かす */
  moveStructure(id: string, direction: -1 | 1): Promise<void> {
    return this.exclusive(() => this.moveStructureNow(id, direction));
  }

  private async moveStructureNow(id: string, direction: -1 | 1): Promise<void> {
    const rows = await this.db.all<{ entry_id: string }>(`SELECT entry_id FROM structures WHERE id = ?`, [id]);
    if (!rows.length) return;
    await this.assertEditable(rows[0].entry_id);
    const siblings = await this.db.all<{ id: string }>(
      `SELECT id FROM structures WHERE entry_id = ? AND deleted = 0 ORDER BY position, created_at`,
      [rows[0].entry_id],
    );
    const from = siblings.findIndex((s) => s.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    const order = siblings.map((s) => s.id);
    [order[from], order[to]] = [order[to], order[from]];
    const t = now();
    for (let i = 0; i < order.length; i++) {
      await this.db.run(
        `UPDATE structures SET position = ?, updated_at = ?, dirty = 1 WHERE id = ? AND position <> ?`,
        [i + 1, t, order[i], i + 1],
      );
    }
    this.onChange();
  }

  /** 構造をエントリから外す */
  async removeStructure(id: string): Promise<void> {
    await this.assertStructureEditable(id);
    const t = now();
    await this.unlinkAll("structure", id, t);
    await this.db.run(`UPDATE structures SET deleted = 1, updated_at = ?, dirty = 1 WHERE id = ?`, [t, id]);
    this.onChange();
  }

  /** いま付いている構造の項目とタグを、テンプレとして保存する */
  async saveStructureAsTemplate(structureId: string): Promise<string | null> {
    const rows = await this.db.all<StructureRow>(
      `SELECT id, entry_id, template_id, name, fields, vals, position, updated_at FROM structures WHERE id = ?`,
      [structureId],
    );
    if (!rows.length) return null;
    await this.assertEditable(rows[0].entry_id);
    const tags = (await this.tagsFor("structure", [structureId])).get(structureId) ?? [];
    const templateId = await this.createTemplate(rows[0].name, parseJson<FieldDef[]>(rows[0].fields, []));
    const t = now();
    for (const tag of tags) await this.setLink("template", templateId, tag.id, true, t);
    await this.db.run(`UPDATE structures SET template_id = ?, updated_at = ?, dirty = 1 WHERE id = ?`, [
      templateId,
      t,
      structureId,
    ]);
    this.onChange();
    return templateId;
  }

  // ---------------------------------------------------------------- テンプレ

  async createTemplate(name: string, fields: FieldDef[] = []): Promise<string> {
    const id = uid();
    const t = now();
    await this.db.run(`INSERT INTO templates (id, name, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
      id,
      name,
      JSON.stringify(fields),
      t,
      t,
    ]);
    this.onChange();
    return id;
  }

  async updateTemplate(id: string, patch: { name?: string; fields?: FieldDef[] }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push(`name = ?`);
      params.push(patch.name);
    }
    if (patch.fields !== undefined) {
      sets.push(`fields = ?`);
      params.push(JSON.stringify(patch.fields));
    }
    if (!sets.length) return;
    await this.db.run(`UPDATE templates SET ${sets.join(", ")}, updated_at = ?, dirty = 1 WHERE id = ?`, [
      ...params,
      now(),
      id,
    ]);
    this.onChange();
  }

  /** テンプレを消す。すでにエントリに付いている構造はそのまま残る。 */
  async deleteTemplate(id: string): Promise<void> {
    const t = now();
    await this.unlinkAll("template", id, t);
    await this.db.run(`UPDATE templates SET deleted = 1, updated_at = ?, dirty = 1 WHERE id = ?`, [t, id]);
    this.onChange();
  }

  async listTemplates(): Promise<Template[]> {
    const rows = await this.db.all<{ id: string; name: string; fields: string; updated_at: number }>(
      `SELECT id, name, fields, updated_at FROM templates WHERE deleted = 0 ORDER BY name, created_at`,
    );
    const tags = await this.tagsFor(
      "template",
      rows.map((r) => r.id),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      fields: parseJson<FieldDef[]>(r.fields, []),
      tags: tags.get(r.id) ?? [],
      updated_at: r.updated_at,
    }));
  }

  async getTemplate(id: string): Promise<Template | null> {
    return (await this.listTemplates()).find((t) => t.id === id) ?? null;
  }

  // ---------------------------------------------------------------- タグ

  /** 名前でタグを探し、無ければ作る（大文字小文字は区別しない） */
  findOrCreateTag(rawName: string): Promise<Tag | null> {
    return this.exclusive(() => this.findOrCreateTagNow(rawName));
  }

  private async findOrCreateTagNow(rawName: string): Promise<Tag | null> {
    const name = rawName.trim().replace(/^[#＃]/, "");
    if (!name) return null;
    const existing = await this.db.all<Tag>(
      `SELECT id, name, color FROM tags WHERE deleted = 0 AND lower(name) = lower(?) LIMIT 1`,
      [name],
    );
    if (existing.length) return existing[0];
    const count = await this.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM tags`);
    const tag: Tag = { id: uid(), name, color: TAG_COLORS[(count[0]?.n ?? 0) % TAG_COLORS.length] };
    const t = now();
    await this.db.run(`INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
      tag.id,
      tag.name,
      tag.color,
      t,
      t,
    ]);
    this.onChange();
    return tag;
  }

  async updateTag(id: string, patch: { name?: string; color?: string }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined && patch.name.trim()) {
      sets.push(`name = ?`);
      params.push(patch.name.trim());
    }
    if (patch.color !== undefined) {
      sets.push(`color = ?`);
      params.push(patch.color);
    }
    if (!sets.length) return;
    await this.db.run(`UPDATE tags SET ${sets.join(", ")}, updated_at = ?, dirty = 1 WHERE id = ?`, [
      ...params,
      now(),
      id,
    ]);
    this.onChange();
  }

  /**
   * タグを消す。そのタグの付与と、他のタグとの関係も一緒に消す。
   * ロック中の日記に付いた付与の行は書き換えない（その日記の「最終更新」を動かさないため）。
   * タグそのものが消えるので、ロック中の日記からも表示は消える。
   */
  async deleteTag(id: string): Promise<void> {
    const t = now();
    await this.db.run(
      `UPDATE tag_links AS l SET deleted = 1, updated_at = ?, dirty = 1
       WHERE l.tag_id = ? AND l.deleted = 0 AND NOT EXISTS (
         SELECT 1 FROM entry_meta m WHERE m.deleted = 0 AND m.locked = 1 AND m.id = ${linkEntry("l")})`,
      [t, id],
    );
    await this.db.run(
      `UPDATE tag_relations SET deleted = 1, updated_at = ?, dirty = 1
       WHERE (from_tag = ? OR to_tag = ?) AND deleted = 0`,
      [t, id, id],
    );
    await this.db.run(`UPDATE tags SET deleted = 1, updated_at = ?, dirty = 1 WHERE id = ?`, [t, id]);
    this.onChange();
  }

  /** 全タグを、親・関連・使用数つきで返す */
  async listTags(): Promise<TagInfo[]> {
    const tags = await this.db.all<Tag>(`SELECT id, name, color FROM tags WHERE deleted = 0 ORDER BY name`);
    const alive = new Set(tags.map((t) => t.id));
    const relations = await this.db.all<{ from_tag: string; to_tag: string; kind: string }>(
      `SELECT from_tag, to_tag, kind FROM tag_relations WHERE deleted = 0`,
    );
    const counts = await this.db.all<{ tag_id: string; n: number }>(
      `SELECT l.tag_id, COUNT(*) AS n FROM tag_links l
       WHERE l.deleted = 0 AND l.target_type IN ('entry', 'structure') AND NOT EXISTS (
         SELECT 1 FROM entry_meta m WHERE m.deleted = 0 AND m.trashed_at IS NOT NULL AND m.id = ${linkEntry("l")})
       GROUP BY l.tag_id`,
    );
    const info = new Map<string, TagInfo>(
      tags.map((t) => [t.id, { ...t, parent_id: null, related_ids: [], use_count: 0 }]),
    );
    for (const r of relations) {
      if (!alive.has(r.from_tag) || !alive.has(r.to_tag)) continue;
      if (r.kind === "parent") {
        info.get(r.from_tag)!.parent_id = r.to_tag;
      } else {
        info.get(r.from_tag)!.related_ids.push(r.to_tag);
        info.get(r.to_tag)!.related_ids.push(r.from_tag);
      }
    }
    for (const c of counts) {
      const tag = info.get(c.tag_id);
      if (tag) tag.use_count = c.n;
    }
    return [...info.values()];
  }

  /**
   * 親タグを決める（null で親なしに戻す）。
   * 自分自身や自分の子孫を親にすると輪になるので、その場合は何もせず false を返す。
   */
  setTagParent(tagId: string, parentId: string | null): Promise<boolean> {
    return this.exclusive(() => this.setTagParentNow(tagId, parentId));
  }

  private async setTagParentNow(tagId: string, parentId: string | null): Promise<boolean> {
    if (parentId !== null) {
      if (parentId === tagId) return false;
      if (descendants(await this.childrenMap(), tagId).includes(parentId)) return false;
    }
    await this.db.run(
      `INSERT INTO tag_relations (id, from_tag, to_tag, kind, updated_at, deleted, dirty)
       VALUES (?, ?, ?, 'parent', ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET to_tag = excluded.to_tag, updated_at = excluded.updated_at,
         deleted = excluded.deleted, dirty = 1`,
      [`parent:${tagId}`, tagId, parentId ?? "", now(), parentId === null ? 1 : 0],
    );
    this.onChange();
    return true;
  }

  /** 2つのタグを「関連」として結ぶ／解く。向きは無い。 */
  async setTagsRelated(a: string, b: string, related: boolean): Promise<void> {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    await this.db.run(
      `INSERT INTO tag_relations (id, from_tag, to_tag, kind, updated_at, deleted, dirty)
       VALUES (?, ?, ?, 'related', ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted, dirty = 1`,
      [`related:${x}:${y}`, x, y, now(), related ? 0 : 1],
    );
    this.onChange();
  }

  /** エントリ・構造・テンプレにタグを付ける／外す */
  async setTagLinked(type: TagTarget, targetId: string, tagId: string, linked: boolean): Promise<void> {
    if (type === "entry") await this.assertEditable(targetId);
    if (type === "structure") await this.assertStructureEditable(targetId);
    await this.setLink(type, targetId, tagId, linked, now());
    // 付与は独立した行として同期するので、対象のエントリ自体の更新時刻は動かさない
    this.onChange();
  }

  private async setLink(type: TagTarget, targetId: string, tagId: string, linked: boolean, t: number): Promise<void> {
    await this.db.run(
      `INSERT INTO tag_links (id, tag_id, target_type, target_id, updated_at, deleted, dirty)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted, dirty = 1`,
      [`${type}:${targetId}:${tagId}`, tagId, type, targetId, t, linked ? 0 : 1],
    );
  }

  private async unlinkAll(type: TagTarget, targetId: string, t: number): Promise<void> {
    await this.db.run(
      `UPDATE tag_links SET deleted = 1, updated_at = ?, dirty = 1
       WHERE target_type = ? AND target_id = ? AND deleted = 0`,
      [t, type, targetId],
    );
  }

  private async tagsFor(type: TagTarget, ids: string[]): Promise<Map<string, Tag[]>> {
    const out = new Map<string, Tag[]>();
    for (const part of chunk(ids, 400)) {
      const rows = await this.db.all<Tag & { target_id: string }>(
        `SELECT l.target_id, t.id, t.name, t.color FROM tag_links l JOIN tags t ON t.id = l.tag_id
         WHERE l.deleted = 0 AND t.deleted = 0 AND l.target_type = ?
           AND l.target_id IN (${part.map(() => "?").join(", ")})
         ORDER BY t.name`,
        [type, ...part],
      );
      for (const { target_id, ...tag } of rows) out.set(target_id, [...(out.get(target_id) ?? []), tag]);
    }
    return out;
  }

  /** 親タグID → 子タグIDの一覧 */
  private async childrenMap(): Promise<Map<string, string[]>> {
    const rows = await this.db.all<{ from_tag: string; to_tag: string }>(
      `SELECT from_tag, to_tag FROM tag_relations WHERE deleted = 0 AND kind = 'parent'`,
    );
    const map = new Map<string, string[]>();
    for (const r of rows) map.set(r.to_tag, [...(map.get(r.to_tag) ?? []), r.from_tag]);
    return map;
  }

  // ---------------------------------------------------------------- 写真

  async addAttachment(
    entryId: string,
    image: { mime: string; width: number; height: number; data: string },
  ): Promise<string> {
    await this.assertEditable(entryId);
    const id = uid();
    const t = now();
    const last = await this.db.all<{ p: number | null }>(
      `SELECT MAX(position) AS p FROM attachments WHERE entry_id = ? AND deleted = 0`,
      [entryId],
    );
    await this.db.run(
      `INSERT INTO attachments (id, entry_id, mime, width, height, position, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, entryId, image.mime, image.width, image.height, (last[0]?.p ?? 0) + 1, image.data, t, t],
    );
    this.onChange();
    return id;
  }

  async removeAttachment(id: string): Promise<void> {
    await this.assertAttachmentEditable(id);
    await this.db.run(`UPDATE attachments SET deleted = 1, data = NULL, updated_at = ?, dirty = 1 WHERE id = ?`, [
      now(),
      id,
    ]);
    this.onChange();
  }

  async listAttachments(entryId: string): Promise<AttachmentMeta[]> {
    const rows = await this.db.all<Omit<AttachmentMeta, "has_data"> & { has_data: number }>(
      `SELECT id, entry_id, mime, width, height, position, data IS NOT NULL AS has_data
       FROM attachments WHERE entry_id = ? AND deleted = 0 ORDER BY position, created_at`,
      [entryId],
    );
    return rows.map((r) => ({ ...r, has_data: !!r.has_data }));
  }

  /** 画像を data URL で返す。まだこの端末に届いていなければ null。 */
  async getAttachmentUrl(id: string): Promise<string | null> {
    const rows = await this.db.all<{ mime: string; data: string | null }>(
      `SELECT mime, data FROM attachments WHERE id = ? AND deleted = 0`,
      [id],
    );
    if (!rows.length || rows[0].data === null) return null;
    return `data:${rows[0].mime};base64,${rows[0].data}`;
  }
}

function toStructure(row: StructureRow, tags: Tag[]): Structure {
  return {
    id: row.id,
    entry_id: row.entry_id,
    template_id: row.template_id,
    name: row.name,
    fields: parseJson<FieldDef[]>(row.fields, []),
    values: parseJson<FieldValues>(row.vals, {}),
    position: row.position,
    tags,
    updated_at: row.updated_at,
  };
}

/** あるタグの子孫すべて。壊れたデータで輪があっても止まるよう、見たものは飛ばす。 */
export function descendants(children: Map<string, string[]>, rootId: string): string[] {
  const seen = new Set<string>([rootId]);
  const out: string[] = [];
  const queue = [...(children.get(rootId) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return out;
}
