import type { Repo } from "../db/repo";
import { addDays, todayString, weekStart } from "../ui/days";
import { analyzeEntry, makeReview, reviewDue } from "./analyzer";
import { DEFAULT_LLM_CONFIG, LlmClient, LlmError, type Fetcher, type LlmConfig, type ServerKind } from "./client";
import {
  defaultModel,
  deleteModel,
  engineInfo,
  engineUrl,
  listLocalModels,
  pullModel,
  sameModel,
  startEngine,
  stopEngine,
  type EngineInfo,
  type PullProgress,
} from "./engine";

export interface AnalysisState {
  config: LlmConfig;
  /** いま使うモデル（設定が空なら、このPCに合ったもの） */
  model: string;
  /**
   * off: 使わない設定／starting: エンジンを起動中／idle: 待機中／working: 分析中
   * needs-model: モデルがまだ入っていない／unreachable: サーバーにつながらない／error: その他の失敗
   */
  phase: "off" | "starting" | "idle" | "working" | "needs-model" | "unreachable" | "error";
  /** 分析を進められる設定になっているか（使う設定で、サーバーかエンジンがある） */
  configured: boolean;
  /** 分析がまだの日記の数 */
  pending: number;
  /** いま分析している日記の id（振り返りなら "review:週の始まり"） */
  current: string | null;
  server: { kind: ServerKind; models: string[] } | null;
  /** アプリに同梱したエンジンの様子（ブラウザで開いているときは null） */
  engine: EngineInfo | null;
  /** 同梱のエンジンに入っているモデル（まだ調べていなければ null） */
  localModels: string[] | null;
  /** モデルを取ってきている途中なら、その進み具合 */
  pull: (PullProgress & { model: string }) | null;
  error: string | null;
}

const CONFIG_KEY = "nikki.llm";
/** 試しに使うときだけ書き換える、書き終えてから分析を始めるまでの時間 */
const SETTLE_KEY = "nikki.llm.settleMs";
const DEFAULT_SETTLE_MS = 120_000;
const TICK_MS = 60_000;
/** 振り返りを自動で作る、さかのぼる週の数 */
const REVIEW_WEEKS = 8;
/** 同じ日記で続けて失敗したら、その回はあきらめる回数 */
const MAX_FAILURES = 2;

/** 保存してある設定を読む。前の版の設定（方式の無いもの）は、URL があれば「ほかのPCのサーバー」とみなす。 */
export function loadConfig(raw: string | null): { config: LlmConfig; saved: boolean } {
  try {
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LlmConfig>;
      const mode = parsed.mode ?? (parsed.url ? "remote" : "builtin");
      return { config: { ...DEFAULT_LLM_CONFIG, ...parsed, mode }, saved: true };
    }
  } catch {
    // 壊れた設定は無かったものとして扱う
  }
  return { config: { ...DEFAULT_LLM_CONFIG }, saved: false };
}

function settleMs(): number {
  try {
    const v = Number(localStorage.getItem(SETTLE_KEY));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_SETTLE_MS;
  } catch {
    return DEFAULT_SETTLE_MS;
  }
}

/** 設定とエンジンの様子から、実際に使うモデルを決める */
export function effectiveModel(config: LlmConfig, engine: EngineInfo | null): string {
  if (config.model.trim()) return config.model.trim();
  return config.mode === "builtin" ? defaultModel(engine?.os ?? "") : DEFAULT_REMOTE_MODEL;
}

/** ほかのPCのサーバーを使うときに、最初に入れておくモデル */
export const DEFAULT_REMOTE_MODEL = "gemma4:26b";

function isConfigured(config: LlmConfig, engine: EngineInfo | null): boolean {
  if (!config.enabled) return false;
  return config.mode === "builtin" ? !!engine?.available : !!config.url.trim();
}

/**
 * ローカルLLMによる分析を、バックグラウンドで1件ずつ進める係。
 * 書き終えてしばらくたった日記から順に分析し、終わった週の振り返りも作る。
 * サーバー（同梱のエンジンや、ほかのPC）につながらないときは、次の機会（1分後・画面に戻ったとき）にまた試す。
 */
export class AnalysisController {
  private state: AnalysisState;
  private listeners = new Set<() => void>();
  private running = false;
  private again = false;
  private priority: string[] = [];
  private reviewRequests: string[] = [];
  private failures = new Map<string, number>();
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private pullAbort: AbortController | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly getFetcher: () => Promise<Fetcher>,
  ) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(CONFIG_KEY);
    } catch {
      // 読めなければ、既定の設定で始める
    }
    const { config } = loadConfig(raw);
    this.state = {
      config,
      model: effectiveModel(config, null),
      phase: "off",
      configured: false,
      pending: 0,
      current: null,
      server: null,
      engine: null,
      localModels: null,
      pull: null,
      error: null,
    };
  }

  getState = (): AnalysisState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AnalysisState>): void {
    const next = { ...this.state, ...patch };
    next.model = effectiveModel(next.config, next.engine);
    next.configured = isConfigured(next.config, next.engine);
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  async init(): Promise<void> {
    // 同梱のエンジンがあるか調べる。無い（ブラウザなど）なら、ほかのPCのサーバーを使う方式にする。
    const engine = await engineInfo().catch(() => null);
    const config = { ...this.state.config };
    if (config.mode === "builtin" && !engine?.available) config.mode = "remote";
    // 入っているモデルは、エンジンを起動しなくても分かる
    this.set({ engine, config, localModels: engine?.available ? engine.models : null });
    void this.refreshPending();
    void this.run();
    setInterval(() => void this.run(), TICK_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.run();
    });
  }

  private save(config: LlmConfig): void {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch {
      // 保存できなくても、この起動の間は使える
    }
  }

  async setConfig(patch: Partial<LlmConfig>): Promise<void> {
    const before = this.state.config;
    const config = { ...before, ...patch };
    this.save(config);
    this.failures.clear();
    this.set({ config, server: null, error: null, phase: isConfigured(config, this.state.engine) ? "idle" : "off" });
    const usesEngine = config.mode === "builtin" && !!this.state.engine?.available;
    const usedEngine = before.mode === "builtin" && before.enabled;
    if (usedEngine && (!usesEngine || !config.enabled)) {
      // 使わなくなったら、エンジンを止めてメモリを空ける
      await stopEngine().catch(() => undefined);
      this.set({ engine: this.state.engine ? { ...this.state.engine, running: false, share: false } : null });
    } else if (usesEngine && (config.share !== before.share || patch.mode === "builtin")) {
      await this.ensureEngine().catch((error) => this.set({ error: message(error) }));
      await this.refreshLocalModels();
    }
    void this.run();
  }

  /** 同梱のエンジンを（必要なら起動して）使える状態にし、その URL を返す */
  private async ensureEngine(): Promise<string> {
    const { config, engine } = this.state;
    if (!engine?.available) throw new LlmError("config", "このアプリにはエンジンが入っていません");
    if (engine.running && engine.share === config.share) return engineUrl(engine);
    this.set({ phase: "starting" });
    try {
      const info = await startEngine(config.share);
      this.set({ engine: info });
      return engineUrl(info);
    } catch (error) {
      throw new LlmError("unreachable", `エンジンを起動できませんでした（${message(error)}）`);
    }
  }

  /** いまの設定で使うサーバーの URL */
  private async serverUrl(): Promise<string> {
    return this.state.config.mode === "builtin" ? this.ensureEngine() : this.state.config.url;
  }

  /** 同梱のエンジンに入っているモデルを調べ直す */
  async refreshLocalModels(): Promise<string[] | null> {
    if (this.state.config.mode !== "builtin" || !this.state.engine?.available) return null;
    try {
      const url = await this.ensureEngine();
      const models = await listLocalModels(await this.getFetcher(), url);
      this.set({ localModels: models });
      return models;
    } catch (error) {
      this.set({ error: message(error) });
      return null;
    }
  }

  /** サーバーにつながるか、どんなモデルがあるかを確かめる */
  async test(): Promise<{ kind: ServerKind; models: string[] }> {
    try {
      const url = await this.serverUrl();
      const client = new LlmClient({ ...this.state.config, url, model: this.state.model }, await this.getFetcher());
      const server = await client.probe();
      this.set({ server, error: null, phase: this.state.configured ? "idle" : "off" });
      return server;
    } catch (error) {
      this.set({ server: null, error: message(error), phase: this.state.configured ? "unreachable" : "off" });
      throw error;
    }
  }

  /** 同梱のエンジンに、いま選んでいるモデルを取ってくる */
  async installModel(): Promise<void> {
    if (this.pullAbort) return;
    const model = this.state.model;
    const abort = new AbortController();
    this.pullAbort = abort;
    this.set({ pull: { model, status: "", completed: 0, total: 0 }, error: null });
    try {
      const url = await this.ensureEngine();
      await pullModel(await this.getFetcher(), url, model, (p) => this.set({ pull: { ...p, model } }), abort.signal);
      await this.refreshLocalModels();
      this.set({ pull: null, phase: this.state.configured ? "idle" : "off" });
      void this.run();
    } catch (error) {
      this.set({ pull: null, error: abort.signal.aborted ? null : message(error) });
    } finally {
      this.pullAbort = null;
    }
  }

  cancelInstall(): void {
    this.pullAbort?.abort();
  }

  async removeModel(model: string): Promise<void> {
    try {
      const url = await this.ensureEngine();
      await deleteModel(await this.getFetcher(), url, model);
      await this.refreshLocalModels();
    } catch (error) {
      this.set({ error: message(error) });
    }
  }

  /**
   * 日記が変わったときに呼ぶ。書き終えてから分析を始めるまでの時間がたったところで、待ちの列を見に行く。
   * 書き続けている間は、そのたびに待ち直す。
   */
  requestRun(): void {
    if (!this.state.config.enabled) return;
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.run();
    }, settleMs() + 1_000);
  }

  /** この日記を、待たずに次に分析する */
  analyzeNow(id: string): void {
    this.failures.delete(id);
    if (!this.priority.includes(id)) this.priority.push(id);
    void this.run();
  }

  /** この週の振り返りを（作り直しも含めて）次に作る */
  reviewNow(start: string): void {
    this.failures.delete(`review:${start}`);
    if (!this.reviewRequests.includes(start)) this.reviewRequests.push(start);
    void this.run();
  }

  /** すべての日記を分析し直す（振り返りも作り直す） */
  async reanalyzeAll(): Promise<void> {
    await this.repo.clearAnalyses({ reviews: true });
    this.failures.clear();
    await this.refreshPending();
    void this.run();
  }

  private async refreshPending(): Promise<void> {
    this.set({ pending: await this.repo.analysisPending() });
  }

  /** 待ちの列を1件ずつ片付ける。同時には1つしか走らせない。 */
  async run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    if (!this.state.configured) {
      this.set({ phase: "off", current: null });
      return;
    }
    if (this.state.pull) return; // モデルを取ってきている間は待つ
    this.running = true;
    try {
      const nextEntry = async (): Promise<string | null> => {
        while (this.priority.length) {
          const id = this.priority.shift()!;
          if ((this.failures.get(id) ?? 0) < MAX_FAILURES) return id;
        }
        const queue = await this.repo.analysisQueue({ settledBefore: Date.now() - settleMs(), limit: 50 });
        return queue.find((id) => (this.failures.get(id) ?? 0) < MAX_FAILURES) ?? null;
      };
      const nextReview = async (): Promise<string | null> => {
        while (this.reviewRequests.length) {
          const start = this.reviewRequests.shift()!;
          if ((this.failures.get(`review:${start}`) ?? 0) < MAX_FAILURES) return start;
        }
        const today = todayString();
        for (let w = 1; w <= REVIEW_WEEKS; w++) {
          const start = addDays(weekStart(today), -7 * w);
          if ((this.failures.get(`review:${start}`) ?? 0) >= MAX_FAILURES) continue;
          if (await reviewDue(this.repo, start, today)) return start;
        }
        return null;
      };

      let entryId = await nextEntry();
      let reviewStart = entryId ? null : await nextReview();
      if (!entryId && !reviewStart) {
        await this.refreshPending();
        this.set({ phase: "idle", current: null });
        return;
      }

      const url = await this.serverUrl();
      const model = this.state.model;
      const client = new LlmClient({ ...this.state.config, url, model }, await this.getFetcher());
      const server = await client.probe();
      this.set({ server, error: null });
      // 同梱のエンジンにモデルが入っていなければ、ここで待つ（勝手に大きなファイルを取ってこない）
      if (this.state.config.mode === "builtin") {
        this.set({ localModels: server.models });
        if (!server.models.some((m) => sameModel(m, model))) {
          this.set({ phase: "needs-model", current: null });
          return;
        }
      }

      while ((entryId || reviewStart) && this.state.config.enabled) {
        const key = entryId ?? `review:${reviewStart}`;
        this.set({ phase: "working", current: key });
        try {
          if (entryId) await analyzeEntry(this.repo, client, model, entryId);
          else await makeReview(this.repo, client, model, reviewStart!);
          this.failures.delete(key);
        } catch (error) {
          // つながらない・時間切れは、サーバー側の問題なので、この回はここでやめて次の機会に回す
          if (error instanceof LlmError && (error.kind === "unreachable" || error.kind === "timeout" || error.kind === "config")) throw error;
          this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
          this.set({ error: message(error) });
        }
        await this.refreshPending();
        entryId = await nextEntry();
        reviewStart = entryId ? null : await nextReview();
      }
      this.set({ phase: this.state.configured ? "idle" : "off", current: null });
    } catch (error) {
      const unreachable = error instanceof LlmError && (error.kind === "unreachable" || error.kind === "timeout");
      this.set({ phase: unreachable ? "unreachable" : "error", current: null, error: message(error) });
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        void this.run();
      }
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
