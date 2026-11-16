import { useEffect, useRef, useState } from "react";
import type { EntryDetail, TagInfo, Template } from "../db/types";
import { AutoTextarea, ConfirmButton, toast } from "./bits";
import { dayOf, formatDateTime } from "./format";
import { prepareImage } from "./image";
import { go, goBack } from "./router";
import { getApp, useDraft, useQuery } from "./store";
import { StructureCard } from "./StructureCard";
import { TagPicker } from "./TagPicker";

/** 「新しい日記」で作ったばかりのエントリ。何も書かずに離れたら消すための目印。 */
export const freshEntries = new Set<string>();

export function Editor({ id }: { id: string }) {
  const { repo } = getApp();
  const entry = useQuery(() => repo.getEntry(id), [id]);
  const allTags = useQuery(() => repo.listTags(), []) ?? [];
  const templates = useQuery(() => repo.listTemplates(), []) ?? [];

  if (entry === undefined || (entry && entry.id !== id)) return <div className="empty">読み込み中…</div>;
  if (entry === null) {
    return (
      <div className="empty">
        <p>この日記は見つかりません。</p>
        <button type="button" className="btn" onClick={() => go("")}>
          一覧へ
        </button>
      </div>
    );
  }
  return <EditorBody key={entry.id} entry={entry} allTags={allTags} templates={templates} />;
}

function EditorBody(props: { entry: EntryDetail; allTags: TagInfo[]; templates: Template[] }) {
  const { repo } = getApp();
  const { entry } = props;
  const [title, setTitle] = useDraft(entry.title, (v) => repo.updateEntry(entry.id, { title: v }));
  const [body, setBody] = useDraft(entry.body, (v) => repo.updateEntry(entry.id, { body: v }));
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // 作ったばかりで何も書かれていないエントリは、離れるときに消す
  const state = useRef({ empty: true, deleted: false });
  // 日付を付けただけでも、自分で手を入れたものなので「空」とは扱わない
  state.current.empty =
    !title.trim() &&
    !body.trim() &&
    !entry.date &&
    !entry.tags.length &&
    !entry.structures.length &&
    !entry.attachments.length;
  useEffect(() => {
    const current = state.current;
    return () => {
      if (freshEntries.delete(entry.id) && current.empty && !current.deleted) void repo.deleteEntry(entry.id);
    };
  }, [entry.id, repo]);

  // 別の日記を開いたら、先頭から表示する
  useEffect(() => {
    document.querySelector(".main")?.scrollTo(0, 0);
  }, [entry.id]);

  const remove = async () => {
    state.current.deleted = true;
    await repo.deleteEntry(entry.id);
    go("", { replace: true });
  };

  const addPhotos = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      try {
        await repo.addAttachment(entry.id, await prepareImage(file));
      } catch {
        toast(`「${file.name}」を読み込めませんでした`);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <article className="editor">
      <header className="editor-bar">
        <button type="button" className="btn ghost back" onClick={goBack}>
          ‹ 一覧
        </button>
        <span className="spacer" />
        <ConfirmButton label="削除" confirmLabel="この日記を削除" onConfirm={() => void remove()} />
      </header>

      {/* 日時は3つ。日付は自分で付けるもの、作成と最終更新は自動で入るもの。 */}
      <dl className="dates">
        <dt>日付</dt>
        <dd>
          <input
            type="date"
            value={entry.date}
            aria-label="日付"
            onChange={(e) => void repo.updateEntry(entry.id, { date: e.target.value })}
          />
          {entry.date ? (
            <>
              <span>{dayOf(entry.date).weekday}曜日</span>
              <button type="button" className="btn ghost small" onClick={() => void repo.updateEntry(entry.id, { date: "" })}>
                外す
              </button>
            </>
          ) : (
            <span className="hint">付けていません（作成日の位置に並びます）</span>
          )}
        </dd>
        <dt>作成</dt>
        <dd>{formatDateTime(entry.created_at)}</dd>
        <dt>最終更新</dt>
        <dd>{formatDateTime(entry.edited_at)}</dd>
      </dl>

      <input className="title-input" value={title} placeholder="題（なくてもよい）" aria-label="題" onChange={(e) => setTitle(e.target.value)} />
      <AutoTextarea
        className="body-input"
        value={body}
        placeholder="今日のこと…"
        aria-label="本文"
        autoFocus={freshEntries.has(entry.id)}
        onChange={(e) => setBody(e.target.value)}
      />

      <TagPicker
        tags={entry.tags}
        allTags={props.allTags}
        onAdd={(tag) => void repo.setTagLinked("entry", entry.id, tag.id, true)}
        onRemove={(tag) => void repo.setTagLinked("entry", entry.id, tag.id, false)}
      />

      {entry.attachments.length > 0 && (
        <div className="photos">
          {entry.attachments.map((a) => (
            <Photo key={a.id} id={a.id} hasData={a.has_data} onOpen={() => setViewing(a.id)} />
          ))}
        </div>
      )}

      {entry.structures.map((s, i) => (
        <StructureCard
          key={s.id}
          structure={s}
          allTags={props.allTags}
          isFirst={i === 0}
          isLast={i === entry.structures.length - 1}
          startEditing={s.id === justAdded}
        />
      ))}

      <div className="editor-add">
        <button type="button" className={`btn${adding ? " primary" : ""}`} onClick={() => setAdding(!adding)}>
          ＋ 構造を付ける
        </button>
        <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
          ＋ 写真
        </button>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => void addPhotos(e.target.files)} />
      </div>

      {adding && (
        <div className="template-menu">
          {props.templates.map((t) => (
            <button
              type="button"
              key={t.id}
              className="template-menu-item"
              onClick={async () => {
                await repo.addStructureFromTemplate(entry.id, t.id);
                setAdding(false);
              }}
            >
              <strong>{t.name || "無題"}</strong>
              <span className="hint">{t.fields.map((f) => f.label).filter(Boolean).join("・") || "項目なし"}</span>
            </button>
          ))}
          <button
            type="button"
            className="template-menu-item"
            onClick={async () => {
              setJustAdded(await repo.addBlankStructure(entry.id, "新しい構造"));
              setAdding(false);
            }}
          >
            <strong>空の構造を作る</strong>
            <span className="hint">項目を自分で決める。あとでテンプレとして保存できる。</span>
          </button>
        </div>
      )}

      {viewing && (
        <Lightbox
          id={viewing}
          onClose={() => setViewing(null)}
          onRemove={() => {
            void repo.removeAttachment(viewing);
            setViewing(null);
          }}
        />
      )}
    </article>
  );
}

/** 一度読んだ画像は覚えておく。日記を1文字保存するたびに、数百KBの画像を読み直さないため。 */
const imageCache = new Map<string, string>();

function useAttachmentUrl(id: string, hasData: boolean): string | null | undefined {
  const { repo } = getApp();
  const [url, setUrl] = useState<string | null | undefined>(imageCache.get(id));
  useEffect(() => {
    const cached = imageCache.get(id);
    if (cached) {
      setUrl(cached);
      return;
    }
    let alive = true;
    void repo.getAttachmentUrl(id).then((result) => {
      if (result) imageCache.set(id, result);
      if (alive) setUrl(result);
    });
    return () => {
      alive = false;
    };
  }, [id, hasData, repo]);
  return url;
}

function Photo(props: { id: string; hasData: boolean; onOpen: () => void }) {
  const url = useAttachmentUrl(props.id, props.hasData);
  if (!url) return <div className="photo waiting">{url === null ? "同期待ち" : ""}</div>;
  return (
    <button type="button" className="photo" onClick={props.onOpen} aria-label="写真を大きく表示">
      <img src={url} alt="" />
    </button>
  );
}

function Lightbox(props: { id: string; onClose: () => void; onRemove: () => void }) {
  const url = useAttachmentUrl(props.id, true);
  return (
    <div className="lightbox" onClick={props.onClose}>
      {url && <img src={url} alt="" />}
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <ConfirmButton label="この写真を外す" confirmLabel="外す" className="btn" onConfirm={props.onRemove} />
        <button type="button" className="btn" onClick={props.onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
