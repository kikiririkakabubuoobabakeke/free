import Database from "@tauri-apps/plugin-sql";
import type { Driver } from "./driver";

export async function openTauriDriver(): Promise<Driver> {
  // アプリのデータフォルダに diary.db として保存される
  const db = await Database.load("sqlite:diary.db");
  return {
    async run(sql, params = []) {
      await db.execute(sql, params);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.select<T[]>(sql, params);
    },
  };
}
