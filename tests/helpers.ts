import initSqlJs from "sql.js";
import type { Driver } from "../src/db/driver";
import { wrapSqlJs } from "../src/db/driver.sqljs";
import { Repo } from "../src/db/repo";
import { migrate } from "../src/db/schema";
import type { OutgoingRecord, Remote, RemoteRecord } from "../src/sync/remote";

export async function openTestDb(): Promise<{ db: Driver; repo: Repo }> {
  const SQL = await initSqlJs();
  const db = wrapSqlJs(new SQL.Database());
  await migrate(db);
  return { db, repo: new Repo(db) };
}

/** supabase/schema.sql と同じ振る舞いをする、メモリ上の同期先 */
export class FakeRemote implements Remote {
  records = new Map<string, RemoteRecord>();
  blobs = new Map<string, string>();
  private seq = 0;

  async pull(afterSeq: number, limit: number): Promise<RemoteRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async push(records: OutgoingRecord[]): Promise<void> {
    for (const r of records) {
      const key = `${r.kind}/${r.id}`;
      const existing = this.records.get(key);
      if (existing && r.updated_at < existing.updated_at) continue; // 古い書き込みは無視
      this.records.set(key, { ...structuredClone(r), seq: ++this.seq });
    }
  }

  async uploadBlob(id: string, base64: string): Promise<void> {
    this.blobs.set(id, base64);
  }

  async downloadBlob(id: string): Promise<string | null> {
    return this.blobs.get(id) ?? null;
  }

  async deleteBlob(id: string): Promise<void> {
    this.blobs.delete(id);
  }
}
