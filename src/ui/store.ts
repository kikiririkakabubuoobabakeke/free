import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { openDriver } from "../db/driver";
import { Repo } from "../db/repo";
import { migrate } from "../db/schema";
import type { SyncController, SyncState } from "../sync/controller";

/** 画面全体で共有するもの。起動時に1度だけ作る。 */
export interface App {
  repo: Repo;
  /** オフライン版では null */
  sync: SyncController | null;
}

let app: App | null = null;
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export async function startApp(): Promise<App> {
  if (app) return app;
  const db = await openDriver();
  await migrate(db);
  // オフライン版には同期のコード（Supabaseのライブラリを含む）を入れない。
  // 条件をここに直接書いているのは、ビルド時に「絶対に通らない分岐」と分かるようにして丸ごと削らせるため
  // （config.ts の SYNC_ENABLED と同じ条件）。
  let sync: SyncController | null = null;
  if (import.meta.env.VITE_SYNC === "on") {
    const { SyncController } = await import("../sync/controller");
    sync = new SyncController(db, bump);
  }
  const repo = new Repo(db, () => {
    bump();
    sync?.requestSync();
  });
  app = { repo, sync };
  // 同期の準備は通信を伴うことがあるので、画面を出すのを待たせない
  void sync?.init();
  return app;
}

export function getApp(): App {
  if (!app) throw new Error("アプリがまだ起動していません");
  return app;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** データが変わるたびに増える番号。これに依存させると再読込される。 */
export function useDataVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** 非同期の読み出し。データが変わるか deps が変わると読み直す。読めるまでは undefined。 */
export function useQuery<T>(load: () => Promise<T>, deps: unknown[]): T | undefined {
  const v = useDataVersion();
  const [data, setData] = useState<T>();
  const latest = useRef(0);
  useEffect(() => {
    const ticket = ++latest.current;
    void load().then((result) => {
      if (ticket === latest.current) setData(result);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, ...deps]);
  return data;
}

/** 同期つきの版でだけ使える */
export function getSync(): SyncController {
  const { sync } = getApp();
  if (!sync) throw new Error("この版には同期の機能がありません");
  return sync;
}

export function useSyncState(): SyncState {
  const sync = getSync();
  return useSyncExternalStore(sync.subscribe, sync.getState);
}

/**
 * 入力欄の下書き。打つたびに画面はすぐ変わり、保存は少し待ってまとめて行う。
 * 外から来た値（同期など）は、こちらに未保存の入力が無いときだけ取り込む。
 */
export function useDraft<T>(value: T, save: (next: T) => Promise<void> | void, delay = 500) {
  const [draft, setDraft] = useState(value);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useRef(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    const p = pending.current;
    if (!p) return;
    void Promise.resolve(saveRef.current(p.value)).then(() => {
      if (pending.current === p) pending.current = null;
    });
  }).current;

  useEffect(() => {
    if (!pending.current) setDraft(value);
    // 値の中身で比べる（オブジェクトは毎回作り直されるため）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);

  useEffect(() => flush, [flush]); // 画面を離れるときに書き残しを保存

  const update = (next: T) => {
    setDraft(next);
    pending.current = { value: next };
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
  };

  return [draft, update, flush] as const;
}
