import { toDateString } from "../db/util";

/** 日付の文字列（YYYY-MM-DD）の計算。端末の時間帯の暦日で数える。 */
function parse(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function todayString(): string {
  return toDateString(new Date());
}

export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setDate(d.getDate() + days);
  return toDateString(d);
}

/** その日を含む週の始まり（日曜日） */
export function weekStart(date: string): string {
  return addDays(date, -parse(date).getDay());
}

/** 文字数を、カレンダーの濃さ（0〜4）にする */
export function level(chars: number): number {
  if (chars <= 0) return 0;
  if (chars < 200) return 1;
  if (chars < 500) return 2;
  if (chars < 1000) return 3;
  return 4;
}

/** 今日か昨日まで、1日も欠かさず書いた日数。days は新しい順の「書いた日」。 */
export function streak(days: string[], today = todayString()): number {
  const written = new Set(days);
  let day = written.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (written.has(day)) {
    n += 1;
    day = addDays(day, -1);
  }
  return n;
}
