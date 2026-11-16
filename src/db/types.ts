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
}

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

export const TAG_COLORS = [
  "#c2553f",
  "#c98a1b",
  "#5a8f3c",
  "#2f8f83",
  "#3b74c4",
  "#7a5cc4",
  "#b8508f",
  "#8a8f98",
];
