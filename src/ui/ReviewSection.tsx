import { useState } from "react";
import { addDays, weekStart } from "./days";
import { dayOf } from "./format";
import { go } from "./router";
import { getApp, useAnalysisState, useQuery } from "./store";

function weekLabel(start: string): string {
  const end = addDays(start, 6);
  const [sm, sd] = [Number(start.slice(5, 7)), Number(start.slice(8))];
  const [em, ed] = [Number(end.slice(5, 7)), Number(end.slice(8))];
  return sm === em ? `${sm}月${sd}日〜${ed}日` : `${sm}月${sd}日〜${em}月${ed}日`;
}

/** 総合ページの、週の振り返り（ローカルLLMが書いたもの） */
export function ReviewSection({ today }: { today: string }) {
  const { repo, analysis } = getApp();
  const state = useAnalysisState();
  const thisWeek = weekStart(today);
  // 最初は、終わったばかりの先週を出す
  const [start, setStart] = useState(addDays(thisWeek, -7));
  const end = addDays(start, 6);
  const review = useQuery(() => repo.getReview(start), [start]);
  const entries = useQuery(() => repo.weekEntries(start, end), [start, end]);
  const latest = useQuery(() => repo.latestReviewStart(), []);

  const configured = state.configured;
  if (review === undefined || entries === undefined || latest === undefined) return null;
  // ローカルLLMを使っておらず、振り返りも1つも無ければ、この欄は出さない
  if (!configured && latest === null) return null;

  const making = state.current === `review:${start}`;
  const current = start === thisWeek;

  return (
    <section className="review">
      <header className="review-head">
        <h2>振り返り</h2>
        <span className="review-nav">
          <button type="button" className="btn ghost icon" aria-label="前の週" onClick={() => setStart(addDays(start, -7))}>
            ‹
          </button>
          <span className="review-week">{weekLabel(start)}</span>
          <button type="button" className="btn ghost icon" aria-label="次の週" disabled={current} onClick={() => setStart(addDays(start, 7))}>
            ›
          </button>
        </span>
      </header>

      {review ? (
        <article className="review-body">
          <h3>{review.title}</h3>
          {review.body.split("\n").map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {review.mood_note && <p className="review-mood">{review.mood_note}</p>}
          {review.highlights.length > 0 && (
            <ul className="review-highlights">
              {review.highlights.map((h) => {
                const { day, weekday } = dayOf(h.date);
                return (
                  <li key={h.date}>
                    <button type="button" className="review-date" onClick={() => go(`day/${h.date}`)}>
                      {Number(h.date.slice(5, 7))}/{day}（{weekday}）
                    </button>
                    <span>{h.text}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {configured && (review.stale || current) && (
            <button type="button" className="btn ghost small" disabled={making} onClick={() => analysis.reviewNow(start)}>
              {making ? "作成中…" : "作り直す"}
            </button>
          )}
        </article>
      ) : entries.length === 0 ? (
        <p className="hint">日記なし</p>
      ) : configured ? (
        <button type="button" className="btn small" disabled={making} onClick={() => analysis.reviewNow(start)}>
          {making ? "作成中…" : current ? "ここまでの振り返りを作る" : "振り返りを作る"}
        </button>
      ) : (
        <p className="hint">なし</p>
      )}
    </section>
  );
}
