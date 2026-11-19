import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isTauri, openDriver } from "../db/driver";
import { Repo } from "../db/repo";
import { migrate } from "../db/schema";
import type { Fetcher } from "../llm/client";
import { AnalysisController, type AnalysisState } from "../llm/controller";
import type { SyncController, SyncState } from "../sync/controller";

/** 画面全体で共有するもの。起動時に1度だけ作る。 */
export interface App {
  repo: Repo;
  /** オフライン版では null */
  sync: SyncController | null;
  /** ローカルLLMによる分析 */
  analysis: AnalysisController;
}

/**
 * LLM のサーバーと話すための fetch。
 * アプリでは Rust 側で通信する（LAN 内の http のサーバーに、ブラウザの制約なしで届くように）。
 */
async function llmFetcher(): Promise<Fetcher> {
  if (isTauri()) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return fetch;
  }
  return (input, init) => window.fetch(input, init);
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
  let analysis: AnalysisController | null = null;
  const repo = new Repo(db, () => {
    bump();
    sync?.requestSync();
    analysis?.requestRun();
  });
  analysis = new AnalysisController(repo, llmFetcher);
  app = { repo, sync, analysis };
  // ゴミ箱に入れてから期限を過ぎたものを完全に削除する。起動時と、開いたままなら1時間ごと。
  await repo.purgeExpiredTrash();
  setInterval(() => void repo.purgeExpiredTrash(), 3_600_000);
  // 同期の準備は通信を伴うことがあるので、画面を出すのを待たせない
  void sync?.init();
  analysis.init();
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

export function useAnalysisState(): AnalysisState {
  const { analysis } = getApp();
  return useSyncExternalStore(analysis.subscribe, analysis.getState);
}

export function useSyncState(): SyncState {
  const sync = getSync();
  return useSyncExternalStore(sync.subscribe, sync.getState);
}

/**
 * 入力欄の下書き。打つたびに画面はすぐ変わり、保存は少し待ってまとめて行う。
 * 外から来た値（同期など）は、こちらに未保存の入力が無いときだけ取り込む。
 */
/** いま画面にある下書きの「保存し切る」関数 */
const activeFlushers = new Set<() => Promise<void>>();

/**
 * 打ちかけの入力を、すべて保存し切る。
 * ロックやゴミ箱への移動の前に呼ぶ（その後では保存が断られ、打った分が消えてしまうため）。
 */
export async function flushAllDrafts(): Promise<void> {
  await Promise.all([...activeFlushers].map((flush) => flush()));
}

export function useDraft<T>(value: T, save: (next: T) => Promise<void> | void, delay = 500) {
  const [draft, setDraft] = useState(value);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useRef((): Promise<void> => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    const p = pending.current;
    if (!p) return Promise.resolve();
    return Promise.resolve(saveRef.current(p.value)).then(
      () => {
        if (pending.current === p) pending.current = null;
      },
      (error: unknown) => {
        // 保存できなかった（ロックされた等）。画面は保存されている値に戻す。
        if (pending.current === p) pending.current = null;
        throw error;
      },
    );
  }).current;

  useEffect(() => {
    if (!pending.current) setDraft(value);
    // 値の中身で比べる（オブジェクトは毎回作り直されるため）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);

  useEffect(() => {
    activeFlushers.add(flush);
    return () => {
      activeFlushers.delete(flush);
      void flush(); // 画面を離れるときに書き残しを保存
    };
  }, [flush]);

  const update = (next: T) => {
    setDraft(next);
    pending.current = { value: next };
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);
  };

  return [draft, update, flush] as const;
}
