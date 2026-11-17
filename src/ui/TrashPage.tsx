import { ConfirmButton, PageHeader, toast } from "./bits";
import { dayOf, formatMonth, trashRemaining } from "./format";
import { getApp, useQuery } from "./store";

/** ゴミ箱。入れた日記を元に戻したり、完全に削除したりする。 */
export function TrashPage() {
  const { repo } = getApp();
  const entries = useQuery(() => repo.listTrash(), []);

  return (
    <div className="page">
      <PageHeader title="ゴミ箱">
        {entries !== undefined && entries.length > 0 && (
          <ConfirmButton
            label="空にする"
            confirmLabel="すべて完全に削除"
            className="btn small"
            onConfirm={async () => {
              const n = await repo.emptyTrash();
              toast(`${n}件を完全に削除しました`);
            }}
          />
        )}
      </PageHeader>
      {entries !== undefined && entries.length === 0 && <p className="empty-list">ゴミ箱は空です。</p>}
      <div className="trash-list">
        {(entries ?? []).map((entry) => {
          const { day, weekday } = dayOf(entry.day);
          const firstLine = entry.body.split("\n").find((line) => line.trim()) ?? "";
          return (
            <div key={entry.id} className="trash-row">
              <a className="trash-main" href={`#/e/${entry.id}`}>
                <span className="trash-date">
                  {formatMonth(entry.day)}
                  {day}日（{weekday}）
                </span>
                <span className="entry-title">{entry.title.trim() || firstLine || "無題"}</span>
                <span className="hint">{trashRemaining(entry.trashed_at!)}完全に削除</span>
              </a>
              <span className="trash-actions">
                <button type="button" className="btn small" onClick={() => void repo.restoreEntry(entry.id)}>
                  元に戻す
                </button>
                <ConfirmButton
                  label="削除"
                  confirmLabel="完全に削除"
                  className="btn ghost small"
                  onConfirm={() => void repo.purgeEntry(entry.id)}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
