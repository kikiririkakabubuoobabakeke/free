import type { Driver } from "./driver";
import {
  TAG_COLORS,
  type Analysis,
  type AnalysisResult,
  type AttachmentMeta,
  type PlanIdea,
  type Review,
  type DayStat,
  type Plan,
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
import { chunk, hashText, likePattern, now, parseJson, structureSearchText, uid } from "./util";

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

/**
 * 日記の「中身」を最後に変えた時刻。日付・題・本文と構造だけを見る（タグや写真、ロックは含めない）。
 * 分析の結果がこれより古ければ、分析し直す対象になる。
 */
const CONTENT_AT = `max(
  e.updated_at,
  coalesce((SELECT max(s.updated_at) FROM structures s WHERE s.entry_id = e.id), 0)
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

/** 分析に渡す日記の中身 */
export interface AnalysisSource {
  id: string;
  /** 並べる日（YYYY-MM-DD） */
  day: string;
  title: string;
  body: string;
  structures: { name: string; fields: { label: string; value: string }[] }[];
  /** 日記と、その構造に付いているタグの名前 */
  tags: string[];
  content_at: number;
}

/** 振り返りに渡す、1週間分の日記と分析 */
export interface WeekEntry {
  id: string;
  day: string;
  title: string;
  body: string;
  content_at: number;
  /** 分析が済んでいて、その後に書き換えられていなければ true */
  analyzed: boolean;
  summary: string;
  mood: number | null;
  emotions: string[];
  topics: string[];
}

/** 週の日記の並びと中身の更新時刻から作る指紋。振り返りを作った後に日記が変われば、値が変わる。 */
export function weekSourceHash(entries: WeekEntry[]): string {
  return hashText(JSON.stringify(entries.map((e) => [e.id, e.day, e.content_at])));
}

interface AnalysisRow {
  id: string;
  model: string;
  summary: string;
  mood: number | null;
  emotions: string;
  topics: string;
  tag_ideas: string;
  plan_ideas: string;
  dismissed: string;
  analyzed_at: number;
  stale: number;
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
    await this.db.run(`UPDATE analyses SET deleted = 1, updated_at = ?, dirty = 1 WHERE id = ? AND deleted = 0`, [t, id]);
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

  // ---------------------------------------------------------------- カレンダー

  /**
   * from〜to（YYYY-MM-DD、両端を含む）の日ごとの日記の数と文字数。日記の無い日は入らない。
   * 日は一覧と同じ「並べる日」（付けた日付、無ければ作成した日）で数える。
   */
  async dayStats(from: string, to: string): Promise<Map<string, DayStat>> {
    const rows = await this.db.all<{ day: string; entries: number; chars: number }>(
      `SELECT day, COUNT(*) AS entries, SUM(chars) AS chars FROM (
         SELECT ${DAY} AS day,
                length(replace(replace(e.title || e.body, char(10), ''), char(13), '')) AS chars
         FROM entries e ${META_JOIN}
         WHERE e.deleted = 0 AND m.trashed_at IS NULL
       ) WHERE day BETWEEN ? AND ? GROUP BY day`,
      [from, to],
    );
    return new Map(rows.map((r) => [r.day, { entries: r.entries, chars: r.chars ?? 0 }]));
  }

  /** 日記を書いた日（新しい順）。続けて書いている日数を数えるのに使う。 */
  async writtenDays(): Promise<string[]> {
    const rows = await this.db.all<{ day: string }>(
      `SELECT DISTINCT ${DAY} AS day FROM entries e ${META_JOIN}
       WHERE e.deleted = 0 AND m.trashed_at IS NULL ORDER BY day DESC`,
    );
    return rows.map((r) => r.day);
  }

  /** その日に並ぶ日記（一覧と同じ形。ゴミ箱の中は除く） */
  async entriesOnDay(day: string): Promise<EntrySummary[]> {
    const rows = await this.db.all<EntryRow>(
      `SELECT * FROM (
         SELECT e.id, e.date, ${DAY} AS day, e.title, substr(e.body, 1, ${EXCERPT_LENGTH}) AS body,
                e.created_at, e.updated_at, ${META_COLS}
         FROM entries e ${META_JOIN} WHERE e.deleted = 0 AND m.trashed_at IS NULL
       ) WHERE day = ? ORDER BY created_at`,
      [day],
    );
    return this.summarize(rows.map(toEntry));
  }

  // ---------------------------------------------------------------- 予定

  async createPlan(date: string, plan: { time?: string; title?: string } = {}): Promise<string> {
    const id = uid();
    const t = now();
    await this.db.run(
      `INSERT INTO plans (id, date, time, title, done, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [id, date, plan.time ?? "", plan.title ?? "", t, t],
    );
    this.onChange();
    return id;
  }

  async updatePlan(id: string, patch: Partial<Omit<Plan, "id">>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of ["date", "time", "title"] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(patch[key]);
      }
    }
    if (patch.done !== undefined) {
      sets.push(`done = ?`);
      params.push(patch.done ? 1 : 0);
    }
    if (!sets.length) return;
    await this.db.run(`UPDATE plans SET ${sets.join(", ")}, updated_at = ?, dirty = 1 WHERE id = ?`, [
      ...params,
      now(),
      id,
    ]);
    this.onChange();
  }

  /** 予定を消す（restorePlan で元に戻せる） */
  async deletePlan(id: string): Promise<void> {
    await this.db.run(`UPDATE plans SET deleted = 1, updated_at = ?, dirty = 1 WHERE id = ?`, [now(), id]);
    this.onChange();
  }

  async restorePlan(id: string): Promise<void> {
    await this.db.run(`UPDATE plans SET deleted = 0, updated_at = ?, dirty = 1 WHERE id = ?`, [now(), id]);
    this.onChange();
  }

  /** from〜to（両端を含む）の予定。日付、時刻（終日が先）、作った順。 */
  async listPlans(from: string, to: string): Promise<Plan[]> {
    const rows = await this.db.all<Omit<Plan, "done"> & { done: number }>(
      `SELECT id, date, time, title, done FROM plans
       WHERE deleted = 0 AND date BETWEEN ? AND ? ORDER BY date, time, created_at`,
      [from, to],
    );
    return rows.map((r) => ({ ...r, done: !!r.done }));
  }

  // ---------------------------------------------------------------- ローカルLLMの分析

  /**
   * 分析し直す必要のある日記の id。新しい日のものが先。
   * settledBefore より後に書き換えられたもの（まだ書いている途中かもしれないもの）は除く。
   */
  async analysisQueue(opts: { settledBefore: number; limit: number }): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT e.id FROM entries e ${META_JOIN}
       LEFT JOIN analyses a ON a.id = e.id AND a.deleted = 0
       WHERE e.deleted = 0 AND m.trashed_at IS NULL
         AND (a.id IS NULL OR a.content_at < ${CONTENT_AT})
         AND ${CONTENT_AT} <= ?
       ORDER BY ${DAY} DESC, e.created_at DESC LIMIT ?`,
      [opts.settledBefore, opts.limit],
    );
    return rows.map((r) => r.id);
  }

  /** 分析がまだの日記（書いている途中のものも含む）の数 */
  async analysisPending(): Promise<number> {
    const rows = await this.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entries e ${META_JOIN}
       LEFT JOIN analyses a ON a.id = e.id AND a.deleted = 0
       WHERE e.deleted = 0 AND m.trashed_at IS NULL AND (a.id IS NULL OR a.content_at < ${CONTENT_AT})`,
    );
    return rows[0]?.n ?? 0;
  }

  /** 分析に渡す日記の中身。ゴミ箱の中や、無い日記なら null。 */
  async analysisSource(id: string): Promise<AnalysisSource | null> {
    const rows = await this.db.all<{ id: string; day: string; title: string; body: string; content_at: number }>(
      `SELECT e.id, ${DAY} AS day, e.title, e.body, ${CONTENT_AT} AS content_at
       FROM entries e ${META_JOIN} WHERE e.id = ? AND e.deleted = 0 AND m.trashed_at IS NULL`,
      [id],
    );
    if (!rows.length) return null;
    const detail = await this.getEntry(id);
    if (!detail) return null;
    const tagNames = new Set<string>(detail.tags.map((t) => t.name));
    const structures = detail.structures.map((st) => {
      for (const t of st.tags) tagNames.add(t.name);
      const fields: { label: string; value: string }[] = [];
      for (const f of st.fields) {
        const v = st.values[f.id];
        if (v === null || v === undefined || v === "") continue;
        let value: string;
        if (f.type === "check") {
          if (v !== true) continue;
          value = "はい";
        } else if (f.type === "rating") {
          value = `${v} / 5`;
        } else {
          value = String(v);
        }
        fields.push({ label: f.label || "（名前なし）", value });
      }
      return { name: st.name, fields };
    });
    return { ...rows[0], structures, tags: [...tagNames] };
  }

  /** 分析の結果を保存する。日記の中身には触れないので、日記の「最終更新」は動かない。 */
  async saveAnalysis(
    id: string,
    result: AnalysisResult,
    meta: { sourceHash: string; contentAt: number; model: string },
  ): Promise<void> {
    const t = now();
    await this.db.run(
      `INSERT INTO analyses (id, source_hash, content_at, model, summary, mood, emotions, topics, tag_ideas, plan_ideas,
                             dismissed, analyzed_at, updated_at, deleted, dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 0, 1)
       ON CONFLICT(id) DO UPDATE SET
         source_hash = excluded.source_hash, content_at = excluded.content_at, model = excluded.model,
         summary = excluded.summary, mood = excluded.mood, emotions = excluded.emotions, topics = excluded.topics,
         tag_ideas = excluded.tag_ideas, plan_ideas = excluded.plan_ideas,
         dismissed = CASE WHEN analyses.deleted = 1 THEN '[]' ELSE analyses.dismissed END,
         analyzed_at = excluded.analyzed_at, updated_at = excluded.updated_at, deleted = 0, dirty = 1`,
      [
        id,
        meta.sourceHash,
        meta.contentAt,
        meta.model,
        result.summary,
        result.mood,
        JSON.stringify(result.emotions),
        JSON.stringify(result.topics),
        JSON.stringify(result.tag_ideas),
        JSON.stringify(result.plan_ideas),
        t,
        t,
      ],
    );
    this.onChange();
  }

  /** 前に分析したときの中身の指紋（無ければ null） */
  async analysisHash(id: string): Promise<string | null> {
    const rows = await this.db.all<{ source_hash: string }>(
      `SELECT source_hash FROM analyses WHERE id = ? AND deleted = 0`,
      [id],
    );
    return rows.length ? rows[0].source_hash : null;
  }

  /** 中身が前の分析と同じだったときに、分析し直さずに「確かめた時刻」だけ進める */
  async touchAnalysis(id: string, contentAt: number): Promise<void> {
    await this.db.run(
      `UPDATE analyses SET content_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted = 0`,
      [contentAt, now(), id],
    );
    this.onChange();
  }

  async getAnalysis(id: string): Promise<Analysis | null> {
    const rows = await this.db.all<AnalysisRow>(
      `SELECT a.id, a.model, a.summary, a.mood, a.emotions, a.topics, a.tag_ideas, a.plan_ideas, a.dismissed,
              a.analyzed_at, (a.content_at < ${CONTENT_AT}) AS stale
       FROM analyses a JOIN entries e ON e.id = a.id
       WHERE a.id = ? AND a.deleted = 0 AND e.deleted = 0`,
      [id],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      entry_id: r.id,
      model: r.model,
      summary: r.summary,
      mood: r.mood,
      emotions: parseJson<string[]>(r.emotions, []),
      topics: parseJson<string[]>(r.topics, []),
      tag_ideas: parseJson<string[]>(r.tag_ideas, []),
      plan_ideas: parseJson<PlanIdea[]>(r.plan_ideas, []),
      dismissed: parseJson<string[]>(r.dismissed, []),
      analyzed_at: r.analyzed_at,
      stale: !!r.stale,
    };
  }

  /** 候補を「要らない」として外す（日記には触れない） */
  async dismissIdea(id: string, key: string): Promise<void> {
    const rows = await this.db.all<{ dismissed: string }>(
      `SELECT dismissed FROM analyses WHERE id = ? AND deleted = 0`,
      [id],
    );
    if (!rows.length) return;
    const dismissed = new Set(parseJson<string[]>(rows[0].dismissed, []));
    dismissed.add(key);
    await this.db.run(`UPDATE analyses SET dismissed = ?, updated_at = ?, dirty = 1 WHERE id = ?`, [
      JSON.stringify([...dismissed]),
      now(),
      id,
    ]);
    this.onChange();
  }

  /** 分析の結果（と、振り返り）をすべて捨てる。順に分析し直される。 */
  async clearAnalyses(opts: { reviews?: boolean } = {}): Promise<void> {
    const t = now();
    await this.db.run(`UPDATE analyses SET deleted = 1, updated_at = ?, dirty = 1 WHERE deleted = 0`, [t]);
    if (opts.reviews) await this.db.run(`UPDATE reviews SET deleted = 1, updated_at = ?, dirty = 1 WHERE deleted = 0`, [t]);
    this.onChange();
  }

  /** from〜to の日ごとの気分の平均（分析が済んでいて、気分が読み取れた日記だけ） */
  async moodByDay(from: string, to: string): Promise<Map<string, { mood: number; entries: number }>> {
    const rows = await this.db.all<{ day: string; mood: number; n: number }>(
      `SELECT day, AVG(mood) AS mood, COUNT(*) AS n FROM (
         SELECT ${DAY} AS day, a.mood AS mood FROM entries e ${META_JOIN}
         JOIN analyses a ON a.id = e.id AND a.deleted = 0
         WHERE e.deleted = 0 AND m.trashed_at IS NULL AND a.mood IS NOT NULL
       ) WHERE day BETWEEN ? AND ? GROUP BY day`,
      [from, to],
    );
    return new Map(rows.map((r) => [r.day, { mood: r.mood, entries: r.n }]));
  }

  /** from〜to の日記に出てきた感情と、その回数（多い順） */
  async emotionCounts(from: string, to: string): Promise<{ emotion: string; count: number }[]> {
    const rows = await this.db.all<{ emotions: string }>(
      `SELECT emotions FROM (
         SELECT ${DAY} AS day, a.emotions AS emotions FROM entries e ${META_JOIN}
         JOIN analyses a ON a.id = e.id AND a.deleted = 0
         WHERE e.deleted = 0 AND m.trashed_at IS NULL
       ) WHERE day BETWEEN ? AND ?`,
      [from, to],
    );
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const e of new Set(parseJson<string[]>(r.emotions, []))) counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    return [...counts]
      .map(([emotion, count]) => ({ emotion, count }))
      .sort((a, b) => b.count - a.count || a.emotion.localeCompare(b.emotion));
  }

  /** start〜end の日記と、その分析（振り返りの材料） */
  async weekEntries(start: string, end: string): Promise<WeekEntry[]> {
    const rows = await this.db.all<
      Omit<WeekEntry, "analyzed" | "emotions" | "topics" | "summary"> & {
        analyzed: number;
        summary: string | null;
        emotions: string | null;
        topics: string | null;
      }
    >(
      `SELECT * FROM (
         SELECT e.id, ${DAY} AS day, e.title, e.body, e.created_at, ${CONTENT_AT} AS content_at,
                (a.id IS NOT NULL AND a.content_at >= ${CONTENT_AT}) AS analyzed,
                a.summary AS summary, a.mood AS mood, a.emotions AS emotions, a.topics AS topics
         FROM entries e ${META_JOIN} LEFT JOIN analyses a ON a.id = e.id AND a.deleted = 0
         WHERE e.deleted = 0 AND m.trashed_at IS NULL
       ) WHERE day BETWEEN ? AND ? ORDER BY day, created_at`,
      [start, end],
    );
    return rows.map((r) => ({
      id: r.id,
      day: r.day,
      title: r.title,
      body: r.body,
      content_at: r.content_at,
      analyzed: !!r.analyzed,
      summary: r.summary ?? "",
      mood: r.mood ?? null,
      emotions: parseJson<string[]>(r.emotions, []),
      topics: parseJson<string[]>(r.topics, []),
    }));
  }

  /** 週の振り返り。作っていなければ null。 */
  async getReview(start: string): Promise<Review | null> {
    const rows = await this.db.all<{
      id: string;
      period_start: string;
      period_end: string;
      source_hash: string;
      model: string;
      title: string;
      body: string;
      mood_note: string;
      highlights: string;
      created_at: number;
    }>(
      `SELECT id, period_start, period_end, source_hash, model, title, body, mood_note, highlights, created_at
       FROM reviews WHERE id = ? AND deleted = 0`,
      [`week:${start}`],
    );
    if (!rows.length) return null;
    const { source_hash, highlights, ...r } = rows[0];
    const entries = await this.weekEntries(r.period_start, r.period_end);
    return {
      ...r,
      highlights: parseJson<{ date: string; text: string }[]>(highlights, []),
      stale: weekSourceHash(entries) !== source_hash,
    };
  }

  /** いちばん新しい振り返りの週の始まり。1つも無ければ null。 */
  async latestReviewStart(): Promise<string | null> {
    const rows = await this.db.all<{ period_start: string }>(
      `SELECT period_start FROM reviews WHERE deleted = 0 ORDER BY period_start DESC LIMIT 1`,
    );
    return rows.length ? rows[0].period_start : null;
  }

  async saveReview(
    start: string,
    end: string,
    review: { title: string; body: string; mood_note: string; highlights: { date: string; text: string }[] },
    meta: { sourceHash: string; model: string },
  ): Promise<void> {
    const t = now();
    await this.db.run(
      `INSERT INTO reviews (id, period_start, period_end, source_hash, model, title, body, mood_note, highlights,
                            created_at, updated_at, deleted, dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
       ON CONFLICT(id) DO UPDATE SET
         period_end = excluded.period_end, source_hash = excluded.source_hash, model = excluded.model,
         title = excluded.title, body = excluded.body, mood_note = excluded.mood_note,
         highlights = excluded.highlights, created_at = excluded.created_at, updated_at = excluded.updated_at,
         deleted = 0, dirty = 1`,
      [
        `week:${start}`,
        start,
        end,
        meta.sourceHash,
        meta.model,
        review.title,
        review.body,
        review.mood_note,
        JSON.stringify(review.highlights),
        t,
        t,
      ],
    );
    this.onChange();
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
