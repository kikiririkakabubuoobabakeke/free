import { useState } from "react";
import type { Structure, TagInfo } from "../db/types";
import { ConfirmButton, toast } from "./bits";
import { FieldInput, FieldsEditor } from "./Fields";
import { getApp, useDraft } from "./store";
import { TagPicker } from "./TagPicker";

/** エントリに付いている構造1つ分。値の入力、項目の編集、タグ付け、テンプレ保存、取り外しができる。 */
export function StructureCard(props: {
  structure: Structure;
  allTags: TagInfo[];
  isFirst: boolean;
  isLast: boolean;
  startEditing?: boolean;
}) {
  const { repo } = getApp();
  const { structure: s } = props;
  const [editing, setEditing] = useState(props.startEditing ?? false);
  const [name, setName, flushName] = useDraft(s.name, (v) => repo.updateStructure(s.id, { name: v }));
  const [fields, setFields, flushFields] = useDraft(s.fields, (v) => repo.updateStructure(s.id, { fields: v }));
  const [values, setValues, flushValues] = useDraft(s.values, (v) => repo.updateStructure(s.id, { values: v }));

  return (
    <section className="structure">
      <header className="structure-head">
        <input
          className="structure-name"
          value={name}
          placeholder="構造の名前"
          aria-label="構造の名前"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="structure-actions">
          <button type="button" className="btn ghost icon" disabled={props.isFirst} onClick={() => void repo.moveStructure(s.id, -1)} aria-label="上へ">
            ↑
          </button>
          <button type="button" className="btn ghost icon" disabled={props.isLast} onClick={() => void repo.moveStructure(s.id, 1)} aria-label="下へ">
            ↓
          </button>
          <button
            type="button"
            className={`btn small${editing ? " primary" : ""}`}
            onClick={() => {
              if (editing) flushFields();
              setEditing(!editing);
            }}
          >
            {editing ? "完了" : "項目を編集"}
          </button>
        </span>
      </header>

      {editing ? (
        <>
          <FieldsEditor fields={fields} onChange={setFields} />
          <div className="structure-foot">
            <button
              type="button"
              className="btn small"
              onClick={async () => {
                // 打ちかけの入力を先に保存し、それが終わってから写し取る
                flushName();
                flushFields();
                flushValues();
                await repo.updateStructure(s.id, {});
                if (await repo.saveStructureAsTemplate(s.id)) toast(`テンプレ「${name || "無題"}」を保存しました`);
              }}
            >
              テンプレとして保存
            </button>
            <ConfirmButton label="この構造を外す" confirmLabel="外す" className="btn small ghost" onConfirm={() => void repo.removeStructure(s.id)} />
          </div>
        </>
      ) : fields.length === 0 ? (
        <p className="hint">まだ項目がありません。「項目を編集」から追加できます。</p>
      ) : (
        <div className="structure-fields">
          {fields.map((f) => (
            <label className="field" key={f.id}>
              <span className="field-label">{f.label || "（名前なし）"}</span>
              <FieldInput field={f} value={values[f.id]} onChange={(v) => setValues({ ...values, [f.id]: v })} />
            </label>
          ))}
        </div>
      )}

      <TagPicker
        tags={s.tags}
        allTags={props.allTags}
        placeholder="＋ この構造のタグ"
        onAdd={(tag) => void repo.setTagLinked("structure", s.id, tag.id, true)}
        onRemove={(tag) => void repo.setTagLinked("structure", s.id, tag.id, false)}
      />
    </section>
  );
}
