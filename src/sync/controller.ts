import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Driver } from "../db/driver";
import { getMeta, setMeta } from "../db/schema";
import { resetSyncState, syncOnce } from "./engine";
import { SupabaseRemote } from "./supabase";

export interface SyncConfig {
  url: string;
  key: string;
}

export interface SyncState {
  config: SyncConfig | null;
  /** ログイン中のメールアドレス。未ログインなら null。 */
  email: string | null;
  phase: "idle" | "syncing" | "error";
  lastSyncedAt: number | null;
  error: string | null;
}

const CONFIG_KEY = "nikki.supabase";
const SYNC_USER_KEY = "sync_user";
const POLL_MS = 60_000;
const AFTER_EDIT_MS = 3_000;

/** ビルド時に埋め込まれた接続先。あれば端末ごとに入力しなくて済む。 */
function builtInConfig(): SyncConfig | null {
  const url = import.meta.env?.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined;
  return url && key ? { url, key } : null;
}

function loadConfig(): SyncConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SyncConfig>;
      if (parsed.url && parsed.key) return { url: parsed.url, key: parsed.key };
    }
  } catch {
    // 壊れた設定は無かったものとして扱う
  }
  return builtInConfig();
}

/** ログイン状態を持ち、いつ同期するかを決める */
export class SyncController {
  private state: SyncState = { config: null, email: null, phase: "idle", lastSyncedAt: null, error: null };
  private listeners = new Set<() => void>();
  private client: SupabaseClient | null = null;
  private userId: string | null = null;
  private running = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly db: Driver,
    /** 同期で端末内のデータが変わったときに呼ばれる */
    private readonly onRemoteChange: () => void,
  ) {}

  getState = (): SyncState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async init(): Promise<void> {
    await this.connect(loadConfig());
    setInterval(() => {
      if (document.visibilityState === "visible") void this.syncNow();
    }, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.syncNow();
    });
    window.addEventListener("online", () => void this.syncNow());
  }

  private async connect(config: SyncConfig | null): Promise<void> {
    this.client = null;
    this.userId = null;
    this.set({ config, email: null, error: null, phase: "idle" });
    if (!config) return;
    try {
      const client = createClient(config.url, config.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
      this.client = client;
      client.auth.onAuthStateChange((_event, session) => {
        if (this.client !== client) return;
        const changed = this.userId !== (session?.user.id ?? null);
        this.userId = session?.user.id ?? null;
        this.set({ email: session?.user.email ?? null });
        if (changed && this.userId) void this.syncNow();
      });
      const { data } = await client.auth.getSession();
      this.userId = data.session?.user.id ?? null;
      this.set({ email: data.session?.user.email ?? null });
      if (this.userId) void this.syncNow();
    } catch (error) {
      this.set({ phase: "error", error: message(error) });
    }
  }

  async setConfig(config: SyncConfig | null): Promise<void> {
    if (config) localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    else localStorage.removeItem(CONFIG_KEY);
    await this.connect(config ?? builtInConfig());
  }

  /** 成功なら null、失敗なら理由を返す */
  async signIn(email: string, password: string): Promise<string | null> {
    if (!this.client) return "接続先が未設定です";
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    return error ? explain(error.message) : null;
  }

  /** 成功なら null。確認メールが必要な設定のときは、その旨を返す。 */
  async signUp(email: string, password: string): Promise<string | null> {
    if (!this.client) return "接続先が未設定です";
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) return explain(error.message);
    if (!data.session) return "確認メールを送りました。メール内のリンクを開いてから、ログインしてください。";
    return null;
  }

  async signOut(): Promise<void> {
    await this.client?.auth.signOut();
  }

  /** 端末内で変更があったときに呼ぶ。少し待ってからまとめて同期する。 */
  requestSync(): void {
    if (!this.userId) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(), AFTER_EDIT_MS);
  }

  async syncNow(): Promise<void> {
    if (!this.client || !this.userId) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.set({ phase: "syncing" });
    try {
      // 前回と違うアカウントなら、手元のデータを新しいアカウントへ合流させる
      const who = `${this.state.config?.url}|${this.userId}`;
      const previous = await getMeta(this.db, SYNC_USER_KEY);
      if (previous !== null && previous !== who) await resetSyncState(this.db);
      if (previous !== who) await setMeta(this.db, SYNC_USER_KEY, who);

      const result = await syncOnce(this.db, new SupabaseRemote(this.client, this.userId));
      this.set({ phase: "idle", error: null, lastSyncedAt: Date.now() });
      if (result.changed) this.onRemoteChange();
    } catch (error) {
      this.set({ phase: "error", error: message(error) });
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.requestSync();
      }
    }
  }
}

function message(error: unknown): string {
  return explain(error instanceof Error ? error.message : String(error));
}

/** よく出る英語のエラーを、何をすればよいか分かる日本語にする。知らないものは原文のまま出す。 */
function explain(text: string): string {
  if (/invalid login credentials/i.test(text)) return "メールアドレスかパスワードが違います。";
  if (/email not confirmed/i.test(text)) return "メールアドレスの確認がまだです。届いたメールのリンクを開いてください。";
  if (/already registered/i.test(text)) return "このメールアドレスは登録済みです。「ログイン」を押してください。";
  if (/signups? (are |is )?(not allowed|disabled)/i.test(text)) return "この接続先では新規登録が止められています。";
  if (/failed to fetch|load failed|networkerror|network request failed/i.test(text)) {
    return "接続できませんでした。電波の状態と、接続先のURLを確かめてください。";
  }
  if (/relation .*records.* does not exist|could not find the table/i.test(text)) {
    return "同期先の準備がまだです。supabase/schema.sql を SQL Editor で実行してください。";
  }
  return text;
}
