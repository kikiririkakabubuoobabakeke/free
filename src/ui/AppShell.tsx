import { Toasts } from "./bits";
import { DayPage } from "./DayPage";
import { Editor } from "./Editor";
import { HomePage } from "./HomePage";
import { EntryList } from "./EntryList";
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
        {/* 広い画面では、一覧の横に総合ページを出す */}
        {route.page === "list" && <HomePage />}
        {route.page === "calendar" && <HomePage standalone />}
        {route.page === "day" && <DayPage key={route.date} date={route.date} />}
      </main>
      <Toasts />
    </div>
  );
}
