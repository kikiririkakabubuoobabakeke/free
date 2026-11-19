import type { Driver } from "./driver";

/**
 * 端末内のスキーマ。
 * 同期対象の表は共通して updated_at(ミリ秒) / deleted(削除済みの印) / dirty(未送信の印) を持つ。
 * 行は物理的には消さず deleted=1 にする。削除を他の端末へ伝えるため。
 */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE INDEX entries_date ON entries(date DESC, created_at DESC)`,

    `CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fields TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,

    // search_text は検索用にこの端末で作る派生の値で、同期はしない。
    `CREATE TABLE structures (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      template_id TEXT,
      name TEXT NOT NULL,
      fields TEXT NOT NULL DEFAULT '[]',
      vals TEXT NOT NULL DEFAULT '{}',
      position REAL NOT NULL DEFAULT 0,
      search_text TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE INDEX structures_entry ON structures(entry_id)`,

    `CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,

    // id は "種類:対象:タグ" から決まる。同じ付与を2台で行っても1行にまとまる。
    `CREATE TABLE tag_links (
      id TEXT PRIMARY KEY,
      tag_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE INDEX tag_links_target ON tag_links(target_type, target_id)`,
    `CREATE INDEX tag_links_tag ON tag_links(tag_id)`,

    // kind='parent' は from_tag が子・to_tag が親。kind='related' は向きのない関連。
    `CREATE TABLE tag_relations (
      id TEXT PRIMARY KEY,
      from_tag TEXT NOT NULL,
      to_tag TEXT NOT NULL,
      kind TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,

    // data は画像のbase64。data と uploaded はこの端末だけの状態で、同期されるのはそれ以外。
    `CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      mime TEXT NOT NULL,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0,
      data TEXT,
      uploaded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE INDEX attachments_entry ON attachments(entry_id)`,
  ],
  [
    // 日記ごとの状態（ロック・ゴミ箱）。id は日記の id と同じ。
    // 日記の行とは別に持つことで、ロックやゴミ箱への出し入れが「最終更新」を動かさないようにしている。
    // 行が無い日記は「ロックなし・ゴミ箱に入っていない」として扱う。
    `CREATE TABLE entry_meta (
      id TEXT PRIMARY KEY,
      locked INTEGER NOT NULL DEFAULT 0,
      trashed_at INTEGER,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,
  ],
  [
    // 予定。date は YYYY-MM-DD、time は "HH:MM" か空文字（終日）。
    `CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      time TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE INDEX plans_date ON plans(date)`,
  ],
  [
    // ローカルLLMによる日記ごとの分析。id は日記の id と同じ。日記の中身からいつでも作り直せる、派生した値。
    // content_at は分析した時点の「日記の中身の更新時刻」。日記の方が新しければ、分析し直す対象になる。
    `CREATE TABLE analyses (
      id TEXT PRIMARY KEY,
      source_hash TEXT NOT NULL DEFAULT '',
      content_at INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      mood INTEGER,
      emotions TEXT NOT NULL DEFAULT '[]',
      topics TEXT NOT NULL DEFAULT '[]',
      tag_ideas TEXT NOT NULL DEFAULT '[]',
      plan_ideas TEXT NOT NULL DEFAULT '[]',
      dismissed TEXT NOT NULL DEFAULT '[]',
      analyzed_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,
    // 週の振り返り。id は "week:週の始まりの日曜日"。
    `CREATE TABLE reviews (
      id TEXT PRIMARY KEY,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      source_hash TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      mood_note TEXT NOT NULL DEFAULT '',
      highlights TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 1
    )`,
  ],
];

export async function migrate(db: Driver): Promise<void> {
  await db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const rows = await db.all<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`);
  let version = rows.length ? Number(rows[0].value) : 0;
  while (version < MIGRATIONS.length) {
    for (const sql of MIGRATIONS[version]) await db.run(sql);
    version += 1;
    await setMeta(db, "schema_version", String(version));
  }
}

export async function getMeta(db: Driver, key: string): Promise<string | null> {
  const rows = await db.all<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]);
  return rows.length ? rows[0].value : null;
}

export async function setMeta(db: Driver, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
