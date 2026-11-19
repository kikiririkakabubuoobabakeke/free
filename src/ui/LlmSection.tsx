import { useState } from "react";
import { ConfirmButton } from "./bits";
import { getApp, useAnalysisState } from "./store";

/** 設定：ローカルLLM（自分のPCで動かすLLM）による分析 */
export function LlmSection() {
  const { analysis } = getApp();
  const state = useAnalysisState();
  const { config } = state;
  const [url, setUrl] = useState(config.url);
  const [model, setModel] = useState(config.model);
  const [context, setContext] = useState(String(config.contextLength));
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const dirty =
    url.trim().replace(/\/+$/, "") !== config.url || model.trim() !== config.model || Number(context) !== config.contextLength;

  const save = async () => {
    const contextLength = Math.max(2048, Math.min(262144, Math.round(Number(context)) || config.contextLength));
    const cleanUrl = url.trim().replace(/\/+$/, "");
    setUrl(cleanUrl);
    setModel(model.trim());
    setContext(String(contextLength));
    await analysis.setConfig({ url: cleanUrl, model: model.trim(), contextLength });
  };

  const test = async () => {
    setTesting(true);
    setNote(null);
    try {
      if (dirty) await save();
      const server = await analysis.test();
      const kind = server.kind === "ollama" ? "Ollama" : "OpenAI互換";
      const has = server.models.includes(model.trim());
      setNote(`${kind}・モデル${server.models.length}個${server.models.length && !has ? `・「${model.trim()}」はありません` : ""}`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const status = (() => {
    if (!config.enabled || !config.url) return "停止中";
    switch (state.phase) {
      case "working":
        return state.current?.startsWith("review:") ? "振り返りを作成中" : `分析中・残り${state.pending}件`;
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
            placeholder="gemma4:26b"
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
        <label className="field">
          <span className="field-label">文脈の長さ</span>
          <input
            className="input narrow context-input"
            type="number"
            inputMode="numeric"
            min={2048}
            step={1024}
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
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

      <label className="check llm-enable">
        <input
          type="checkbox"
          checked={config.enabled}
          disabled={!config.url}
          onChange={(e) => void analysis.setConfig({ enabled: e.target.checked })}
        />
        <span>日記を分析する</span>
      </label>
      <dl className="status">
        <dt>状態</dt>
        <dd>{status}</dd>
      </dl>
      {state.error && config.enabled && <p className="error">{state.error}</p>}
      {config.url && (
        <div className="row">
          <button type="button" className="btn ghost small" disabled={!config.enabled} onClick={() => void analysis.run()}>
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
