/**
 * アプリに同梱した LLM のエンジン（Ollama）の操作。
 * 起動・停止はアプリの Rust 側に頼み、モデルの一覧・取得・削除はエンジンに HTTP で頼む。
 */
import { isTauri } from "../db/driver";
import type { Fetcher } from "./client";

export interface EngineInfo {
  /** このアプリにエンジンが入っているか */
  available: boolean;
  running: boolean;
  port: number;
  /** 同じネットワークの他の端末からも使えるようにしているか */
  share: boolean;
  /** "windows" / "macos" / "linux" など */
  os: string;
  models_dir: string;
  log_path: string;
  /** 他の端末からこのPCを指すときのアドレス */
  lan_address: string | null;
  /** 入っているモデル（エンジンを起動せずに調べたもの） */
  models: string[];
  /** このアプリが起動したエンジンのプロセス番号 */
  pid: number | null;
}

/** 選べるモデル。Windows では 26B、Mac では E4B を最初に選んでおく。 */
export const BUILTIN_MODELS = [
  { name: "gemma4:e4b", size: "9.6GB" },
  { name: "gemma4:26b", size: "18GB" },
] as const;

export function defaultModel(os: string): string {
  return os === "windows" ? "gemma4:26b" : "gemma4:e4b";
}

export function engineUrl(info: Pick<EngineInfo, "port">): string {
  return `http://127.0.0.1:${info.port}`;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** アプリでなければ（ブラウザで開いているなど）null */
export async function engineInfo(): Promise<EngineInfo | null> {
  if (!isTauri()) return null;
  return invoke<EngineInfo>("engine_info");
}

/** エンジンを起動して、応答できるようになったら返す。動いていれば何もしない。 */
export async function startEngine(share: boolean): Promise<EngineInfo> {
  return invoke<EngineInfo>("engine_start", { share });
}

export async function stopEngine(): Promise<void> {
  if (isTauri()) await invoke<void>("engine_stop");
}

/** "gemma4" と "gemma4:latest" を同じものとして扱う */
export function sameModel(a: string, b: string): boolean {
  const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`).toLowerCase();
  return norm(a.trim()) === norm(b.trim());
}

export async function listLocalModels(fetcher: Fetcher, baseUrl: string): Promise<string[]> {
  const res = await fetcher(`${baseUrl}/api/tags`, { method: "GET", connectTimeout: 3000 });
  if (!res.ok) throw new Error(`モデルの一覧を取れませんでした（${res.status}）`);
  const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
  return (body.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean);
}

export interface PullProgress {
  status: string;
  completed: number;
  total: number;
}

/**
 * モデルの取得の進み具合（1行ずつ届く JSON）を足し合わせる。
 * 取得するファイルは複数あるので、ファイルごとの大きさと済んだ量を覚えて合計する。
 */
export class PullTracker {
  private files = new Map<string, { total: number; completed: number }>();
  status = "";
  done = false;
  error: string | null = null;

  update(line: unknown): PullProgress {
    const o = (line && typeof line === "object" ? line : {}) as Record<string, unknown>;
    if (typeof o.error === "string") this.error = o.error;
    if (typeof o.status === "string") this.status = o.status;
    if (o.status === "success") this.done = true;
    if (typeof o.digest === "string" && typeof o.total === "number") {
      const completed = typeof o.completed === "number" ? o.completed : 0;
      const prev = this.files.get(o.digest);
      // 届く順が前後しても、済んだ量は減らさない
      this.files.set(o.digest, { total: o.total, completed: Math.max(completed, prev?.completed ?? 0) });
    }
    return this.progress();
  }

  progress(): PullProgress {
    let total = 0;
    let completed = 0;
    for (const f of this.files.values()) {
      total += f.total;
      completed += Math.min(f.completed, f.total);
    }
    return { status: this.status, completed, total };
  }
}

/** モデルを取ってくる。進み具合を onProgress で知らせる。signal で途中でやめられる。 */
export async function pullModel(
  fetcher: Fetcher,
  baseUrl: string,
  model: string,
  onProgress: (p: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetcher(`${baseUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
    connectTimeout: 5000,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`モデルを取ってこられませんでした（${res.status}）${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const tracker = new PullTracker();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onProgress(tracker.update(JSON.parse(line)));
      } catch {
        // 1行だけ読めなくても続ける
      }
      if (tracker.error) throw new Error(`モデルを取ってこられませんでした: ${tracker.error}`);
    }
    if (done) break;
  }
  if (buffer.trim()) {
    try {
      onProgress(tracker.update(JSON.parse(buffer)));
    } catch {
      // 最後の切れ端は捨てる
    }
  }
  if (tracker.error) throw new Error(`モデルを取ってこられませんでした: ${tracker.error}`);
  if (!tracker.done) throw new Error("モデルの取得が途中で終わりました");
}

export async function deleteModel(fetcher: Fetcher, baseUrl: string, model: string): Promise<void> {
  const res = await fetcher(`${baseUrl}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
    connectTimeout: 3000,
  });
  if (!res.ok && res.status !== 404) throw new Error(`モデルを消せませんでした（${res.status}）`);
}
