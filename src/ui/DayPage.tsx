import { useState } from "react";
import type { Plan } from "../db/types";
import { toast } from "./bits";
import { freshEntries } from "./Editor";
import { addDays, todayString } from "./days";
import { formatDate } from "./format";
import { go, goBack } from "./router";
import { getApp, useDraft, useQuery } from "./store";

/** 1日分。その日の予定と、その日に並ぶ日記。 */
export function DayPage({ date }: { date: string }) {
  const { repo } = getApp();
  const plans = useQuery(() => repo.listPlans(date, date), [date]);
  const entries = useQuery(() => repo.entriesOnDay(date), [date]);
  const today = todayString();

  const writeEntry = async () => {
    const id = await repo.createEntry(date);
    freshEntries.add(id);
    go(`e/${id}`);
  };

  return (
    <div className="page day-page">
      <header className="page-header">
        <button type="button" className="btn ghost back" onClick={goBack}>
          ‹ 戻る
        </button>
        <button type="button" className="btn ghost icon" onClick={() => go(`day/${addDays(date, -1)}`, { replace: true })} aria-label="前の日">
          ‹
        </button>
        <h1>{formatDate(date)}</h1>
        <button type="button" className="btn ghost icon" onClick={() => go(`day/${addDays(date, 1)}`, { replace: true })} aria-label="次の日">
          ›
        </button>
        {date !== today && (
          <button type="button" className="btn ghost small" onClick={() => go(`day/${today}`, { replace: true })}>
            今日
          </button>
        )}
      </header>

      <section className="day-section">
        <h2>予定</h2>
        <ul className="plan-list">
          {(plans ?? []).map((p) => (
            <PlanRow key={p.id} plan={p} />
          ))}
        </ul>
        <NewPlan date={date} />
      </section>

      <section className="day-section">
        <h2>日記</h2>
        <div className="day-entries">
          {(entries ?? []).map((e) => {
            const firstLine = e.body.split("\n").find((line) => line.trim()) ?? "";
            return (
              <a key={e.id} className="day-entry" href={`#/e/${e.id}`}>
                <span className="entry-title">{e.title.trim() || firstLine || "無題"}</span>
                {e.title.trim() && firstLine && <span className="entry-excerpt">{e.body.trim()}</span>}
              </a>
            );
          })}
        </div>
        <button type="button" className="btn ghost small add" onClick={() => void writeEntry()}>
          ＋ この日の日記
        </button>
      </section>
    </div>
  );
}

function PlanRow({ plan }: { plan: Plan }) {
  const { repo } = getApp();
  const [title, setTitle] = useDraft(plan.title, (v) => repo.updatePlan(plan.id, { title: v }));
  return (
    <li className={`plan${plan.done ? " done" : ""}`}>
      <input
        type="checkbox"
        checked={plan.done}
        aria-label="済み"
        onChange={(e) => void repo.updatePlan(plan.id, { done: e.target.checked })}
      />
      <input
        type="time"
        className={`plan-time-input${plan.time ? "" : " empty"}`}
        value={plan.time}
        aria-label="時刻"
        onChange={(e) => void repo.updatePlan(plan.id, { time: e.target.value })}
      />
      <input className="plan-title" value={title} aria-label="予定" onChange={(e) => setTitle(e.target.value)} />
      <button
        type="button"
        className="btn ghost icon"
        aria-label="この予定を消す"
        onClick={async () => {
          await repo.deletePlan(plan.id);
          toast("予定を消しました", { label: "元に戻す", run: () => void repo.restorePlan(plan.id) });
        }}
      >
        ×
      </button>
    </li>
  );
}

function NewPlan({ date }: { date: string }) {
  const { repo } = getApp();
  const [time, setTime] = useState("");
  const [title, setTitle] = useState("");
  const add = async () => {
    if (!title.trim()) return;
    await repo.createPlan(date, { time, title: title.trim() });
    setTitle("");
    setTime("");
  };
  return (
    <div className="plan new">
      <span className="plan-plus" aria-hidden="true">
        ＋
      </span>
      <input type="time" className={`plan-time-input${time ? "" : " empty"}`} value={time} aria-label="新しい予定の時刻" onChange={(e) => setTime(e.target.value)} />
      <input
        className="plan-title"
        value={title}
        placeholder="予定を追加"
        aria-label="新しい予定"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          // 日本語変換の確定の Enter では追加しない
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") void add();
        }}
      />
      <button type="button" className="btn ghost small" disabled={!title.trim()} onClick={() => void add()}>
        追加
      </button>
    </div>
  );
}
