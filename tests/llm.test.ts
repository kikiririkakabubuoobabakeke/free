import { describe, expect, it } from "vitest";
import { analyzeEntry, makeReview, reviewDue } from "../src/llm/analyzer";
import { LlmClient, LlmError, parseJsonLoose, type Fetcher, type LlmConfig } from "../src/llm/client";
import { entryMessages, validateEntryAnalysis, validateReview } from "../src/llm/prompts";
import { syncOnce } from "../src/sync/engine";
import { FakeRemote, openTestDb } from "./helpers";

const config: LlmConfig = {
  mode: "remote",
  url: "http://192.168.1.20:11434",
  model: "gemma4:26b",
  enabled: true,
  contextLength: 8192,
  share: false,
};

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}

/** Ollama か OpenAI 互換のサーバーのふりをする fetch。answer に、LLM が返す JSON を決めさせる。 */
function fakeServer(kind: "ollama" | "openai", answer: (prompt: string, body: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const path = new URL(url).pathname;
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (kind === "ollama") {
      if (path === "/api/version") return json({ version: "0.22.1" });
      if (path === "/api/tags") return json({ models: [{ name: "gemma4:26b" }, { name: "gemma4:e4b" }] });
      if (path === "/api/chat") {
        const messages = body!.messages as { content: string }[];
        const out = answer(messages[messages.length - 1].content, body!);
        return json({ message: { role: "assistant", content: typeof out === "string" ? out : JSON.stringify(out) }, done: true });
      }
    } else {
      if (path === "/api/version") return new Response("not found", { status: 404 });
      if (path === "/v1/models") return json({ data: [{ id: "google/gemma-4-26b-a4b" }] });
      if (path === "/v1/chat/completions") {
        const messages = body!.messages as { content: string }[];
        const out = answer(messages[messages.length - 1].content, body!);
        if (out instanceof Response) return out;
        return json({ choices: [{ message: { content: typeof out === "string" ? out : JSON.stringify(out) } }] });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { fetcher, calls };
}

const goodAnswer = {
  summary: "川沿いを歩いて冬の気配を感じた日",
  mood: 1,
  emotions: ["穏やか", "楽しさ"],
  topics: ["散歩", "焼き芋"],
  tag_ideas: ["散歩", "季節"],
  plan_ideas: [{ date: "2026-11-24", time: "15:00", title: "歯医者" }],
};

describe("LLMのサーバーとのやりとり", () => {
  it("Ollama を見分け、/api/chat に JSON スキーマと文脈の長さを渡す", async () => {
    const server = fakeServer("ollama", () => goodAnswer);
    const client = new LlmClient(config, server.fetcher);
    expect(await client.probe()).toEqual({ kind: "ollama", models: ["gemma4:26b", "gemma4:e4b"] });
    const out = await client.chatJson([{ role: "user", content: "日記" }], { type: "object" });
    expect(out).toEqual(goodAnswer);
    const chat = server.calls.find((c) => c.url.endsWith("/api/chat"))!;
    expect(chat.url).toBe("http://192.168.1.20:11434/api/chat");
    expect(chat.body).toMatchObject({ model: "gemma4:26b", stream: false, format: { type: "object" }, options: { num_ctx: 8192 } });
  });

  it("OpenAI 互換のサーバーには /v1/chat/completions を使い、JSON スキーマが通らなければ形を緩めて頼み直す", async () => {
    const formats: unknown[] = [];
    const server = fakeServer("openai", (_prompt, body) => {
      formats.push(body.response_format);
      const rf = body.response_format as { type?: string } | undefined;
      if (rf?.type === "json_schema") return new Response("schema not supported", { status: 400 });
      return goodAnswer;
    });
    const client = new LlmClient({ ...config, url: "http://pc.local:1234/v1/" }, server.fetcher);
    expect((await client.probe()).kind).toBe("openai");
    expect(await client.chatJson([{ role: "user", content: "x" }], { type: "object" })).toEqual(goodAnswer);
    expect(formats.map((f) => (f as { type?: string } | undefined)?.type)).toEqual(["json_schema", "json_object"]);
    expect(server.calls.some((c) => c.url === "http://pc.local:1234/v1/chat/completions")).toBe(true);
  });

  it("考えている途中の文や ``` の囲みが付いていても、JSON を取り出せる", () => {
    expect(parseJsonLoose('<think>まず読む…</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('結果です: {"a": {"b": 2}} 以上')).toEqual({ a: { b: 2 } });
    expect(() => parseJsonLoose("JSONではない")).toThrow(LlmError);
  });

  it("つながらないときは unreachable、URL が変なら config の失敗になる", async () => {
    const down: Fetcher = async () => {
      throw new TypeError("connection refused");
    };
    await expect(new LlmClient(config, down).probe()).rejects.toMatchObject({ kind: "unreachable" });
    await expect(new LlmClient({ ...config, url: "192.168.1.20" }, down).probe()).rejects.toMatchObject({ kind: "config" });
  });
});

describe("LLMの出力の検め", () => {
  const ctx = { day: "2026-11-18", existingTags: ["散歩", "Work"], attachedTags: ["work"] };

  it("範囲の外の値・知らない感情・長すぎる文字列・おかしな日付を捨てる", () => {
    const result = validateEntryAnalysis(
      {
        summary: "  とても  長い  " + "あ".repeat(100),
        mood: 7,
        emotions: ["楽しさ", "知らない感情", "楽しさ", "疲れ", "不安", "安心"],
        topics: ["散歩", "", "あ".repeat(30), "散歩", 3],
        tag_ideas: ["WORK", "#散歩", "新しいタグ", "四つ目", "五つ目"],
        plan_ideas: [
          { date: "2026-11-24", time: "9:05", title: "歯医者" },
          { date: "2026-11-17", time: "", title: "過去の予定" },
          { date: "2026-02-30", time: "", title: "暦に無い日" },
          { date: "2028-01-01", time: "", title: "遠すぎる" },
          { date: "2026-11-25", time: "25:00", title: "変な時刻" },
          { date: "2026-11-24", time: "09:05", title: "歯医者" },
        ],
      },
      ctx,
    );
    expect([...result.summary].length).toBeLessThanOrEqual(60);
    expect(result.summary.startsWith("とても 長い")).toBe(true);
    expect(result.mood).toBe(2);
    expect(result.emotions).toEqual(["楽しさ", "疲れ", "不安"]);
    expect(result.topics).toEqual(["散歩"]);
    // 既にあるタグの書き方にそろえ、付いているタグ（Work）は外す
    expect(result.tag_ideas).toEqual(["散歩", "新しいタグ", "四つ目"]);
    expect(result.plan_ideas).toEqual([{ date: "2026-11-24", time: "09:05", title: "歯医者" }]);
  });

  it("形がまるで違っても、例外にせず空の結果にする", () => {
    expect(validateEntryAnalysis(null, ctx)).toEqual({ summary: "", mood: null, emotions: [], topics: [], tag_ideas: [], plan_ideas: [] });
    expect(validateEntryAnalysis({ mood: "1" }, ctx).mood).toBe(1);
  });

  it("振り返りの見どころは、その週の日付だけ", () => {
    const review = validateReview(
      {
        title: "冬の入り口",
        body: "一段落目。\n\n二段落目。",
        mood_note: "後半にかけて上向き",
        highlights: [
          { date: "2026-11-16", text: "散歩" },
          { date: "2026-11-30", text: "週の外" },
          { date: "2026-11-16", text: "重複" },
        ],
      },
      { start: "2026-11-15", end: "2026-11-21" },
    );
    expect(review.body).toBe("一段落目。\n二段落目。");
    expect(review.highlights).toEqual([{ date: "2026-11-16", text: "散歩" }]);
  });

  it("指示文には、日記の日付（曜日つき）・本文・記録・既存のタグが入る", () => {
    const messages = entryMessages(
      {
        id: "x",
        day: "2026-11-18",
        title: "散歩",
        body: "来週の火曜に歯医者。",
        structures: [{ name: "体調", fields: [{ label: "気分", value: "4 / 5" }] }],
        tags: ["外出"],
        content_at: 1,
      },
      ["外出", "読書"],
    );
    const user = messages[1].content;
    expect(user).toContain("2026年11月18日（水）");
    expect(user).toContain("来週の火曜に歯医者。");
    expect(user).toContain("体調: 気分 = 4 / 5");
    expect(user).toContain("これまでに使ったタグ: 外出、読書");
  });
});

describe("日記の分析の流れ", () => {
  it("書き終えてしばらくたった日記だけを分析し、結果は日記の最終更新を動かさない", async () => {
    const { repo } = await openTestDb();
    const id = await repo.createEntry("2026-11-18");
    await repo.updateEntry(id, { title: "散歩", body: "川沿いを歩いた。来週の火曜15時に歯医者。" });
    // 書いたばかりのものは、まだ待ちの列に出ない
    expect(await repo.analysisQueue({ settledBefore: Date.now() - 60_000, limit: 10 })).toEqual([]);
    expect(await repo.analysisPending()).toBe(1);
    const queue = await repo.analysisQueue({ settledBefore: Date.now() + 1, limit: 10 });
    expect(queue).toEqual([id]);

    const before = (await repo.getEntry(id))!;
    const server = fakeServer("ollama", () => goodAnswer);
    const client = new LlmClient(config, server.fetcher);
    expect(await analyzeEntry(repo, client, config.model, id)).toBe("analyzed");

    const analysis = (await repo.getAnalysis(id))!;
    expect(analysis).toMatchObject({ summary: goodAnswer.summary, mood: 1, emotions: ["穏やか", "楽しさ"], stale: false, model: "gemma4:26b" });
    expect(analysis.plan_ideas).toEqual(goodAnswer.plan_ideas);
    expect((await repo.getEntry(id))!.edited_at).toBe(before.edited_at);
    expect(await repo.analysisPending()).toBe(0);
    expect(await repo.analysisQueue({ settledBefore: Date.now() + 1, limit: 10 })).toEqual([]);
  });

  it("書き換えると分析し直しの対象になり、中身が同じなら LLM には頼まない", async () => {
    const { repo } = await openTestDb();
    const id = await repo.createEntry("2026-11-18");
    await repo.updateEntry(id, { body: "最初の本文" });
    const server = fakeServer("ollama", () => goodAnswer);
    const client = new LlmClient(config, server.fetcher);
    await analyzeEntry(repo, client, config.model, id);
    const chats = () => server.calls.filter((c) => c.url.endsWith("/api/chat")).length;
    expect(chats()).toBe(1);

    await new Promise((r) => setTimeout(r, 3));
    await repo.updateEntry(id, { body: "最初の本文" }); // 同じ中身で保存し直しただけ
    expect((await repo.getAnalysis(id))!.stale).toBe(true);
    expect(await analyzeEntry(repo, client, config.model, id)).toBe("unchanged");
    expect(chats()).toBe(1);
    expect((await repo.getAnalysis(id))!.stale).toBe(false);

    await new Promise((r) => setTimeout(r, 3));
    await repo.updateEntry(id, { body: "書き換えた本文" });
    expect(await analyzeEntry(repo, client, config.model, id)).toBe("analyzed");
    expect(chats()).toBe(2);

    // 構造の値を変えても、分析し直しの対象になる
    await new Promise((r) => setTimeout(r, 3));
    const s = await repo.addBlankStructure(id, "体調");
    await repo.updateStructure(s, { fields: [{ id: "a", label: "気分", type: "rating" }], values: { a: 4 } });
    expect((await repo.getAnalysis(id))!.stale).toBe(true);
    // タグを付けただけなら、対象にならない
    await analyzeEntry(repo, client, config.model, id);
    const tag = (await repo.findOrCreateTag("散歩"))!;
    await repo.setTagLinked("entry", id, tag.id, true);
    expect((await repo.getAnalysis(id))!.stale).toBe(false);
  });

  it("空の日記は LLM に頼まず、待ちの列から外す。ゴミ箱の中は対象外、完全に削除すると分析も消える", async () => {
    const { repo } = await openTestDb();
    const blank = await repo.createEntry("2026-11-18");
    const trashed = await repo.createEntry("2026-11-17");
    await repo.updateEntry(trashed, { body: "消す日記" });
    await repo.trashEntry(trashed);
    const server = fakeServer("ollama", () => goodAnswer);
    const client = new LlmClient(config, server.fetcher);
    expect(await repo.analysisQueue({ settledBefore: Date.now() + 1, limit: 10 })).toEqual([blank]);
    await analyzeEntry(repo, client, config.model, blank);
    expect(server.calls.filter((c) => c.url.endsWith("/api/chat"))).toHaveLength(0);
    expect(await repo.analysisPending()).toBe(0);
    expect(await analyzeEntry(repo, client, config.model, trashed)).toBe("skipped");

    await repo.restoreEntry(trashed);
    await analyzeEntry(repo, client, config.model, trashed);
    expect(await repo.getAnalysis(trashed)).not.toBeNull();
    await repo.trashEntry(trashed);
    await repo.purgeEntry(trashed);
    expect(await repo.getAnalysis(trashed)).toBeNull();
  });

  it("ロック中の日記も分析でき、日記はロックされたまま変わらない", async () => {
    const { repo } = await openTestDb();
    const id = await repo.createEntry("2026-11-18");
    await repo.updateEntry(id, { body: "大事な日" });
    await repo.setLocked(id, true);
    const before = (await repo.getEntry(id))!;
    await analyzeEntry(repo, new LlmClient(config, fakeServer("ollama", () => goodAnswer).fetcher), config.model, id);
    expect((await repo.getEntry(id))!).toEqual(before);
    expect((await repo.getAnalysis(id))!.summary).toBe(goodAnswer.summary);
  });

  it("候補を外すと記録され、分析し直しても外したままになる", async () => {
    const { repo } = await openTestDb();
    const id = await repo.createEntry("2026-11-18");
    await repo.updateEntry(id, { body: "本文" });
    const client = new LlmClient(config, fakeServer("ollama", () => goodAnswer).fetcher);
    await analyzeEntry(repo, client, config.model, id);
    await repo.dismissIdea(id, "tag:散歩");
    expect((await repo.getAnalysis(id))!.dismissed).toEqual(["tag:散歩"]);
    await new Promise((r) => setTimeout(r, 3));
    await repo.updateEntry(id, { body: "本文を書き換えた" });
    await analyzeEntry(repo, client, config.model, id);
    expect((await repo.getAnalysis(id))!.dismissed).toEqual(["tag:散歩"]);
    // すべて分析し直すと、外した記録も消える
    await repo.clearAnalyses();
    await analyzeEntry(repo, client, config.model, id);
    expect((await repo.getAnalysis(id))!.dismissed).toEqual([]);
  });

  it("出力にまとめが無ければ失敗として扱い、何も保存しない", async () => {
    const { repo } = await openTestDb();
    const id = await repo.createEntry("2026-11-18");
    await repo.updateEntry(id, { body: "本文" });
    const client = new LlmClient(config, fakeServer("ollama", () => ({ mood: 1 })).fetcher);
    await expect(analyzeEntry(repo, client, config.model, id)).rejects.toMatchObject({ kind: "parse" });
    expect(await repo.getAnalysis(id)).toBeNull();
  });
});

describe("気分・感情の集計と、週の振り返り", () => {
  async function setup() {
    const { repo, db } = await openTestDb();
    const answers: Record<string, unknown> = {
      楽しい: { ...goodAnswer, summary: "楽しい日", mood: 2, emotions: ["楽しさ", "わくわく"] },
      疲れた: { ...goodAnswer, summary: "疲れた日", mood: -1, emotions: ["疲れ"] },
      ふつう: { ...goodAnswer, summary: "ふつうの日", mood: 0, emotions: ["穏やか", "疲れ"] },
    };
    const server = fakeServer("ollama", (prompt) => {
      if (prompt.includes("期間:")) {
        return {
          title: "上り下りのあった週",
          body: "月曜は楽しかった。\n水曜は少し疲れた。",
          mood_note: "週の半ばに少し沈んだ",
          highlights: [{ date: "2026-11-16", text: "楽しかった日" }],
        };
      }
      const key = Object.keys(answers).find((k) => prompt.includes(k))!;
      return answers[key];
    });
    const client = new LlmClient(config, server.fetcher);
    const ids: Record<string, string> = {};
    for (const [day, body] of [
      ["2026-11-16", "楽しい"],
      ["2026-11-18", "疲れた"],
      ["2026-11-18", "ふつう"],
    ]) {
      const id = await repo.createEntry(day);
      await repo.updateEntry(id, { body });
      ids[body] = id;
    }
    return { repo, db, client, server, ids };
  }

  it("日ごとの気分の平均と、感情の回数を数える（分析済みのものだけ）", async () => {
    const { repo, client, ids } = await setup();
    expect((await repo.moodByDay("2026-11-15", "2026-11-21")).size).toBe(0);
    for (const id of Object.values(ids)) await analyzeEntry(repo, client, config.model, id);
    expect(Object.fromEntries(await repo.moodByDay("2026-11-15", "2026-11-21"))).toEqual({
      "2026-11-16": { mood: 2, entries: 1 },
      "2026-11-18": { mood: -0.5, entries: 2 },
    });
    expect(await repo.emotionCounts("2026-11-15", "2026-11-21")).toEqual([
      { emotion: "疲れ", count: 2 },
      { emotion: "わくわく", count: 1 },
      { emotion: "楽しさ", count: 1 },
      { emotion: "穏やか", count: 1 },
    ]);
    await repo.trashEntry(ids["楽しい"]);
    expect((await repo.moodByDay("2026-11-15", "2026-11-21")).has("2026-11-16")).toBe(false);
  });

  it("週が終わり、すべて分析済みになったら振り返りを作る。日記を書き換えると「古い」と分かる", async () => {
    const { repo, client, ids } = await setup();
    const start = "2026-11-15";
    expect(await reviewDue(repo, start, "2026-11-25")).toBe(false); // まだ分析していない
    for (const id of Object.values(ids)) await analyzeEntry(repo, client, config.model, id);
    expect(await reviewDue(repo, start, "2026-11-20")).toBe(false); // 週が終わっていない
    expect(await reviewDue(repo, start, "2026-11-25")).toBe(true);

    expect(await makeReview(repo, client, config.model, start)).toBe(true);
    const review = (await repo.getReview(start))!;
    expect(review).toMatchObject({
      period_start: "2026-11-15",
      period_end: "2026-11-21",
      title: "上り下りのあった週",
      body: "月曜は楽しかった。\n水曜は少し疲れた。",
      highlights: [{ date: "2026-11-16", text: "楽しかった日" }],
      stale: false,
    });
    expect(await reviewDue(repo, start, "2026-11-25")).toBe(false); // もう作った

    await new Promise((r) => setTimeout(r, 3));
    await repo.updateEntry(ids["疲れた"], { body: "疲れたけど持ち直した" });
    expect((await repo.getReview(start))!.stale).toBe(true);
    expect(await makeReview(repo, client, config.model, "2026-10-04")).toBe(false); // 日記の無い週
  });

  it("分析と振り返りも、他の端末に届く", async () => {
    const { repo, db, client, ids } = await setup();
    for (const id of Object.values(ids)) await analyzeEntry(repo, client, config.model, id);
    await makeReview(repo, client, config.model, "2026-11-15");
    const remote = new FakeRemote();
    const other = await openTestDb();
    await syncOnce(db, remote);
    await syncOnce(other.db, remote);
    expect((await other.repo.getAnalysis(ids["楽しい"]))!).toMatchObject({ summary: "楽しい日", mood: 2, stale: false });
    expect((await other.repo.getReview("2026-11-15"))!.stale).toBe(false);
    expect(await other.repo.analysisPending()).toBe(0);
  });
});

describe("同梱のエンジン", () => {
  it("モデルの取得の進み具合を、ファイルごとに足し合わせる（順番が前後しても減らさない）", async () => {
    const { PullTracker } = await import("../src/llm/engine");
    const t = new PullTracker();
    expect(t.update({ status: "pulling manifest" })).toEqual({ status: "pulling manifest", completed: 0, total: 0 });
    t.update({ status: "pulling a", digest: "sha256:a", total: 1000, completed: 100 });
    t.update({ status: "pulling b", digest: "sha256:b", total: 10, completed: 10 });
    t.update({ status: "pulling a", digest: "sha256:a", total: 1000, completed: 50 }); // 古い知らせ
    expect(t.progress()).toEqual({ status: "pulling a", completed: 110, total: 1010 });
    t.update({ status: "pulling a", digest: "sha256:a", total: 1000, completed: 1000 });
    expect(t.done).toBe(false);
    t.update({ status: "success" });
    expect(t.done).toBe(true);
    expect(t.progress()).toMatchObject({ completed: 1010, total: 1010 });
    const failed = new PullTracker();
    failed.update({ error: "pull model manifest: file does not exist" });
    expect(failed.error).toContain("does not exist");
  });

  it("Windows では 26B、Mac とそれ以外では E4B を最初に選ぶ", async () => {
    const { defaultModel, sameModel } = await import("../src/llm/engine");
    expect(defaultModel("windows")).toBe("gemma4:26b-a4b-it-q4_K_M");
    expect(defaultModel("macos")).toBe("gemma4:e4b-it-q4_K_M");
    expect(defaultModel("linux")).toBe("gemma4:e4b-it-q4_K_M");
    expect(sameModel("gemma4", "gemma4:latest")).toBe(true);
    expect(sameModel("GEMMA4:E4B", "gemma4:e4b")).toBe(true);
    expect(sameModel("gemma4:e4b", "gemma4:26b")).toBe(false);
  });

  it("前の版の設定は、URL があれば「ほかのPCのサーバー」として引き継ぐ", async () => {
    const { loadConfig, effectiveModel } = await import("../src/llm/controller");
    const old = loadConfig(JSON.stringify({ url: "http://192.168.1.20:11434", model: "gemma4:26b", enabled: true, contextLength: 8192 }));
    // 前の版の既定のモデル名は、Q4_K_M を明示した名前に読み替える
    expect(old.config).toMatchObject({ mode: "remote", url: "http://192.168.1.20:11434", model: "gemma4:26b-a4b-it-q4_K_M", enabled: true, share: false });
    expect(loadConfig(JSON.stringify({ mode: "builtin", model: "gemma4:e4b" })).config.model).toBe("gemma4:e4b-it-q4_K_M");
    expect(loadConfig(JSON.stringify({ mode: "builtin", model: "qwen3:8b" })).config.model).toBe("qwen3:8b");
    expect(loadConfig(JSON.stringify({ mode: "builtin" })).config.model).toBe("");
    const fresh = loadConfig(null);
    expect(fresh.config).toMatchObject({ mode: "builtin", model: "", enabled: false });
    const engine = { available: true, running: false, port: 11545, share: false, os: "macos", models_dir: "", log_path: "", lan_address: null, models: [], pid: null };
    expect(effectiveModel(fresh.config, engine)).toBe("gemma4:e4b-it-q4_K_M");
    expect(effectiveModel(fresh.config, { ...engine, os: "windows" })).toBe("gemma4:26b-a4b-it-q4_K_M");
    expect(effectiveModel({ ...fresh.config, model: "gemma4:26b" }, engine)).toBe("gemma4:26b");
    expect(loadConfig("{壊れている").saved).toBe(false);
  });
});
