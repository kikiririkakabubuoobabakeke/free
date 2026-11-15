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

export interface Entry {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
  body: string;
  created_at: number;
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
