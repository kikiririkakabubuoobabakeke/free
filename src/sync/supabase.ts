import type { SupabaseClient } from "@supabase/supabase-js";
import { base64ToBlob, blobToBase64 } from "./base64";
import type { OutgoingRecord, Remote, RemoteRecord } from "./remote";

const BUCKET = "attachments";

/** supabase/schema.sql で作った表と置き場に対する同期先 */
export class SupabaseRemote implements Remote {
  constructor(
    private readonly client: SupabaseClient,
    private readonly userId: string,
  ) {}

  async pull(afterSeq: number, limit: number): Promise<RemoteRecord[]> {
    const { data, error } = await this.client
      .from("records")
      .select("kind, id, data, updated_at, deleted, seq")
      .gt("seq", afterSeq)
      .order("seq", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      kind: r.kind,
      id: r.id,
      data: r.data ?? {},
      updated_at: Number(r.updated_at),
      deleted: !!r.deleted,
      seq: Number(r.seq),
    }));
  }

  async push(records: OutgoingRecord[]): Promise<void> {
    const { error } = await this.client.from("records").upsert(
      records.map((r) => ({ ...r, user_id: this.userId })),
      { onConflict: "user_id,kind,id" },
    );
    if (error) throw new Error(error.message);
  }

  async uploadBlob(id: string, base64: string, mime: string): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(this.path(id), base64ToBlob(base64, mime), { contentType: mime, upsert: true });
    if (error) throw new Error(error.message);
  }

  async downloadBlob(id: string): Promise<string | null> {
    const { data, error } = await this.client.storage.from(BUCKET).download(this.path(id));
    if (error) {
      // まだ上がっていない画像は「無い」として扱い、次の同期でまた試す
      const status = (error as { status?: number; originalError?: { status?: number } }).status
        ?? (error as { originalError?: { status?: number } }).originalError?.status;
      if (status === 400 || status === 404 || /not found/i.test(error.message)) return null;
      throw new Error(error.message);
    }
    return blobToBase64(data);
  }

  async deleteBlob(id: string): Promise<void> {
    const { error } = await this.client.storage.from(BUCKET).remove([this.path(id)]);
    if (error) throw new Error(error.message);
  }

  private path(id: string): string {
    return `${this.userId}/${id}`;
  }
}
