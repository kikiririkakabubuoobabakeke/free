import { TRASH_DAYS } from "../db/types";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function parts(date: string): { y: number; m: number; d: number; w: string } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d, w: WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? "" };
}

/** 日付だけ。例: 2026年11月15日（日） */
export function formatDate(date: string): string {
  const { y, m, d, w } = parts(date);
  return `${y}年${m}月${d}日（${w}）`;
}

/** ゴミ箱から完全に削除されるまでの残り。「〜完全に削除」に続く形。例: 「あと12日で」「1日以内に」 */
export function trashRemaining(trashedAt: number, at = Date.now()): string {
  const left = Math.ceil((trashedAt + TRASH_DAYS * 86_400_000 - at) / 86_400_000);
  return left <= 1 ? "1日以内に" : `あと${left}日で`;
}

export function formatMonth(date: string): string {
  const { y, m } = parts(date);
  return `${y}年${m}月`;
}

export function dayOf(date: string): { day: number; weekday: string } {
  const { d, w } = parts(date);
  return { day: d, weekday: w };
}

/** 時刻つきの日時。例: 2026年11月15日（日）8:08 */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const w = WEEKDAYS[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${w}）${formatTime(ms)}`;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
