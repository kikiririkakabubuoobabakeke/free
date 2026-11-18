import { useState } from "react";
import type { Plan } from "../db/types";
import { PageHeader } from "./bits";
import { addDays, level, streak, todayString, weekStart } from "./days";
import { dayOf, formatDate } from "./format";
import { go } from "./router";
import { getApp, useQuery } from "./store";

/** 今週の前後に出す週の数 */
const WEEKS_AROUND = 4;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
/** これからの予定として出す日数 */
const UPCOMING_DAYS = 30;

/** 総合ページ。書いた量で濃さを変えたカレンダーと、これからの予定。 */
export function HomePage({ standalone }: { standalone?: boolean }) {
  const today = todayString();
  // 0 なら今週が中央。前後へ動かすと、この週数だけずれる。
  const [shift, setShift] = useState(0);
  const center = addDays(weekStart(today), shift * 7);
  const from = addDays(center, -WEEKS_AROUND * 7);
  const to = addDays(center, (WEEKS_AROUND + 1) * 7 - 1);

  return (
    <div className="page home">
      {standalone ? <PageHeader title="カレンダー" /> : null}
      <Summary today={today} />
      <Calendar from={from} to={to} today={today} centerWeek={center} />
      <div className="calendar-nav">
        <button type="button" className="btn ghost small" onClick={() => setShift(shift - WEEKS_AROUND)} aria-label="前へ">
          ↑ 前
        </button>
        <button type="button" className="btn ghost small" disabled={shift === 0} onClick={() => setShift(0)}>
          今週
        </button>
        <button type="button" className="btn ghost small" onClick={() => setShift(shift + WEEKS_AROUND)} aria-label="次へ">
          ↓ 次
        </button>
        <span className="spacer" />
        <span className="legend" aria-hidden="true">
          少
          {[1, 2, 3, 4].map((lv) => (
            <span key={lv} className={`legend-cell lv${lv}`} />
          ))}
          多
        </span>
      </div>
      <Upcoming today={today} />
    </div>
  );
}

function Summary({ today }: { today: string }) {
  const { repo } = getApp();
  const monthStart = `${today.slice(0, 7)}-01`;
  const days = useQuery(() => repo.writtenDays(), []);
  const month = useQuery(() => repo.dayStats(monthStart, today), [monthStart, today]);
  if (!days || !month) return <div className="summary" />;
  const chars = [...month.values()].reduce((sum, d) => sum + d.chars, 0);
  return (
    <div className="summary">
      <div>
        <span className="summary-label">連続</span>
        <span className="summary-value">{streak(days, today)}</span>
        <span className="summary-label">日</span>
      </div>
      <div>
        <span className="summary-label">今月</span>
        <span className="summary-value">{month.size}</span>
        <span className="summary-label">日</span>
      </div>
      <div>
        <span className="summary-value">{chars.toLocaleString()}</span>
        <span className="summary-label">字</span>
      </div>
    </div>
  );
}

function Calendar(props: { from: string; to: string; today: string; centerWeek: string }) {
  const { repo } = getApp();
  const stats = useQuery(() => repo.dayStats(props.from, props.to), [props.from, props.to]);
  const plans = useQuery(() => repo.listPlans(props.from, props.to), [props.from, props.to]);
  const plansByDay = new Map<string, Plan[]>();
  for (const p of plans ?? []) plansByDay.set(p.date, [...(plansByDay.get(p.date) ?? []), p]);

  const weeks: string[][] = [];
  for (let start = props.from; start <= props.to; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }

  return (
    <div className="calendar" role="grid" aria-label="カレンダー">
      <div className="calendar-row calendar-head" role="row">
        {WEEKDAYS.map((w) => (
          <span key={w} role="columnheader">
            {w}
          </span>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0]} role="row" className={`calendar-row${week[0] === props.centerWeek ? " center" : ""}`}>
          {week.map((day) => {
            const stat = stats?.get(day);
            const dayPlans = plansByDay.get(day) ?? [];
            const open = dayPlans.filter((p) => !p.done);
            const d = Number(day.slice(8));
            return (
              <button
                key={day}
                type="button"
                role="gridcell"
                className={[
                  "calendar-cell",
                  `lv${level(stat?.chars ?? 0)}`,
                  day === props.today ? "today" : "",
                  day > props.today ? "future" : "",
                ].join(" ")}
                title={`${formatDate(day)}${stat ? ` ${stat.chars.toLocaleString()}字` : ""}${dayPlans.length ? ` 予定${dayPlans.length}件` : ""}`}
                onClick={() => go(`day/${day}`)}
              >
                <span className="cell-day">{d === 1 ? `${Number(day.slice(5, 7))}/${d}` : d}</span>
                {open.length > 0 && (
                  <span className="cell-plans">
                    {open.slice(0, 2).map((p) => (
                      <span key={p.id} className="cell-plan">
                        {p.title || "予定"}
                      </span>
                    ))}
                    {open.length > 2 && <span className="cell-plan more">+{open.length - 2}</span>}
                    <span className="cell-dot" aria-hidden="true" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Upcoming({ today }: { today: string }) {
  const { repo } = getApp();
  const until = addDays(today, UPCOMING_DAYS - 1);
  const plans = useQuery(() => repo.listPlans(today, until), [today, until]);
  const open = (plans ?? []).filter((p) => !p.done);
  if (!plans) return null;

  const groups: { day: string; items: Plan[] }[] = [];
  for (const p of open) {
    if (groups[groups.length - 1]?.day !== p.date) groups.push({ day: p.date, items: [] });
    groups[groups.length - 1].items.push(p);
  }
  const label = (day: string) => {
    if (day === today) return "今日";
    if (day === addDays(today, 1)) return "明日";
    const { day: d, weekday } = dayOf(day);
    return `${Number(day.slice(5, 7))}月${d}日（${weekday}）`;
  };

  return (
    <section className="upcoming">
      <h2>予定</h2>
      {groups.length === 0 && <p className="hint">なし</p>}
      {groups.map((g) => (
        <div key={g.day} className="upcoming-day">
          <button type="button" className="upcoming-date" onClick={() => go(`day/${g.day}`)}>
            {label(g.day)}
          </button>
          <ul>
            {g.items.map((p) => (
              <li key={p.id}>
                <input
                  type="checkbox"
                  checked={p.done}
                  aria-label={`${p.title} を済みにする`}
                  onChange={(e) => void repo.updatePlan(p.id, { done: e.target.checked })}
                />
                {p.time && <span className="plan-time">{p.time}</span>}
                <span>{p.title || "予定"}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
