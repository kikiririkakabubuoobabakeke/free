import { createRoot } from "react-dom/client";
import { AppShell } from "./ui/AppShell";
import { startApp } from "./ui/store";
import "./styles.css";

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
