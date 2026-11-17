import { Toasts } from "./bits";
import { Editor } from "./Editor";
import { EntryList, newEntry } from "./EntryList";
import { useRoute } from "./router";
import { SettingsPage } from "./SettingsPage";
import { TagsPage } from "./TagsPage";
import { TemplatesPage } from "./TemplatesPage";
import { TrashPage } from "./TrashPage";

/**
 * 全体の枠。広い画面では左に一覧・右に中身の2枚、狭い画面ではどちらか1枚を出す。
 */
export function AppShell() {
  const route = useRoute();
  return (
    <div className="shell" data-page={route.page}>
      <EntryList activeId={route.page === "entry" ? route.id : null} />
      <main className="main">
        {route.page === "entry" && <Editor id={route.id} />}
        {route.page === "tags" && <TagsPage />}
        {route.page === "templates" && <TemplatesPage />}
        {route.page === "trash" && <TrashPage />}
        {route.page === "settings" && <SettingsPage />}
        {route.page === "list" && (
          <div className="empty">
            <button type="button" className="btn primary" onClick={() => void newEntry()}>
              ＋ 新しい日記
            </button>
          </div>
        )}
      </main>
      <Toasts />
    </div>
  );
}
