import { useState } from "react";
import type { TagInfo, Template } from "../db/types";
import { ConfirmButton, PageHeader } from "./bits";
import { FieldsEditor } from "./Fields";
import { getApp, useDraft, useQuery } from "./store";
import { TagChip, TagPicker } from "./TagPicker";

/** 構造のテンプレの一覧と編集 */
export function TemplatesPage() {
  const { repo } = getApp();
  const templates = useQuery(() => repo.listTemplates(), []);
  const allTags = useQuery(() => repo.listTags(), []) ?? [];
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="page">
      <PageHeader title="構造のテンプレ">
        <button type="button" className="btn primary" onClick={async () => setOpenId(await repo.createTemplate("新しいテンプレ"))}>
          ＋ 新しく作る
        </button>
      </PageHeader>
      {templates !== undefined && templates.length === 0 && (
        <p className="empty-list">テンプレはありません</p>
      )}
      {(templates ?? []).map((t) =>
        openId === t.id ? (
          <TemplateEditor key={t.id} template={t} allTags={allTags} onClose={() => setOpenId(null)} />
        ) : (
          <button type="button" key={t.id} className="template-row" onClick={() => setOpenId(t.id)}>
            <strong>{t.name || "無題"}</strong>
            <span className="hint">{t.fields.map((f) => f.label).filter(Boolean).join("・") || "項目なし"}</span>
            <span className="tag-row">
              {t.tags.map((tag) => (
                <TagChip key={tag.id} tag={tag} />
              ))}
            </span>
          </button>
        ),
      )}
    </div>
  );
}

function TemplateEditor(props: { template: Template; allTags: TagInfo[]; onClose: () => void }) {
  const { repo } = getApp();
  const { template: t } = props;
  const [name, setName] = useDraft(t.name, (v) => repo.updateTemplate(t.id, { name: v }));
  const [fields, setFields] = useDraft(t.fields, (v) => repo.updateTemplate(t.id, { fields: v }));
  return (
    <section className="structure">
      <header className="structure-head">
        <input className="structure-name" value={name} placeholder="テンプレの名前" aria-label="テンプレの名前" onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn small primary" onClick={props.onClose}>
          完了
        </button>
      </header>
      <FieldsEditor fields={fields} onChange={setFields} />
      <TagPicker
        tags={t.tags}
        allTags={props.allTags}
        placeholder="＋ タグ"
        onAdd={(tag) => void repo.setTagLinked("template", t.id, tag.id, true)}
        onRemove={(tag) => void repo.setTagLinked("template", t.id, tag.id, false)}
      />
      <div className="structure-foot">
        <ConfirmButton label="このテンプレを削除" confirmLabel="削除する" className="btn small ghost" onConfirm={() => void repo.deleteTemplate(t.id)} />
      </div>
    </section>
  );
}
