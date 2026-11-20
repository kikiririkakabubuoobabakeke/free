/**
 * 自分のPC（LAN内）で動かしているLLMのサーバーと話す部分。
 *
 * - Ollama なら、Ollama 独自の受け口（/api/chat）を使う。文脈の長さ（num_ctx）を毎回指定でき、
 *   既定の短い文脈で日記が黙って切り捨てられるのを防げるため。
 * - それ以外（LM Studio、llama.cpp の server など）は、OpenAI 互換の受け口（/v1/chat/completions）を使う。
 * - どちらも JSON スキーマを渡して、決まった形の JSON だけを返させる。返ってきたものは、使う側で必ず検める。
 */

export interface LlmConfig {
  /** builtin: アプリに同梱したエンジンを、このPCの中で動かす／remote: ほかのPCのサーバーを使う */
  mode: "builtin" | "remote";
  /** remote のときのサーバー。例: http://192.168.1.20:11434 */
  url: string;
  /** 例: gemma4:26b。空なら、このPCに合ったものを使う。 */
  model: string;
  /** 分析を進めるか */
  enabled: boolean;
  /** Ollama に渡す文脈の長さ（トークン数） */
  contextLength: number;
  /** builtin のとき、同じネットワークの他の端末からも使えるようにするか */
  share: boolean;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  mode: "builtin",
  url: "",
  model: "",
  enabled: false,
  contextLength: 8192,
  share: false,
};

export type ServerKind = "ollama" | "openai";

/** fetch と同じ形。Tauri では Rust 側で通信する plugin-http の fetch を渡す。 */
export type Fetcher = (input: string, init?: RequestInit & { connectTimeout?: number }) => Promise<Response>;

export class LlmError extends Error {
  constructor(
    readonly kind: "unreachable" | "http" | "parse" | "timeout" | "config",
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const PROBE_TIMEOUT_MS = 6_000;
/** 1件の生成にかけてよい時間。大きいモデルが読み込み直しになる最初の1件も考えて、長めにとる。 */
const GENERATE_TIMEOUT_MS = 300_000;

export class LlmClient {
  private kind: ServerKind | null = null;

  constructor(
    private readonly config: LlmConfig,
    private readonly fetcher: Fetcher,
  ) {}

  private base(): string {
    const url = this.config.url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]+/.test(url)) throw new LlmError("config", "サーバーのURLが正しくありません");
    // OpenAI 互換の URL として /v1 まで書かれていても受け付ける
    return url.replace(/\/v1$/, "");
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetcher(`${this.base()}${path}`, {
        ...init,
        signal: controller.signal,
        connectTimeout: Math.min(timeoutMs, 5_000),
      });
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (controller.signal.aborted) throw new LlmError("timeout", "サーバーの応答が時間内にありませんでした");
      throw new LlmError("unreachable", `サーバーにつながりません（${describe(error)}）`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** サーバーの種類と、使えるモデルの一覧を調べる */
  async probe(): Promise<{ kind: ServerKind; models: string[] }> {
    // Ollama は /api/version に答える
    const version = await this.request("/api/version", { method: "GET" }, PROBE_TIMEOUT_MS).catch((error: unknown) => {
      if (error instanceof LlmError && error.kind !== "http") throw error;
      return null;
    });
    // Ollama は {"version": "0.x.y"} を返す。似た道を持つ別のサーバーと取り違えないよう、中身まで見る。
    const versionBody = version?.ok ? ((await version.json().catch(() => null)) as { version?: unknown } | null) : null;
    if (typeof versionBody?.version === "string") {
      const tags = await this.request("/api/tags", { method: "GET" }, PROBE_TIMEOUT_MS);
      const body = (await tags.json().catch(() => ({}))) as { models?: { name?: string; model?: string }[] };
      this.kind = "ollama";
      return { kind: "ollama", models: (body.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean) };
    }
    const models = await this.request("/v1/models", { method: "GET" }, PROBE_TIMEOUT_MS);
    if (!models.ok) throw new LlmError("http", `サーバーがモデルの一覧に答えませんでした（${models.status}）`);
    const body = (await models.json().catch(() => ({}))) as { data?: { id?: string }[] };
    this.kind = "openai";
    return { kind: "openai", models: (body.data ?? []).map((m) => m.id ?? "").filter(Boolean) };
  }

  /** schema の形の JSON を返させ、解釈したものを返す（中身はまだ検めていない） */
  async chatJson(messages: ChatMessage[], schema: object, opts: { temperature?: number } = {}): Promise<unknown> {
    if (!this.config.model.trim()) throw new LlmError("config", "モデルが選ばれていません");
    if (!this.kind) await this.probe();
    const temperature = opts.temperature ?? 0.3;
    const text = this.kind === "ollama" ? await this.chatOllama(messages, schema, temperature) : await this.chatOpenAi(messages, schema, temperature);
    return parseJsonLoose(text);
  }

  private async chatOllama(messages: ChatMessage[], schema: object, temperature: number): Promise<string> {
    const res = await this.request(
      "/api/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          format: schema,
          options: { temperature, num_ctx: this.config.contextLength },
          // 続けて何件も分析するので、その間はモデルを読み込んだままにしてもらう
          keep_alive: "10m",
        }),
      },
      GENERATE_TIMEOUT_MS,
    );
    if (!res.ok) throw new LlmError("http", `サーバーがエラーを返しました（${res.status}）${await errorText(res)}`);
    const body = (await res.json().catch(() => null)) as { message?: { content?: string } } | null;
    const content = body?.message?.content;
    if (typeof content !== "string") throw new LlmError("parse", "サーバーの応答の形が想定と違います");
    return content;
  }

  private async chatOpenAi(messages: ChatMessage[], schema: object, temperature: number): Promise<string> {
    // JSON スキーマ → JSON だけ → 指定なし、の順に試す（サーバーによって対応が違うため）
    const formats: (object | undefined)[] = [
      { type: "json_schema", json_schema: { name: "result", strict: true, schema } },
      { type: "json_object" },
      undefined,
    ];
    let lastError: LlmError | null = null;
    for (const response_format of formats) {
      const res = await this.request(
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.config.model, messages, temperature, stream: false, response_format }),
        },
        GENERATE_TIMEOUT_MS,
      );
      if (res.status === 400 || res.status === 422) {
        lastError = new LlmError("http", `サーバーが要求を受け付けませんでした（${res.status}）${await errorText(res)}`);
        continue;
      }
      if (!res.ok) throw new LlmError("http", `サーバーがエラーを返しました（${res.status}）${await errorText(res)}`);
      const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new LlmError("parse", "サーバーの応答の形が想定と違います");
      return content;
    }
    throw lastError ?? new LlmError("http", "サーバーが要求を受け付けませんでした");
  }
}

/**
 * LLM の出力から JSON を取り出す。考えている途中の文（<think>…</think>）や ``` の囲みが付いていても受け付ける。
 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // 下でまとめて扱う
      }
    }
    throw new LlmError("parse", "LLMの出力をJSONとして読めませんでした");
  }
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text ? `: ${text.slice(0, 200)}` : "";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
