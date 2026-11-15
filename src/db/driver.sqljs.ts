import type { Database, SqlValue } from "sql.js";
import type { Driver } from "./driver";

/** sql.js のデータベースを Driver として包む。onWrite は書き込みのたびに呼ばれる。 */
export function wrapSqlJs(db: Database, onWrite?: () => void): Driver {
  return {
    async run(sql, params = []) {
      db.run(sql, params as SqlValue[]);
      onWrite?.();
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params as SqlValue[]);
        const rows: T[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
        return rows;
      } finally {
        stmt.free();
      }
    },
  };
}
