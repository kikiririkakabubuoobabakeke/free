import type { AnalysisSource, WeekEntry } from "../db/repo";
import { EMOTIONS, type AnalysisResult, type PlanIdea } from "../db/types";
import type { ChatMessage } from "./client";

/**
 * LLM への頼み方（指示文と、返させる JSON の形）と、返ってきたものの検め。
 * LLM の出力は信用せず、型・長さ・範囲をすべて確かめてから使う。
 */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
/** 1件の日記で LLM に渡す本文の上限。これより長い分は省く。 */
const BODY_LIMIT = 6000;
/** 振り返りで渡す本文の抜粋の合計の上限 */
const WEEK_EXCERPT_BUDGET = 4000;

function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 2026-02-30 のような、暦に無い日は受け付けない
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/** 例: 2026年11月18日（水） */
export function japaneseDate(day: string): string {
  const d = parseDay(day);
  if (!d) return day;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
}

function daysBetween(a: string, b: string): number {
  const da = parseDay(a);
  const db = parseDay(b);
  if (!da || !db) return NaN;
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

const SYSTEM = [
  "あなたは、日記を書いた本人のための記録係です。渡された日記を読み、指定された形のJSONだけを返してください。",
  "- 日記に書かれていることだけを根拠にしてください。書かれていない出来事や気持ちを作らないでください。",
  "- 診断・評価・助言・説教はしないでください。",
  "- 文章はすべて自然な日本語で書いてください。",
].join("\n");

// ---------------------------------------------------------------- 日記ごとの分析

export const ENTRY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    mood: { type: "integer", enum: [-2, -1, 0, 1, 2] },
    emotions: { type: "array", items: { type: "string", enum: [...EMOTIONS] } },
    topics: { type: "array", items: { type: "string" } },
    tag_ideas: { type: "array", items: { type: "string" } },
    plan_ideas: {
      type: "array",
      items: {
        type: "object",
        properties: { date: { type: "string" }, time: { type: "string" }, title: { type: "string" } },
        required: ["date", "time", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "mood", "emotions", "topics", "tag_ideas", "plan_ideas"],
  additionalProperties: false,
};

/** 中身が空の日記は分析しない */
export function isBlank(source: AnalysisSource): boolean {
  return !source.title.trim() && !source.body.trim() && source.structures.every((s) => s.fields.length === 0);
}

/** 分析に渡す内容そのもの。これが同じなら、分析し直す必要はない。 */
export function entryContent(source: AnalysisSource): string {
  const lines = [`日記の日付: ${japaneseDate(source.day)}`];
  if (source.title.trim()) lines.push(`題: ${source.title.trim()}`);
  const body = source.body.trim();
  lines.push("本文:", '"""', body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}\n（以下略）` : body, '"""');
  const structures = source.structures.filter((s) => s.fields.length > 0);
  if (structures.length) {
    lines.push("記録:");
    for (const s of structures) lines.push(`- ${s.name || "記録"}: ${s.fields.map((f) => `${f.label} = ${f.value}`).join("、")}`);
  }
  return lines.join("\n");
}

export function entryMessages(source: AnalysisSource, existingTags: string[]): ChatMessage[] {
  const attached = source.tags.length ? source.tags.join("、") : "なし";
  const known = existingTags.slice(0, 200).join("、") || "なし";
  const user = [
    entryContent(source),
    `この日記に付いているタグ: ${attached}`,
    `これまでに使ったタグ: ${known}`,
    "",
    "次の項目を出してください。",
    "summary: 日記の内容を40字以内の一文で。",
    "mood: 書き手の気分。-2=とても沈んでいる、-1=やや沈んでいる、0=どちらとも言えない、1=良い、2=とても良い。",
    `emotions: 日記に表れている感情を、次の中から多くて3つ: ${EMOTIONS.join("、")}`,
    "topics: 日記の話題を表す短い名詞を多くて5つ。",
    "tag_ideas: この日記に付けるとよさそうなタグを多くて3つ。できるだけ「これまでに使ったタグ」から選び、ぴったりのものが無いときだけ短い新しい名前にする。既に付いているタグは入れない。",
    "plan_ideas: 日記の日付より後にする予定・約束・やることが書かれていれば、多くて5つ。date は日記の日付を基準に「明日」「来週の火曜」などを YYYY-MM-DD に直したもの。time は時刻が書かれていれば HH:MM、無ければ空文字。title は20字以内。日付が決められないものは入れない。無ければ空の配列。",
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function stringList(v: unknown, opts: { max: number; maxLength: number }): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const s = asString(item);
    if (!s || [...s].length > opts.maxLength) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= opts.max) break;
  }
  return out;
}

function normalizeTime(v: unknown): string | null {
  const s = asString(v);
  if (!s) return "";
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** LLM の出力を検めて、保存してよい形にする */
export function validateEntryAnalysis(
  raw: unknown,
  ctx: { day: string; existingTags: string[]; attachedTags: string[] },
): AnalysisResult {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const moodNumber = typeof o.mood === "number" ? o.mood : typeof o.mood === "string" ? Number(o.mood) : NaN;
  const mood = Number.isFinite(moodNumber) ? Math.max(-2, Math.min(2, Math.round(moodNumber))) : null;

  // 知らない語を除いてから、3つに絞る
  const emotions = stringList(
    Array.isArray(o.emotions) ? o.emotions.filter((e) => (EMOTIONS as readonly string[]).includes(asString(e))) : [],
    { max: 3, maxLength: 10 },
  );

  // 既にあるタグと同じ名前（大文字小文字の違いも含む）は、既にある方の書き方にそろえる
  const known = new Map(ctx.existingTags.map((t) => [t.toLowerCase(), t]));
  const attached = new Set(ctx.attachedTags.map((t) => t.toLowerCase()));
  // 既に付いているタグを除いてから、3つに絞る
  const tagIdeas = stringList(
    (Array.isArray(o.tag_ideas) ? o.tag_ideas : [])
      .map((t) => asString(t).replace(/^[#＃]/, "").trim())
      .map((t) => known.get(t.toLowerCase()) ?? t)
      .filter((t) => t && !attached.has(t.toLowerCase())),
    { max: 3, maxLength: 20 },
  );

  const plans: PlanIdea[] = [];
  const seenPlans = new Set<string>();
  for (const item of Array.isArray(o.plan_ideas) ? o.plan_ideas : []) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const date = asString(p.date);
    const time = normalizeTime(p.time);
    const title = asString(p.title);
    const ahead = daysBetween(ctx.day, date);
    // 日記の日より前や、1年より先の日付は、読み違いとみなして捨てる
    if (!parseDay(date) || !(ahead >= 0 && ahead <= 366) || time === null || !title || [...title].length > 40) continue;
    const key = `${date} ${time} ${title}`;
    if (seenPlans.has(key)) continue;
    seenPlans.add(key);
    plans.push({ date, time, title });
    if (plans.length >= 5) break;
  }

  return {
    summary: cut(asString(o.summary), 60),
    mood,
    emotions,
    topics: stringList(o.topics, { max: 5, maxLength: 20 }),
    tag_ideas: tagIdeas,
    plan_ideas: plans,
  };
}

// ---------------------------------------------------------------- 週の振り返り

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    mood_note: { type: "string" },
    highlights: {
      type: "array",
      items: {
        type: "object",
        properties: { date: { type: "string" }, text: { type: "string" } },
        required: ["date", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "body", "mood_note", "highlights"],
  additionalProperties: false,
};

const MOOD_WORDS: Record<number, string> = { [-2]: "とても沈んでいる", [-1]: "やや沈んでいる", 0: "ふつう", 1: "良い", 2: "とても良い" };

export function reviewMessages(start: string, end: string, entries: WeekEntry[]): ChatMessage[] {
  const perEntry = Math.max(120, Math.floor(WEEK_EXCERPT_BUDGET / Math.max(1, entries.length)));
  const blocks = entries.map((e) => {
    const facts: string[] = [];
    if (e.mood !== null) facts.push(`気分: ${MOOD_WORDS[Math.round(e.mood)] ?? "ふつう"}`);
    if (e.emotions.length) facts.push(`感情: ${e.emotions.join("、")}`);
    if (e.topics.length) facts.push(`話題: ${e.topics.join("、")}`);
    const body = e.body.trim();
    return [
      `■ ${japaneseDate(e.day)}${e.title.trim() ? `「${e.title.trim()}」` : ""}`,
      facts.length ? facts.join("／") : "",
      e.summary ? `まとめ: ${e.summary}` : "",
      body ? `本文の抜粋: ${body.length > perEntry ? `${body.slice(0, perEntry)}…` : body}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  const user = [
    `期間: ${japaneseDate(start)}〜${japaneseDate(end)}`,
    "この期間の日記:",
    ...blocks,
    "",
    "次の項目を出してください。",
    "title: この期間を表す短い題（20字以内）。",
    "body: 書き手に宛てた振り返りの文章。200〜400字で、2〜3段落（段落の間は改行）。出来事と気持ちの流れを、日記の言葉を拾いながらやさしくまとめる。評価・助言・説教はしない。",
    "mood_note: 気分の流れについての一言（40字以内）。",
    "highlights: 特に印象に残った日を多くて3つ。date は上の期間内の YYYY-MM-DD、text はその日のことを30字以内で。",
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

export function validateReview(
  raw: unknown,
  ctx: { start: string; end: string },
): { title: string; body: string; mood_note: string; highlights: { date: string; text: string }[] } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const body =
    typeof o.body === "string"
      ? o.body
          .split(/\n+/)
          .map((p) => p.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("\n")
      : "";
  const highlights: { date: string; text: string }[] = [];
  for (const item of Array.isArray(o.highlights) ? o.highlights : []) {
    if (!item || typeof item !== "object") continue;
    const h = item as Record<string, unknown>;
    const date = asString(h.date);
    const text = asString(h.text);
    if (!parseDay(date) || date < ctx.start || date > ctx.end || !text) continue;
    if (highlights.some((x) => x.date === date)) continue;
    highlights.push({ date, text: cut(text, 50) });
    if (highlights.length >= 3) break;
  }
  return {
    title: cut(asString(o.title), 30),
    body: cut(body, 1200),
    mood_note: cut(asString(o.mood_note), 60),
    highlights,
  };
}
