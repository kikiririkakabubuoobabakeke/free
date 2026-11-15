/** クラウドに置く1行。どの表の行も、この形にして同じ場所へ置く。 */
export interface RemoteRecord {
  kind: string;
  id: string;
  data: Record<string, unknown>;
  /** 端末で最後に変更した時刻(ミリ秒)。新しい方を採用するための値。 */
  updated_at: number;
  deleted: boolean;
  /** サーバーが書き込みのたびに振る通し番号。どこまで受け取ったかの目印に使う。 */
  seq: number;
}

export type OutgoingRecord = Omit<RemoteRecord, "seq">;

/** 同期先。本番は Supabase、テストはメモリ上の偽物が実装する。 */
export interface Remote {
  /** seq が afterSeq より大きい行を、seq の小さい順に最大 limit 件 */
  pull(afterSeq: number, limit: number): Promise<RemoteRecord[]>;
  /** 行を書き込む。すでにある行より updated_at が古いものは、サーバー側で無視される。 */
  push(records: OutgoingRecord[]): Promise<void>;
  uploadBlob(id: string, base64: string, mime: string): Promise<void>;
  /** まだ置かれていなければ null */
  downloadBlob(id: string): Promise<string | null>;
  deleteBlob(id: string): Promise<void>;
}
