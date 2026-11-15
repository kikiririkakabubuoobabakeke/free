import { useState } from "react";
import type { EntrySummary } from "../db/types";
import { today } from "../db/util";
import { freshEntries } from "./Editor";
import { setFilter, useFilter } from "./filter";
import { dayOf, formatMonth, formatTime } from "./format";
import { go } from "./router";
import { getApp, useQuery, useSyncState } from "./store";
import { TagChip } from "./TagPicker";
import { tagTree } from "./tagTree";

export async function newEntry(): Promise<void> {
  const id = await getApp().repo.createEntry(today());
  freshEntries.add(id);
  go(`e/${id}`);
}

export function EntryList({ activeId }: { activeId: string | null }) {
  const { repo } = getApp();
  const filter = useFilter();
  const [showTags, setShowTags] = useState(false);
  const entries = useQuery(
    () => repo.listEntries({ query: filter.query, tagIds: filter.tagIds }),
    [filter.query, filter.tagIds.join(",")],
  );
  const allTags = useQuery(() => repo.listTags(), []) ?? [];
  const selected = allTags.filter((t) => filter.tagIds.includes(t.id));
  const filtering = filter.query.trim() !== "" || filter.tagIds.length > 0;

  const toggleTag = (id: string) =>
    setFilter({ tagIds: filter.tagIds.includes(id) ? filter.tagIds.filter((x) => x !== id) : [...filter.tagIds, id] });

  // 月ごとにまとめる
  const months: { month: string; items: EntrySummary[] }[] = [];
  for (const entry of entries ?? []) {
    const month = formatMonth(entry.date);
    if (months[months.length - 1]?.month !== month) months.push({ month, items: [] });
    months[months.length - 1].items.push(entry);
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <h1>日記</h1>
        <SyncBadge />
        <nav>
          <button type="button" className="btn ghost small" onClick={() => go("tags")}>
            タグ
          </button>
          <button type="button" className="btn ghost small" onClick={() => go("templates")}>
            テンプレ
          </button>
          <button type="button" className="btn ghost small" onClick={() => go("settings")}>
            設定
          </button>
        </nav>
      </header>

      <div className="sidebar-tools">
        <input
          className="input search"
          type="search"
          value={filter.query}
          placeholder="検索（本文・構造・タグ）"
          aria-label="検索"
          onChange={(e) => setFilter({ query: e.target.value })}
        />
        <button type="button" className={`btn small${showTags || selected.length ? " primary" : ""}`} onClick={() => setShowTags(!showTags)}>
          タグ{selected.length ? ` ${selected.length}` : ""}
        </button>
      </div>

      {(showTags || selected.length > 0) && (
        <div className="filter-tags">
          {showTags
            ? tagTree(allTags).map(({ tag, depth }) => (
                <span key={tag.id} style={{ marginLeft: depth ? 4 : 0 }}>
                  {depth > 0 && <span className="hint">└ </span>}
                  <TagChip tag={tag} active={filter.tagIds.includes(tag.id)} onClick={() => toggleTag(tag.id)} />
                </span>
              ))
            : selected.map((tag) => <TagChip key={tag.id} tag={tag} active onRemove={() => toggleTag(tag.id)} />)}
          {showTags && allTags.length === 0 && <span className="hint">まだタグがありません。日記や構造に付けると、ここで絞り込めます。</span>}
        </div>
      )}

      <button type="button" className="btn primary new-entry" onClick={() => void newEntry()}>
        ＋ 新しい日記
      </button>

      <div className="entry-list">
        {entries !== undefined && entries.length === 0 && (
          <p className="empty-list">{filtering ? "条件に合う日記はありません。" : "まだ日記がありません。最初の1件を書いてみましょう。"}</p>
        )}
        {months.map(({ month, items }) => (
          <section key={month}>
            <h2 className="month">
              {month}
              <span className="hint">{items.length}件</span>
            </h2>
            {items.map((entry) => (
              <EntryRow key={entry.id} entry={entry} active={entry.id === activeId} />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

function EntryRow({ entry, active }: { entry: EntrySummary; active: boolean }) {
  const { day, weekday } = dayOf(entry.date);
  const firstLine = entry.body.split("\n").find((line) => line.trim()) ?? "";
  const heading = entry.title.trim() || firstLine || "（まだ何も書かれていません）";
  const rest = entry.title.trim() ? entry.body : entry.body.slice(entry.body.indexOf(firstLine) + firstLine.length);
  return (
    <a className={`entry-row${active ? " active" : ""}`} href={`#/e/${entry.id}`}>
      <span className="entry-day">
        <strong>{day}</strong>
        <span>{weekday}</span>
      </span>
      <span className="entry-main">
        <span className="entry-title">{heading}</span>
        {rest.trim() && <span className="entry-excerpt">{rest.trim()}</span>}
        <span className="entry-meta">
          <span className="hint">{formatTime(entry.created_at)}</span>
          {entry.tags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
          {entry.structure_names.map((name, i) => (
            <span key={i} className="badge">
              {name}
            </span>
          ))}
          {entry.photo_count > 0 && <span className="badge">写真 {entry.photo_count}</span>}
        </span>
      </span>
    </a>
  );
}

function SyncBadge() {
  const state = useSyncState();
  let label = "同期オフ";
  let tone = "off";
  if (state.email) {
    if (state.phase === "syncing") [label, tone] = ["同期中…", "busy"];
    else if (state.phase === "error") [label, tone] = ["同期エラー", "error"];
    else [label, tone] = [state.lastSyncedAt ? `同期済み ${formatTime(state.lastSyncedAt)}` : "同期待ち", "ok"];
  }
  return (
    <button type="button" className={`sync-badge ${tone}`} onClick={() => go("settings")} title={state.error ?? "同期の設定を開く"}>
      <span className="sync-dot" />
      {label}
    </button>
  );
}
