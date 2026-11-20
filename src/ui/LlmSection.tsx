import { useState } from "react";
import { BUILTIN_MODELS, sameModel } from "../llm/engine";
import { DEFAULT_REMOTE_MODEL } from "../llm/controller";
import { ConfirmButton } from "./bits";
import { getApp, useAnalysisState } from "./store";

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)}GB`;
}

/** 設定：ローカルLLM（自分のPCで動かすLLM）による分析 */
export function LlmSection() {
  const { analysis } = getApp();
  const state = useAnalysisState();
  const { config, engine } = state;
  const builtinAvailable = !!engine?.available;
  const mode = builtinAvailable ? config.mode : "remote";

  const status = (() => {
    if (!config.enabled) return "停止中";
    if (!state.configured) return "未設定";
    switch (state.phase) {
      case "starting":
        return "エンジンを起動中…";
      case "working":
        return state.current?.startsWith("review:") ? "振り返りを作成中" : `分析中・残り${state.pending}件`;
      case "needs-model":
        return "モデル未導入";
      case "unreachable":
        return "つながりません";
      case "error":
        return "エラー";
      default:
        return state.pending ? `待機中・残り${state.pending}件` : "すべて分析済み";
    }
  })();

  return (
    <section className="card llm-card">
      <h2>ローカルLLM</h2>
      {builtinAvailable && (
        <span className="segmented" role="group" aria-label="LLMの動かし方">
          <button type="button" aria-pressed={mode === "builtin"} onClick={() => void analysis.setConfig({ mode: "builtin", model: "" })}>
            このPCで動かす
          </button>
          <button
            type="button"
            aria-pressed={mode === "remote"}
            onClick={() => void analysis.setConfig({ mode: "remote", model: config.mode === "remote" ? config.model : "" })}
          >
            ほかのPCのサーバー
          </button>
        </span>
      )}

      {mode === "builtin" ? <BuiltinSettings /> : <RemoteSettings />}

      <label className="field">
        <span className="field-label">文脈の長さ</span>
        <ContextInput />
      </label>

      <label className="check llm-enable">
        <input
          type="checkbox"
          checked={config.enabled}
          disabled={mode === "remote" && !config.url}
          onChange={(e) => void analysis.setConfig({ enabled: e.target.checked })}
        />
        <span>日記を分析する</span>
      </label>
      <dl className="status">
        <dt>状態</dt>
        <dd>{status}</dd>
      </dl>
      {state.error && config.enabled && <p className="error">{state.error}</p>}
      {state.configured && (
        <div className="row">
          <button type="button" className="btn ghost small" onClick={() => void analysis.run()}>
            今すぐ進める
          </button>
          <ConfirmButton
            label="すべて分析し直す"
            confirmLabel="分析と振り返りを作り直す"
            className="btn ghost small"
            onConfirm={() => void analysis.reanalyzeAll()}
          />
        </div>
      )}
    </section>
  );
}

/** このPCで動かす：モデルを選び、入れる・消す。他の端末から使えるようにもできる。 */
function BuiltinSettings() {
  const { analysis } = getApp();
  const state = useAnalysisState();
  const { config, engine, pull, localModels } = state;
  const model = state.model;
  const listed = (name: string) => BUILTIN_MODELS.some((m) => m.name === name);
  // 「その他」を選んでから名前を確定するまでも、入力欄を出しておく
  const [customOpen, setCustomOpen] = useState(false);
  // 入力中の名前（入力していなければ、いまのモデルの名前を出す）
  const [draft, setDraft] = useState<string | null>(null);
  const showCustom = customOpen || !listed(model);
  const installed = localModels?.some((m) => sameModel(m, model)) ?? null;
  const percent = pull && pull.total > 0 ? Math.floor((pull.completed / pull.total) * 100) : 0;

  const commitCustom = () => {
    // Enter と、その後の blur の両方から呼ばれても、保存は1回にする
    const current = analysis.getState().model;
    const name = (draft ?? current).trim();
    setDraft(null);
    if (!name) return;
    if (listed(name)) setCustomOpen(false);
    if (name !== current) void analysis.setConfig({ model: name });
  };

  return (
    <div className="form">
      <label className="field">
        <span className="field-label">モデル</span>
        <select
          className="input narrow"
          value={showCustom ? "custom" : model}
          disabled={!!pull}
          onChange={(e) => {
            setDraft(null);
            if (e.target.value === "custom") {
              setCustomOpen(true);
            } else {
              setCustomOpen(false);
              if (e.target.value !== model) void analysis.setConfig({ model: e.target.value });
            }
          }}
        >
          {BUILTIN_MODELS.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}（{m.size}）
            </option>
          ))}
          <option value="custom">その他</option>
        </select>
      </label>
      {showCustom && (
        <label className="field">
          <span className="field-label">モデルの名前</span>
          <input
            className="input"
            value={draft ?? model}
            placeholder="gemma4:e4b-it-q4_K_M"
            autoFocus={customOpen}
            disabled={!!pull}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // 日本語変換の確定の Enter では確定しない
              if (e.key === "Enter" && !e.nativeEvent.isComposing) commitCustom();
            }}
            onBlur={commitCustom}
          />
        </label>
      )}

      {pull ? (
        <div className="pull">
          <div className="pull-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="row">
            <span className="hint">
              {pull.total > 0 ? `${percent}%・${gb(pull.completed)} / ${gb(pull.total)}` : "準備中…"}
            </span>
            <button type="button" className="btn ghost small" onClick={() => analysis.cancelInstall()}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <span className="hint">{installed === null ? "" : installed ? "入っています" : "入っていません"}</span>
          {installed === false && (
            <button type="button" className="btn primary small" onClick={() => void analysis.installModel()}>
              モデルを入れる
            </button>
          )}
          {installed === null && (
            <button type="button" className="btn ghost small" onClick={() => void analysis.refreshLocalModels()}>
              確かめる
            </button>
          )}
          {installed && (
            <ConfirmButton
              label="モデルを消す"
              confirmLabel={`${model}を消す`}
              className="btn ghost small"
              onConfirm={() => void analysis.removeModel(model)}
            />
          )}
        </div>
      )}

      <label className="check">
        <input type="checkbox" checked={config.share} onChange={(e) => void analysis.setConfig({ share: e.target.checked })} />
        <span>同じネットワークの他の端末から使う</span>
      </label>
      {config.share && engine?.running && engine.share && (
        <code className="path">{engine.lan_address ? `http://${engine.lan_address}:${engine.port}` : `ポート ${engine.port}`}</code>
      )}
      {engine?.models_dir && <p className="hint path-hint">{engine.models_dir}</p>}
    </div>
  );
}

/** ほかのPCのサーバー：URL とモデルを入れて、接続を確かめる */
function RemoteSettings() {
  const { analysis } = getApp();
  const state = useAnalysisState();
  const { config } = state;
  const [url, setUrl] = useState(config.url);
  const [model, setModel] = useState(config.model || DEFAULT_REMOTE_MODEL);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cleanUrl = url.trim().replace(/\/+$/, "");
  const dirty = cleanUrl !== config.url || model.trim() !== (config.model || DEFAULT_REMOTE_MODEL);

  const save = async () => {
    setUrl(cleanUrl);
    setModel(model.trim());
    await analysis.setConfig({ url: cleanUrl, model: model.trim() });
  };

  const test = async () => {
    setTesting(true);
    setNote(null);
    try {
      if (dirty) await save();
      const server = await analysis.test();
      const kind = server.kind === "ollama" ? "Ollama" : "OpenAI互換";
      const has = server.models.some((m) => sameModel(m, model.trim()));
      setNote(`${kind}・モデル${server.models.length}個${server.models.length && !has ? `・「${model.trim()}」はありません` : ""}`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="form">
      <label className="field">
        <span className="field-label">サーバー</span>
        <input
          className="input"
          type="url"
          value={url}
          placeholder="http://192.168.1.20:11434"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">モデル</span>
        <input
          className="input"
          value={model}
          list="llm-models"
          placeholder={DEFAULT_REMOTE_MODEL}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setModel(e.target.value)}
        />
        <datalist id="llm-models">
          {(state.server?.models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <div className="row">
        <button type="button" className="btn" disabled={testing || !url.trim()} onClick={() => void test()}>
          {testing ? "確認中…" : "接続を確かめる"}
        </button>
        {dirty && (
          <button type="button" className="btn" onClick={() => void save()}>
            保存
          </button>
        )}
      </div>
      {note && <p className="hint llm-note">{note}</p>}
    </div>
  );
}

function ContextInput() {
  const { analysis } = getApp();
  const { config } = useAnalysisState();
  const [context, setContext] = useState(String(config.contextLength));
  return (
    <input
      className="input narrow context-input"
      type="number"
      inputMode="numeric"
      min={2048}
      step={1024}
      value={context}
      onChange={(e) => setContext(e.target.value)}
      onBlur={() => {
        const value = Math.max(2048, Math.min(262144, Math.round(Number(context)) || config.contextLength));
        setContext(String(value));
        if (value !== config.contextLength) void analysis.setConfig({ contextLength: value });
      }}
    />
  );
}
