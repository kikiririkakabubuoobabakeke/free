/** 構造の中の1項目の種類 */
export type FieldType = "text" | "longtext" | "number" | "rating" | "check" | "select";

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "短い文",
  longtext: "長い文",
  number: "数値",
  rating: "5段階",
  check: "チェック",
  select: "選択肢",
};

export interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  /** type が select のときの選択肢 */
  options?: string[];
}

export type FieldValue = string | number | boolean | null;
export type FieldValues = Record<string, FieldValue>;

/**
 * 日記の日時は3つある。
 * - date: 自分で明示的に付ける日付（「これは何日の日記か」）。付けなければ空。
 * - created_at: 作成した時刻。自動で入り、後から変わらない。
 * - 最終更新: 自動で進む。本文だけでなく構造・タグ・写真の変更も含めた値は EntryDetail.edited_at。
 */
export interface Entry {
  id: string;
  /** 明示的に付けた日付（YYYY-MM-DD）。付けていなければ空文字。 */
  date: string;
  /** 一覧で並べるときの日（YYYY-MM-DD）。date があればそれ、無ければ作成した日。 */
  day: string;
  title: string;
  body: string;
  /** 作成した時刻（ミリ秒） */
  created_at: number;
  /** エントリの行そのもの（日付・題・本文）を最後に変えた時刻。同期の新旧判定に使う。 */
  updated_at: number;
  /** ロック中は、日記の中身を何も変えられない */
  locked: boolean;
  /** ゴミ箱に入れた時刻（ミリ秒）。入っていなければ null。 */
  trashed_at: number | null;
}

/** 予定 */
export interface Plan {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** "HH:MM"。時刻を決めていない予定は空文字。 */
  time: string;
  title: string;
  done: boolean;
}

/** カレンダーの1日分 */
export interface DayStat {
  /** その日に並ぶ日記の数（ゴミ箱の中は数えない） */
  entries: number;
  /** その日に並ぶ日記の、題と本文の文字数の合計（改行は数えない） */
  chars: number;
}

/** ローカルLLMが出す、予定の候補 */
export interface PlanIdea {
  date: string;
  time: string;
  title: string;
}

/** 日記ごとの分析の中身（LLMの出力を検めたもの） */
export interface AnalysisResult {
  /** 一言のまとめ */
  summary: string;
  /** 気分。-2（沈んでいる）〜 2（とても良い）。読み取れなければ null。 */
  mood: number | null;
  /** 感情（EMOTIONS の中から最大3つ） */
  emotions: string[];
  /** 話題（短い名詞、最大5つ） */
  topics: string[];
  /** 付けるとよさそうなタグの名前（最大3つ） */
  tag_ideas: string[];
  /** 日記から読み取れた、これからの予定（最大5つ） */
  plan_ideas: PlanIdea[];
}

export interface Analysis extends AnalysisResult {
  entry_id: string;
  model: string;
  analyzed_at: number;
  /** 「要らない」と外した候補（"tag:名前" / "plan:日付 時刻 題"） */
  dismissed: string[];
  /** 分析した後に日記が書き換えられていれば true */
  stale: boolean;
}

/** 週の振り返り */
export interface Review {
  id: string;
  period_start: string;
  period_end: string;
  model: string;
  title: string;
  body: string;
  /** 気分の流れについての一言 */
  mood_note: string;
  highlights: { date: string; text: string }[];
  created_at: number;
  /** 作った後に、その週の日記が書き換えられていれば true */
  stale: boolean;
}

/** 気分を言葉にしたもの（-2〜2） */
export const MOOD_LABELS: Record<string, string> = {
  "-2": "沈んでいる",
  "-1": "沈み気味",
  "0": "ふつう",
  "1": "良い",
  "2": "とても良い",
};

/** 感情の語彙。集計できるよう、LLMにはこの中から選ばせる。 */
export const EMOTIONS = [
  "喜び",
  "楽しさ",
  "安心",
  "感謝",
  "達成感",
  "期待",
  "わくわく",
  "穏やか",
  "愛しさ",
  "懐かしさ",
  "疲れ",
  "不安",
  "緊張",
  "悲しみ",
  "寂しさ",
  "怒り",
  "苛立ち",
  "退屈",
  "後悔",
  "焦り",
] as const;

/** ゴミ箱に入れた日記を、自動で完全に削除するまでの日数 */
export const TRASH_DAYS = 30;

export interface Tag {
  id: string;
  name: string;
  color: string;
}

/** 構造のテンプレ。エントリに付けると Structure として写し取られる。 */
export interface Template {
  id: string;
  name: string;
  fields: FieldDef[];
  tags: Tag[];
  updated_at: number;
}

/**
 * エントリに付いている構造。
 * 項目の定義を自分で持つので、元のテンプレを後から変えたり消したりしても影響を受けない。
 */
export interface Structure {
  id: string;
  entry_id: string;
  template_id: string | null;
  name: string;
  fields: FieldDef[];
  values: FieldValues;
  position: number;
  tags: Tag[];
  updated_at: number;
}

export interface AttachmentMeta {
  id: string;
  entry_id: string;
  mime: string;
  width: number;
  height: number;
  position: number;
  /** この端末に画像の中身があるか（同期直後はまだ無いことがある） */
  has_data: boolean;
}

export interface EntryDetail extends Entry {
  /** 最終更新。日付・題・本文に加えて、構造・タグ・写真の変更も含めた最後の時刻（ミリ秒）。 */
  edited_at: number;
  tags: Tag[];
  structures: Structure[];
  attachments: AttachmentMeta[];
}

export interface EntrySummary extends Entry {
  tags: Tag[];
  structure_names: string[];
  photo_count: number;
}

export type TagTarget = "entry" | "structure" | "template";

export type RelationKind = "parent" | "related";

export interface TagInfo extends Tag {
  parent_id: string | null;
  related_ids: string[];
  /** このタグが付いているエントリ・構造の数（テンプレは数えない） */
  use_count: number;
}

/** タグの色。モノトーンの濃淡だけ（濃い→淡い。見た目の明るさがほぼ等間隔）。 */
export const TAG_COLORS = ["#1d1d1d", "#333333", "#4a4a4a", "#626262", "#7b7b7b", "#959595", "#b0b0b0", "#cccccc"];

/**
 * 以前の版の色の並び。同じ位置の濃淡で見せる（保存されている色は書き換えない）。
 * パステルの版・最初の版・前のモノトーンの版（6段）。
 */
const OLD_TAG_COLORS = [
  ["#e88a8f", "#f0b37a", "#a5cf8f", "#86cbbf", "#8eb6e6", "#b3a1e3", "#eaa0c8", "#b8b0b4"],
  ["#c2553f", "#c98a1b", "#5a8f3c", "#2f8f83", "#3b74c4", "#7a5cc4", "#b8508f", "#8a8f98"],
  ["#1c1c1c", "#3d3d3d", "#5e5e5e", "#7f7f7f", "#a0a0a0", "#c1c1c1"],
];

/** タグに保存されている色を、表示する色にする */
export function tagColor(color: string): string {
  const c = color.toLowerCase();
  if (TAG_COLORS.includes(c)) return c;
  const last = TAG_COLORS.length - 1;
  for (const old of OLD_TAG_COLORS) {
    const i = old.indexOf(c);
    // 並びの長さが違っても、濃い側・淡い側の位置がそろうように割り当てる
    if (i >= 0) return TAG_COLORS[Math.round((i * last) / (old.length - 1))];
  }
  return TAG_COLORS[last];
}
