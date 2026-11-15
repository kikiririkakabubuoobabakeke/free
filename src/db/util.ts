import type { FieldDef, FieldValues } from "./types";

/** crypto.randomUUID は安全なコンテキスト限定なので、どのWebViewでも動く形で自前生成する */
export function uid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let lastNow = 0;
/** 同じ行の updated_at が必ず増えるよう、単調増加にした現在時刻(ミリ秒) */
export function now(): number {
  lastNow = Math.max(Date.now(), lastNow + 1);
  return lastNow;
}

export function today(): string {
  return toDateString(new Date());
}

export function toDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** LIKE のワイルドカードを打ち消して部分一致パターンにする（ESCAPE '\' と組で使う） */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 構造の中身を検索用の1本の文字列にする。項目名と値だけを含み、内部のIDは含めない。 */
export function structureSearchText(name: string, fields: FieldDef[], values: FieldValues): string {
  const parts = [name];
  for (const f of fields) {
    const v = values[f.id];
    if (v === null || v === undefined || v === "" || v === false) continue;
    parts.push(f.type === "check" ? f.label : `${f.label} ${v}`);
  }
  return parts.join("\n");
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
