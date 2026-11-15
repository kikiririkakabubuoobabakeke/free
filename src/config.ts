/**
 * 同期つきの版としてビルドするか。
 * 既定は同期なし（オフライン版）で、日記はこの端末の中だけに保存される。
 * ビルド時に VITE_SYNC=on を付けると、Supabase を使う同期の機能が入る。
 */
export const SYNC_ENABLED = import.meta.env.VITE_SYNC === "on";
