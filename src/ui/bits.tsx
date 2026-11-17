import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { goBack } from "./router";

/** 中身に合わせて高さが伸びる入力欄 */
export function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 高さを測るために一度縮めると、長文ではページが縮んでスクロール位置が飛ぶ。測る前の位置に戻す。
    const scroller = el.closest(".main");
    const top = scroller?.scrollTop ?? 0;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (scroller) scroller.scrollTop = top;
  }, [props.value]);
  return <textarea ref={ref} rows={1} {...props} />;
}

/** 押すと「本当に？」と聞き返すボタン。OSの確認ダイアログはWebViewによって出ないことがあるので自前で持つ。 */
export function ConfirmButton(props: {
  label: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  title?: string;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(timer);
  }, [asking]);
  if (!asking) {
    return (
      <button type="button" className={props.className ?? "btn ghost"} title={props.title} onClick={() => setAsking(true)}>
        {props.label}
      </button>
    );
  }
  return (
    <span className="confirm">
      <button
        type="button"
        className="btn danger"
        onClick={() => {
          setAsking(false);
          props.onConfirm();
        }}
      >
        {props.confirmLabel}
      </button>
      <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
        やめる
      </button>
    </span>
  );
}

/** タグ・テンプレ・設定の各ページ共通の見出し。狭い画面では「戻る」が付く。 */
export function PageHeader(props: { title: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <button type="button" className="btn ghost back" onClick={goBack} aria-label="戻る">
        ‹ 戻る
      </button>
      <h1>{props.title}</h1>
      <div className="page-header-actions">{props.children}</div>
    </header>
  );
}

// ---- 画面下に短く出るお知らせ

interface ToastItem {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

let toasts: ToastItem[] = [];
let nextToastId = 1;
const toastListeners = new Set<() => void>();

function setToasts(next: ToastItem[]): void {
  toasts = next;
  for (const listener of toastListeners) listener();
}

export function toast(text: string, action?: ToastItem["action"]): void {
  const id = nextToastId++;
  setToasts([...toasts, { id, text, action }]);
  // ボタン付きは、押す余裕があるよう長めに出す
  setTimeout(() => setToasts(toasts.filter((t) => t.id !== id)), action ? 7000 : 3500);
}

export function Toasts() {
  const items = useSyncExternalStore(
    (listener) => {
      toastListeners.add(listener);
      return () => toastListeners.delete(listener);
    },
    () => toasts,
  );
  return (
    <div className="toasts" role="status">
      {items.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                setToasts(toasts.filter((x) => x.id !== t.id));
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** 錠前の形の小さな印 */
export function LockIcon(props: { open?: boolean }) {
  return (
    <svg className="lock-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7.5" rx="1.6" fill="currentColor" />
      <path
        d={props.open ? "M5.5 7V4.8a2.5 2.5 0 0 1 4.9-.7" : "M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
