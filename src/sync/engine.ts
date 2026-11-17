import type { Driver } from "../db/driver";
import { getMeta, setMeta } from "../db/schema";
import type { FieldDef, FieldValues } from "../db/types";
import { parseJson, structureSearchText } from "../db/util";
import type { OutgoingRecord, Remote, RemoteRecord } from "./remote";

interface TableSpec {
  kind: string;
  table: string;
  /** 同期する列。id / updated_at / deleted は全表共通なので含めない。 */
  cols: string[];
  /** 端末内ではJSON文字列、クラウドではJSONそのものとして持つ列 */
  json?: string[];
}

export const TABLES: TableSpec[] = [
  { kind: "entry", table: "entries", cols: ["date", "title", "body", "created_at"] },
  { kind: "template", table: "templates", cols: ["name", "fields", "created_at"], json: ["fields"] },
  {
    kind: "structure",
    table: "structures",
    cols: ["entry_id", "template_id", "name", "fields", "vals", "position", "created_at"],
    json: ["fields", "vals"],
  },
  { kind: "tag", table: "tags", cols: ["name", "color", "created_at"] },
  { kind: "tag_link", table: "tag_links", cols: ["tag_id", "target_type", "target_id"] },
  { kind: "tag_relation", table: "tag_relations", cols: ["from_tag", "to_tag", "kind"] },
  {
    kind: "attachment",
    table: "attachments",
    cols: ["entry_id", "mime", "width", "height", "position", "created_at"],
  },
  { kind: "entry_meta", table: "entry_meta", cols: ["locked", "trashed_at"] },
];

const BY_KIND = new Map(TABLES.map((t) => [t.kind, t]));
const PAGE = 500;
const PUSH_BATCH = 100;
const CURSOR_KEY = "sync_cursor";

export interface SyncResult {
  pulled: number;
  pushed: number;
  /** 受け取った行で端末内のデータが実際に変わったか */
  changed: boolean;
}

/**
 * 同期を1回行う。順番は「受け取る → 画像を上げる → 送る → 画像を下ろす」。
 * 衝突は行ごとに updated_at の新しい方を採用する。
 */
export async function syncOnce(db: Driver, remote: Remote): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, changed: false };

  // 1. 受け取る
  let cursor = Number((await getMeta(db, CURSOR_KEY)) ?? "0");
  for (;;) {
    const page = await remote.pull(cursor, PAGE);
    for (const record of page) {
      try {
        if (await applyRemote(db, record)) result.changed = true;
      } catch (error) {
        // 形の壊れた1行のせいで同期全体が止まり続けないよう、その行だけ飛ばす
        console.warn("同期: 行を反映できませんでした", record.kind, record.id, error);
      }
      cursor = Math.max(cursor, record.seq);
    }
    result.pulled += page.length;
    if (page.length) await setMeta(db, CURSOR_KEY, String(cursor));
    if (page.length < PAGE) break;
  }

  // 2. 画像の中身を先に上げる。行だけ先に届いて中身が無い、という状態を他の端末に見せないため。
  const toUpload = await db.all<{ id: string; mime: string; data: string }>(
    `SELECT id, mime, data FROM attachments WHERE deleted = 0 AND uploaded = 0 AND data IS NOT NULL`,
  );
  for (const a of toUpload) {
    await remote.uploadBlob(a.id, a.data, a.mime);
    await db.run(`UPDATE attachments SET uploaded = 1 WHERE id = ?`, [a.id]);
  }

  // 3. 送る
  for (const spec of TABLES) {
    for (;;) {
      const rows = await db.all<Record<string, unknown>>(
        `SELECT id, updated_at, deleted, ${spec.cols.join(", ")} FROM ${spec.table}
         WHERE dirty = 1 ORDER BY updated_at LIMIT ${PUSH_BATCH}`,
      );
      if (!rows.length) break;
      await remote.push(rows.map((row) => toRecord(spec, row)));
      // 送っている間に編集された行は updated_at が進んでいるので、未送信のまま残る
      for (const row of rows) {
        await db.run(`UPDATE ${spec.table} SET dirty = 0 WHERE id = ? AND updated_at = ?`, [row.id, row.updated_at]);
      }
      result.pushed += rows.length;
      if (rows.length < PUSH_BATCH) break;
    }
  }

  // 4. 消した画像の中身をクラウドからも消す
  const toDelete = await db.all<{ id: string }>(`SELECT id FROM attachments WHERE deleted = 1 AND uploaded = 1`);
  for (const a of toDelete) {
    await remote.deleteBlob(a.id);
    await db.run(`UPDATE attachments SET uploaded = 0 WHERE id = ?`, [a.id]);
  }

  // 5. まだ手元に無い画像の中身を下ろす
  const toDownload = await db.all<{ id: string }>(`SELECT id FROM attachments WHERE deleted = 0 AND data IS NULL`);
  for (const a of toDownload) {
    const data = await remote.downloadBlob(a.id);
    if (data === null) continue;
    await db.run(`UPDATE attachments SET data = ?, uploaded = 1 WHERE id = ? AND deleted = 0`, [data, a.id]);
    result.changed = true;
  }

  return result;
}

function toRecord(spec: TableSpec, row: Record<string, unknown>): OutgoingRecord {
  const data: Record<string, unknown> = {};
  for (const col of spec.cols) {
    data[col] = spec.json?.includes(col) ? parseJson<unknown>(row[col], null) : row[col];
  }
  return { kind: spec.kind, id: String(row.id), data, updated_at: Number(row.updated_at), deleted: !!row.deleted };
}

/** クラウドから来た1行を端末内に反映する。反映したら true。 */
async function applyRemote(db: Driver, record: RemoteRecord): Promise<boolean> {
  const spec = BY_KIND.get(record.kind);
  if (!spec) return false; // 新しい版のアプリが作った、まだ知らない種類の行

  const local = await db.all<{ updated_at: number; dirty: number }>(
    `SELECT updated_at, dirty FROM ${spec.table} WHERE id = ?`,
    [record.id],
  );
  if (local.length) {
    // 手元に未送信の変更があり、それが相手以上に新しければ手元を残す
    if (local[0].dirty && local[0].updated_at >= record.updated_at) return false;
    // 自分が送った行がそのまま戻ってきただけ
    if (!local[0].dirty && local[0].updated_at === record.updated_at) return false;
  }

  const values: Record<string, unknown> = {};
  for (const col of spec.cols) {
    const v = record.data[col];
    values[col] = spec.json?.includes(col) ? JSON.stringify(v ?? null) : (v ?? null);
  }
  if (spec.kind === "structure") {
    values.search_text = structureSearchText(
      String(record.data.name ?? ""),
      (record.data.fields as FieldDef[] | null) ?? [],
      (record.data.vals as FieldValues | null) ?? {},
    );
  }
  values.updated_at = record.updated_at;
  values.deleted = record.deleted ? 1 : 0;
  values.dirty = 0;

  const cols = Object.keys(values);
  if (local.length) {
    await db.run(`UPDATE ${spec.table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [
      ...cols.map((c) => values[c]),
      record.id,
    ]);
    if (spec.kind === "attachment" && record.deleted) {
      await db.run(`UPDATE attachments SET data = NULL WHERE id = ?`, [record.id]);
    }
  } else {
    // 他の端末から来た画像は、中身がすでにクラウドにある前提で uploaded=1 にしておく
    if (spec.kind === "attachment") values.uploaded = 1;
    const all = ["id", ...Object.keys(values)];
    await db.run(`INSERT INTO ${spec.table} (${all.join(", ")}) VALUES (${all.map(() => "?").join(", ")})`, [
      record.id,
      ...Object.keys(values).map((c) => values[c]),
    ]);
  }
  return true;
}

/**
 * 同期する相手のアカウントが変わったときに呼ぶ。
 * 受け取り位置を最初に戻し、手元の全行を未送信に戻す。手元のデータは消えず、新しいアカウント側へ合流する。
 */
export async function resetSyncState(db: Driver): Promise<void> {
  await setMeta(db, CURSOR_KEY, "0");
  for (const spec of TABLES) await db.run(`UPDATE ${spec.table} SET dirty = 1`);
  await db.run(`UPDATE attachments SET uploaded = 0 WHERE data IS NOT NULL`);
}
