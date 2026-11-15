import { useMemo, useState, type CSSProperties } from "react";
import type { Tag, TagInfo } from "../db/types";
import { getApp } from "./store";

export function TagChip(props: { tag: Tag; onRemove?: () => void; onClick?: () => void; active?: boolean }) {
  const { tag } = props;
  return (
    <span
      className={`chip${props.active ? " active" : ""}${props.onClick ? " clickable" : ""}`}
      style={{ "--chip": tag.color || "#8a8f98" } as CSSProperties}
      onClick={props.onClick}
    >
      <span className="chip-dot" />
      {tag.name}
      {props.onRemove && (
        <button
          type="button"
          className="chip-x"
          aria-label={`${tag.name} を外す`}
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove?.();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * タグの付け外し。入力すると既存のタグが候補に出て、無い名前ならその場で作れる。
 * 付いているタグの親や関連タグは「候補」として出す。
 */
export function TagPicker(props: {
  tags: Tag[];
  allTags: TagInfo[];
  onAdd: (tag: Tag) => void;
  onRemove: (tag: Tag) => void;
  placeholder?: string;
}) {
  const { repo } = getApp();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const attached = useMemo(() => new Set(props.tags.map((t) => t.id)), [props.tags]);

  const needle = text.trim().replace(/^[#＃]/, "").toLowerCase();
  const matches = props.allTags
    .filter((t) => !attached.has(t.id) && (needle === "" || t.name.toLowerCase().includes(needle)))
    .slice(0, 8);
  const exact = props.allTags.some((t) => t.name.toLowerCase() === needle);

  // 付いているタグの親と関連タグのうち、まだ付いていないもの
  const suggested = useMemo(() => {
    const byId = new Map(props.allTags.map((t) => [t.id, t]));
    const ids = new Set<string>();
    for (const tag of props.tags) {
      const info = byId.get(tag.id);
      if (!info) continue;
      if (info.parent_id) ids.add(info.parent_id);
      for (const id of info.related_ids) ids.add(id);
    }
    return [...ids].filter((id) => !attached.has(id) && byId.has(id)).map((id) => byId.get(id)!);
  }, [props.allTags, props.tags, attached]);

  const submit = async (name: string) => {
    const tag = await repo.findOrCreateTag(name);
    if (tag && !attached.has(tag.id)) props.onAdd(tag);
    setText("");
    setOpen(false); // 続けて打ち始めれば、また候補が開く
  };

  return (
    <div className="tag-picker">
      <div className="tag-row">
        {props.tags.map((tag) => (
          <TagChip key={tag.id} tag={tag} onRemove={() => props.onRemove(tag)} />
        ))}
        <span className="tag-input-wrap">
          <input
            className="tag-input"
            value={text}
            placeholder={props.placeholder ?? "＋ タグ"}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              // 日本語変換の確定のEnterでは追加しない
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && needle) {
                e.preventDefault();
                void submit(text);
              } else if (e.key === "Escape") {
                setOpen(false);
              } else if (e.key === "Backspace" && text === "" && props.tags.length) {
                props.onRemove(props.tags[props.tags.length - 1]);
              }
            }}
          />
          {open && (matches.length > 0 || (needle && !exact)) && (
            // 候補を押してもフォーカスが外れて閉じてしまわないよう、押下では既定の動作を止める
            <div className="tag-menu" onMouseDown={(e) => e.preventDefault()}>
              {matches.map((t) => (
                <button type="button" key={t.id} className="tag-menu-item" onClick={() => void submit(t.name)}>
                  <TagChip tag={t} />
                </button>
              ))}
              {needle && !exact && (
                <button type="button" className="tag-menu-item create" onClick={() => void submit(text)}>
                  「{text.trim()}」を新しく作る
                </button>
              )}
            </div>
          )}
        </span>
      </div>
      {suggested.length > 0 && (
        <div className="tag-suggest">
          <span className="hint">候補</span>
          {suggested.map((t) => (
            <button type="button" key={t.id} className="chip suggest" onClick={() => props.onAdd(t)}>
              ＋ {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
