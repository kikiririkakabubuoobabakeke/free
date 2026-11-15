/**
 * SQLiteへの最小限の窓口。
 * ネイティブ(Tauri)では tauri-plugin-sql、ブラウザとテストでは sql.js が実装する。
 * プレースホルダは両者で共通に動く `?` だけを使う。
 */
export interface Driver {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function openDriver(): Promise<Driver> {
  if (isTauri()) {
    const { openTauriDriver } = await import("./driver.tauri");
    return openTauriDriver();
  }
  const { openWebDriver } = await import("./driver.web");
  return openWebDriver();
}
