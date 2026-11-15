const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function parts(date: string): { y: number; m: number; d: number; w: string } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d, w: WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? "" };
}

export function formatMonth(date: string): string {
  const { y, m } = parts(date);
  return `${y}年${m}月`;
}

export function dayOf(date: string): { day: number; weekday: string } {
  const { d, w } = parts(date);
  return { day: d, weekday: w };
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
