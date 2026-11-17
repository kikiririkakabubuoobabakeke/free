import { EntryLockedError } from "./db/repo";
import { toast } from "./ui/bits";
import { createRoot } from "react-dom/client";
import { AppShell } from "./ui/AppShell";
import { startApp } from "./ui/store";
import "@fontsource-variable/noto-sans-jp";
import "./styles.css";

// ロック中などで変更が断られたら、お知らせを出す（打った内容が黙って消えたように見えないように）
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason instanceof EntryLockedError) {
    event.preventDefault();
    toast(event.reason.message);
  }
});

const root = createRoot(document.getElementById("root")!);
root.render(<div className="boot">起動中…</div>);

startApp().then(
  () => root.render(<AppShell />),
  (error: unknown) => {
    console.error(error);
    root.render(
      <div className="boot error">
        <p>起動できませんでした。</p>
        <pre>{error instanceof Error ? error.message : String(error)}</pre>
      </div>,
    );
  },
);
