import { FIELD_TYPE_LABELS, type FieldDef, type FieldType, type FieldValue } from "../db/types";
import { uid } from "../db/util";
import { AutoTextarea } from "./bits";

/** 構造の1項目に値を入れる欄 */
export function FieldInput(props: { field: FieldDef; value: FieldValue | undefined; onChange: (v: FieldValue) => void }) {
  const { field, value, onChange } = props;
  switch (field.type) {
    case "longtext":
      return (
        <AutoTextarea className="input" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
      );
    case "number":
      return (
        <input
          className="input narrow"
          type="number"
          inputMode="decimal"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "rating": {
      const current = typeof value === "number" ? value : 0;
      return (
        <div className="rating" role="radiogroup" aria-label={field.label}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              type="button"
              key={n}
              role="radio"
              aria-checked={current === n}
              className={n <= current ? "on" : ""}
              // 同じ数をもう一度押すと未入力に戻る
              onClick={() => onChange(current === n ? null : n)}
            >
              ●
            </button>
          ))}
          <span className="hint">{current ? `${current} / 5` : "未入力"}</span>
        </div>
      );
    }
    case "check":
      return (
        <label className="check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>{value === true ? "はい" : "いいえ"}</span>
        </label>
      );
    case "select":
      return (
        <select className="input narrow" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    default:
      return <input className="input" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** 構造やテンプレの項目そのもの（名前・種類・並び）を編集する欄 */
export function FieldsEditor(props: { fields: FieldDef[]; onChange: (fields: FieldDef[]) => void }) {
  const { fields, onChange } = props;
  const patch = (i: number, change: Partial<FieldDef>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...change } : f)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...fields];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="fields-editor">
      {fields.map((f, i) => (
        <div className="field-def" key={f.id}>
          <input className="input" value={f.label} placeholder="項目の名前" aria-label="項目の名前" onChange={(e) => patch(i, { label: e.target.value })} />
          <select className="input type" value={f.type} aria-label="項目の種類" onChange={(e) => patch(i, { type: e.target.value as FieldType })}>
            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <span className="field-def-buttons">
            <button type="button" className="btn ghost icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="上へ">
              ↑
            </button>
            <button type="button" className="btn ghost icon" disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label="下へ">
              ↓
            </button>
            <button type="button" className="btn ghost icon" onClick={() => onChange(fields.filter((_, j) => j !== i))} aria-label="この項目を消す">
              ×
            </button>
          </span>
          {f.type === "select" && (
            <input
              className="input options"
              value={(f.options ?? []).join("、")}
              placeholder="選択肢を「、」で区切って入力（例: 晴れ、曇り、雨）"
              aria-label="選択肢"
              onChange={(e) =>
                patch(i, {
                  options: e.target.value
                    .split(/[、,，]/)
                    .map((o) => o.trimStart()),
                })
              }
              onBlur={() => patch(i, { options: (f.options ?? []).map((o) => o.trim()).filter(Boolean) })}
            />
          )}
        </div>
      ))}
      <button type="button" className="btn small" onClick={() => onChange([...fields, { id: uid().slice(0, 8), label: "", type: "text" }])}>
        ＋ 項目を追加
      </button>
    </div>
  );
}
