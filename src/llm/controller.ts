import type { Repo } from "../db/repo";
import { addDays, todayString, weekStart } from "../ui/days";
import { analyzeEntry, makeReview, reviewDue } from "./analyzer";
import { DEFAULT_LLM_CONFIG, LlmClient, LlmError, type Fetcher, type LlmConfig, type ServerKind } from "./client";

export interface AnalysisState {
  config: LlmConfig;
  /** off: 使わない設定／idle: 待機中／working: 分析中／unreachable: サーバーにつながらない／error: その他の失敗 */
  phase: "off" | "idle" | "working" | "unreachable" | "error";
  /** 分析がまだの日記の数 */
  pending: number;
  /** いま分析している日記の id（振り返りなら "review:週の始まり"） */
  current: string | null;
  server: { kind: ServerKind; models: string[] } | null;
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

function loadConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_LLM_CONFIG, ...(JSON.parse(raw) as Partial<LlmConfig>) };
  } catch {
    // 壊れた設定は無かったものとして扱う
  }
  return { ...DEFAULT_LLM_CONFIG };
}

function settleMs(): number {
  try {
    const v = Number(localStorage.getItem(SETTLE_KEY));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_SETTLE_MS;
  } catch {
    return DEFAULT_SETTLE_MS;
  }
}

/**
 * ローカルLLMによる分析を、バックグラウンドで1件ずつ進める係。
 * 書き終えてしばらくたった日記から順に分析し、終わった週の振り返りも作る。
 * サーバー（Windows など）につながらないときは、次の機会（1分後・画面に戻ったとき）にまた試す。
 */
export class AnalysisController {
  private state: AnalysisState;
  private listeners = new Set<() => void>();
  private running = false;
  private again = false;
  private priority: string[] = [];
  private reviewRequests: string[] = [];
  private failures = new Map<string, number>();

  constructor(
    private readonly repo: Repo,
    private readonly getFetcher: () => Promise<Fetcher>,
  ) {
    this.state = { config: loadConfig(), phase: "off", pending: 0, current: null, server: null, error: null };
  }

  getState = (): AnalysisState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AnalysisState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  init(): void {
    void this.refreshPending();
    void this.run();
    setInterval(() => void this.run(), TICK_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.run();
    });
  }

  async setConfig(patch: Partial<LlmConfig>): Promise<void> {
    const config = { ...this.state.config, ...patch };
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch {
      // 保存できなくても、この起動の間は使える
    }
    this.failures.clear();
    this.set({ config, server: null, error: null, phase: config.enabled && config.url ? "idle" : "off" });
    void this.run();
  }

  /** サーバーにつながるか、どんなモデルがあるかを確かめる */
  async test(): Promise<{ kind: ServerKind; models: string[] }> {
    const client = new LlmClient(this.state.config, await this.getFetcher());
    try {
      const server = await client.probe();
      this.set({ server, error: null, phase: this.state.config.enabled ? "idle" : "off" });
      return server;
    } catch (error) {
      this.set({ server: null, error: message(error) });
      throw error;
    }
  }

  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

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
    const { config } = this.state;
    if (!config.enabled || !config.url.trim()) {
      this.set({ phase: "off", current: null });
      return;
    }
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

      const client = new LlmClient(config, await this.getFetcher());
      const server = await client.probe();
      this.set({ server, error: null });

      while ((entryId || reviewStart) && this.state.config.enabled) {
        const key = entryId ?? `review:${reviewStart}`;
        this.set({ phase: "working", current: key });
        try {
          if (entryId) await analyzeEntry(this.repo, client, config.model, entryId);
          else await makeReview(this.repo, client, config.model, reviewStart!);
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
      this.set({ phase: this.state.config.enabled ? "idle" : "off", current: null });
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
