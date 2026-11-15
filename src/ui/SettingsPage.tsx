import { useEffect, useState } from "react";
import { SYNC_ENABLED } from "../config";
import { isTauri } from "../db/driver";
import { PageHeader } from "./bits";
import { formatTime } from "./format";
import { getSync, useSyncState } from "./store";

export function SettingsPage() {
  return (
    <div className="page">
      <PageHeader title="設定" />
      {SYNC_ENABLED && <SyncSection />}
      <StorageSection />
    </div>
  );
}

/** 日記がどこに保存されているかと、控えの取り方 */
function StorageSection() {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/path").then(async ({ appConfigDir, join }) => {
      // tauri-plugin-sql が diary.db を置く場所と同じ
      setPath(await join(await appConfigDir(), "diary.db"));
    });
  }, []);

  return (
    <section className="card">
      <h2>保存場所</h2>
      <p>
        {SYNC_ENABLED
          ? "日記はまずこの端末の中に保存され、ログインしていれば他の端末と同期されます。"
          : "この版は同期なしです。日記はこの端末の中だけに保存され、外へは何も送られません。"}
      </p>
      {path ? (
        <>
          <code className="path">{path}</code>
          <p className="hint">
            このファイル1つに、日記・構造・タグ・写真がすべて入っています。控えを取るときは、アプリを終了してから
            このファイルを別の場所へコピーしてください。別のパソコンへ移すときも、同じ場所にこのファイルを置けば引き継げます。
            Mac では、Finder の「移動」→「フォルダへ移動」に上の場所を貼ると開けます。Time Machine を使っていれば自動で控えられます。
          </p>
        </>
      ) : (
        <p className="hint">いまはブラウザで開いているので、日記はこのブラウザの中に保存されています。</p>
      )}
    </section>
  );
}

/** 同期の設定。接続先 → ログイン → 同期の状態、の順に進む。 */
function SyncSection() {
  const sync = getSync();
  const state = useSyncState();
  const [editingConfig, setEditingConfig] = useState(false);

  return (
    <section className="card">
      <h2>同期</h2>
      {!state.config || editingConfig ? (
        <ConfigForm onDone={() => setEditingConfig(false)} canCancel={!!state.config} />
      ) : !state.email ? (
        <>
          <LoginForm />
          <button type="button" className="btn ghost small" onClick={() => setEditingConfig(true)}>
            接続先を変更
          </button>
        </>
      ) : (
        <>
          <dl className="status">
            <dt>アカウント</dt>
            <dd>{state.email}</dd>
            <dt>状態</dt>
            <dd>
              {state.phase === "syncing"
                ? "同期中…"
                : state.phase === "error"
                  ? "エラー"
                  : state.lastSyncedAt
                    ? `同期済み（${formatTime(state.lastSyncedAt)}）`
                    : "同期待ち"}
            </dd>
          </dl>
          {state.error && <p className="error">{state.error}</p>}
          <div className="row">
            <button type="button" className="btn primary" disabled={state.phase === "syncing"} onClick={() => void sync.syncNow()}>
              今すぐ同期
            </button>
            <button type="button" className="btn" onClick={() => void sync.signOut()}>
              ログアウト
            </button>
          </div>
          <p className="hint">
            書いた内容は数秒後に自動で送られ、他の端末の変更は1分ごとと、アプリを開き直したときに受け取ります。
            ログアウトしても、この端末の日記は消えません。
          </p>
        </>
      )}
    </section>
  );
}

function ConfigForm(props: { onDone: () => void; canCancel: boolean }) {
  const sync = getSync();
  const current = sync.getState().config;
  const [url, setUrl] = useState(current?.url ?? "");
  const [key, setKey] = useState(current?.key ?? "");
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void sync.setConfig({ url: url.trim().replace(/\/+$/, ""), key: key.trim() }).then(props.onDone);
      }}
    >
      <p className="hint">Supabase のプロジェクトの「Project URL」と「anon（publishable）key」を入れてください。作り方は README にあります。</p>
      <label className="field">
        <span className="field-label">Project URL</span>
        <input className="input" type="url" required value={url} placeholder="https://xxxx.supabase.co" autoCapitalize="none" autoCorrect="off" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">anon key</span>
        <input className="input" required value={key} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" className="btn primary">
          保存
        </button>
        {props.canCancel && (
          <button type="button" className="btn" onClick={props.onDone}>
            やめる
          </button>
        )}
      </div>
    </form>
  );
}

function LoginForm() {
  const sync = getSync();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async (action: "in" | "up") => {
    setBusy(true);
    setNote(null);
    setNote(await (action === "in" ? sync.signIn(email.trim(), password) : sync.signUp(email.trim(), password)));
    setBusy(false);
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void run("in");
      }}
    >
      <label className="field">
        <span className="field-label">メールアドレス</span>
        <input className="input" type="email" required value={email} autoComplete="username" autoCapitalize="none" onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">パスワード</span>
        <input className="input" type="password" required minLength={6} value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
      </label>
      {note && <p className="error">{note}</p>}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy}>
          ログイン
        </button>
        <button type="button" className="btn" disabled={busy || !email || password.length < 6} onClick={() => void run("up")}>
          はじめて使う（登録）
        </button>
      </div>
    </form>
  );
}
