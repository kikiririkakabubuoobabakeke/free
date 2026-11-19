import { weekSourceHash, type Repo } from "../db/repo";
import { hashText } from "../db/util";
import { addDays } from "../ui/days";
import { LlmError, type LlmClient } from "./client";
import {
  ENTRY_SCHEMA,
  REVIEW_SCHEMA,
  entryContent,
  entryMessages,
  isBlank,
  reviewMessages,
  validateEntryAnalysis,
  validateReview,
} from "./prompts";

/** 頼み方を変えたら上げる。上がると、すべての日記が分析し直しの対象になる。 */
export const PROMPT_VERSION = 1;

/**
 * 日記を1件分析して保存する。
 * - analyzed: LLM に分析させた
 * - unchanged: 前に分析したときと中身が同じだったので、LLM には頼まなかった
 * - skipped: 日記が無い（消された・ゴミ箱の中）
 */
export async function analyzeEntry(
  repo: Repo,
  client: LlmClient,
  model: string,
  id: string,
): Promise<"analyzed" | "unchanged" | "skipped"> {
  const source = await repo.analysisSource(id);
  if (!source) return "skipped";
  const hash = hashText(`v${PROMPT_VERSION}\n${entryContent(source)}`);

  if (isBlank(source)) {
    // 中身の無い日記は、空の分析を置いて、待ちの列から外す
    await repo.saveAnalysis(
      id,
      { summary: "", mood: null, emotions: [], topics: [], tag_ideas: [], plan_ideas: [] },
      { sourceHash: hash, contentAt: source.content_at, model: "" },
    );
    return "analyzed";
  }
  if ((await repo.analysisHash(id)) === hash) {
    await repo.touchAnalysis(id, source.content_at);
    return "unchanged";
  }

  const existingTags = (await repo.listTags()).map((t) => t.name);
  const raw = await client.chatJson(entryMessages(source, existingTags), ENTRY_SCHEMA, { temperature: 0.2 });
  const result = validateEntryAnalysis(raw, { day: source.day, existingTags, attachedTags: source.tags });
  if (!result.summary) throw new LlmError("parse", "LLMの出力に、まとめが入っていませんでした");
  await repo.saveAnalysis(id, result, { sourceHash: hash, contentAt: source.content_at, model });
  return "analyzed";
}

/** start（日曜日）からの1週間の振り返りを作って保存する。日記が1件も無ければ false。 */
export async function makeReview(repo: Repo, client: LlmClient, model: string, start: string): Promise<boolean> {
  const end = addDays(start, 6);
  const entries = await repo.weekEntries(start, end);
  if (!entries.length) return false;
  const raw = await client.chatJson(reviewMessages(start, end, entries), REVIEW_SCHEMA, { temperature: 0.6 });
  const review = validateReview(raw, { start, end });
  if (!review.body) throw new LlmError("parse", "LLMの出力に、振り返りの文章が入っていませんでした");
  await repo.saveReview(start, end, review, { sourceHash: weekSourceHash(entries), model });
  return true;
}

/**
 * 振り返りを自動で作ってよい週か。
 * 週が終わっていて、日記があり、その週の日記がすべて分析済みで、まだ振り返りが無いこと。
 */
export async function reviewDue(repo: Repo, start: string, today: string): Promise<boolean> {
  const end = addDays(start, 6);
  if (end >= today) return false;
  if (await repo.getReview(start)) return false;
  const entries = await repo.weekEntries(start, end);
  return entries.length > 0 && entries.every((e) => e.analyzed);
}
