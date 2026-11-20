import { MOOD_LABELS, type EntryDetail, type PlanIdea } from "../db/types";
import { toast } from "./bits";
import { dayOf } from "./format";
import { go } from "./router";
import { getApp, useAnalysisState, useQuery } from "./store";

/** 気分（-2〜2、平均なら小数）を、色分けの段（m2 / m1 / z / p1 / p2）にする */
export function moodClass(mood: number): string {
  const r = Math.round(mood);
  return r <= -2 ? "m2" : r === -1 ? "m1" : r === 0 ? "z" : r === 1 ? "p1" : "p2";
}

export function MoodPill({ mood }: { mood: number }) {
  return <span className={`mood-pill mood-${moodClass(mood)}`}>{MOOD_LABELS[String(Math.round(mood))]}</span>;
}

function planKey(p: PlanIdea): string {
  return `plan:${p.date} ${p.time} ${p.title}`;
}

function planLabel(p: PlanIdea): string {
  const { day, weekday } = dayOf(p.date);
  return `${Number(p.date.slice(5, 7))}月${day}日（${weekday}）${p.time ? ` ${p.time}` : ""} ${p.title}`;
}

/** 日記の画面の下に出す、ローカルLLMによる分析 */
export function AnalysisPanel({ entry }: { entry: EntryDetail }) {
  const { repo, analysis: controller } = getApp();
  const state = useAnalysisState();
  const analysis = useQuery(() => repo.getAnalysis(entry.id), [entry.id]);
  const ideaDates = (analysis?.plan_ideas ?? []).map((p) => p.date).sort();
  const plans = useQuery(
    () => (ideaDates.length ? repo.listPlans(ideaDates[0], ideaDates[ideaDates.length - 1]) : Promise.resolve([])),
    [ideaDates.join(",")],
  );

  const configured = state.configured;
  const hasContent = !!(entry.title.trim() || entry.body.trim() || entry.structures.length);
  const trashed = entry.trashed_at !== null;
  if (analysis === undefined) return null;
  if (!analysis && !configured) return null;
  if (!analysis && !hasContent) return null;

  const working = state.current === entry.id;
  const waiting = configured && hasContent && (!analysis || analysis.stale);
  const attached = new Set(entry.tags.map((t) => t.name.toLowerCase()));
  const dismissed = new Set(analysis?.dismissed ?? []);
  const tagIdeas = entry.locked || trashed ? [] : (analysis?.tag_ideas ?? []).filter((t) => !attached.has(t.toLowerCase()) && !dismissed.has(`tag:${t}`));
  const planIdeas = trashed
    ? []
    : (analysis?.plan_ideas ?? []).filter(
        (p) => !dismissed.has(planKey(p)) && !(plans ?? []).some((x) => x.date === p.date && x.title === p.title && x.time === p.time),
      );

  // 見せるものが何も無ければ（中身の無い日記の分析など）、欄ごと出さない
  if (!working && !waiting && !analysis?.summary && !tagIdeas.length && !planIdeas.length) return null;

  const addTag = async (name: string) => {
    const tag = await repo.findOrCreateTag(name);
    if (tag) await repo.setTagLinked("entry", entry.id, tag.id, true);
  };
  const addPlan = async (p: PlanIdea) => {
    await repo.createPlan(p.date, { time: p.time, title: p.title });
    toast("予定に追加しました", { label: "開く", run: () => go(`day/${p.date}`) });
  };

  return (
    <section className="analysis" aria-label="分析">
      <header className="analysis-head">
        <span className="analysis-name">分析</span>
        {working ? (
          <span className="hint">分析中…</span>
        ) : waiting ? (
          <>
            <span className="hint">
              {state.phase === "unreachable" ? "つながりません" : state.phase === "needs-model" ? "モデル未導入" : "分析待ち"}
            </span>
            <button type="button" className="btn ghost small" onClick={() => controller.analyzeNow(entry.id)}>
              今すぐ
            </button>
          </>
        ) : null}
      </header>

      {analysis && analysis.summary && (
        <>
          <p className="analysis-summary">{analysis.summary}</p>
          <div className="analysis-facts">
            {analysis.mood !== null && <MoodPill mood={analysis.mood} />}
            {analysis.emotions.map((e) => (
              <span key={e} className="emotion">
                {e}
              </span>
            ))}
            {analysis.topics.length > 0 && <span className="hint topics">{analysis.topics.join("・")}</span>}
          </div>
        </>
      )}

      {tagIdeas.length > 0 && (
        <div className="ideas">
          {tagIdeas.map((t) => (
            <span key={t} className="idea">
              <button type="button" className="idea-add" onClick={() => void addTag(t)}>
                ＋ {t}
              </button>
              <button type="button" className="idea-x" aria-label={`候補「${t}」を外す`} onClick={() => void repo.dismissIdea(entry.id, `tag:${t}`)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {planIdeas.length > 0 && (
        <div className="ideas plans">
          {planIdeas.map((p) => (
            <span key={planKey(p)} className="idea">
              <button type="button" className="idea-add" onClick={() => void addPlan(p)}>
                ＋ {planLabel(p)}
              </button>
              <button type="button" className="idea-x" aria-label={`候補「${p.title}」を外す`} onClick={() => void repo.dismissIdea(entry.id, planKey(p))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
