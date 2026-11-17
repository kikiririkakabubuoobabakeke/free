import { useState } from "react";
import { TAG_COLORS, type TagInfo } from "../db/types";
import { ConfirmButton, PageHeader } from "./bits";
import { setFilter } from "./filter";
import { go } from "./router";
import { getApp, useQuery } from "./store";
import { TagChip, toGray } from "./TagPicker";
import { descendantIds, tagTree } from "./tagTree";

/** タグの一覧と、タグ同士の関係（親子・関連）の編集 */
export function TagsPage() {
  const { repo } = getApp();
  const tags = useQuery(() => repo.listTags(), []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");

  const create = async () => {
    const tag = await repo.findOrCreateTag(name);
    if (tag) setOpenId(tag.id);
    setName("");
  };

  return (
    <div className="page">
      <PageHeader title="タグ" />
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input className="input" value={name} placeholder="新しいタグの名前" aria-label="新しいタグの名前" onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn primary" disabled={!name.trim()}>
          作る
        </button>
      </form>

      {tags !== undefined && tags.length === 0 && <p className="empty-list">タグはありません</p>}
      <div className="tag-list">
        {tagTree(tags ?? []).map(({ tag, depth }) => (
          <div key={tag.id} className={`tag-item${openId === tag.id ? " open" : ""}`} style={{ marginLeft: Math.min(depth, 6) * 20 }}>
            <button type="button" className="tag-item-head" onClick={() => setOpenId(openId === tag.id ? null : tag.id)} aria-expanded={openId === tag.id}>
              <TagChip tag={tag} />
              <span className="hint">{tag.use_count}件</span>
              <span className="spacer" />
              <span className="hint">{openId === tag.id ? "閉じる" : "編集"}</span>
            </button>
            {openId === tag.id && <TagEditor key={tag.id} tag={tag} all={tags ?? []} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function TagEditor({ tag, all }: { tag: TagInfo; all: TagInfo[] }) {
  const { repo } = getApp();
  const [name, setName] = useState(tag.name);
  const below = descendantIds(all, tag.id);
  const parentChoices = all.filter((t) => t.id !== tag.id && !below.has(t.id));
  const related = all.filter((t) => tag.related_ids.includes(t.id));
  const relatedChoices = all.filter((t) => t.id !== tag.id && !tag.related_ids.includes(t.id));
  const rename = () => {
    if (name.trim() && name.trim() !== tag.name) void repo.updateTag(tag.id, { name });
    else setName(tag.name);
  };

  return (
    <div className="tag-editor">
      <label className="field">
        <span className="field-label">名前</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
          }}
        />
      </label>

      <div className="field">
        <span className="field-label">色</span>
        <div className="colors">
          {TAG_COLORS.map((color) => (
            <button
              type="button"
              key={color}
              className={`color${toGray(tag.color) === color ? " on" : ""}`}
              style={{ background: color }}
              aria-label={`色 ${color}`}
              aria-pressed={toGray(tag.color) === color}
              onClick={() => void repo.updateTag(tag.id, { color })}
            />
          ))}
        </div>
      </div>

      <label className="field">
        <span className="field-label">親タグ</span>
        <select className="input narrow" value={tag.parent_id ?? ""} onChange={(e) => void repo.setTagParent(tag.id, e.target.value || null)}>
          <option value="">なし</option>
          {parentChoices.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <span className="field-label">関連タグ</span>
        <div className="tag-row">
          {related.map((t) => (
            <TagChip key={t.id} tag={t} onRemove={() => void repo.setTagsRelated(tag.id, t.id, false)} />
          ))}
          {relatedChoices.length > 0 && (
            <select
              className="input narrow"
              value=""
              aria-label="関連タグを追加"
              onChange={(e) => e.target.value && void repo.setTagsRelated(tag.id, e.target.value, true)}
            >
              <option value="">＋ 関連を結ぶ…</option>
              {relatedChoices.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="tag-editor-foot">
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setFilter({ query: "", tagIds: [tag.id] });
            go("");
          }}
        >
          このタグの日記を見る
        </button>
        <ConfirmButton label="タグを削除" confirmLabel="削除する" className="btn small ghost" onConfirm={() => void repo.deleteTag(tag.id)} />
      </div>
    </div>
  );
}
