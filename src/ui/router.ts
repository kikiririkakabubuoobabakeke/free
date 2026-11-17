import { useSyncExternalStore } from "react";

export type Route =
  | { page: "list" }
  | { page: "entry"; id: string }
  | { page: "tags" }
  | { page: "templates" }
  | { page: "trash" }
  | { page: "settings" };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "e" && parts[1]) return { page: "entry", id: parts[1] };
  if (parts[0] === "tags") return { page: "tags" };
  if (parts[0] === "templates") return { page: "templates" };
  if (parts[0] === "trash") return { page: "trash" };
  if (parts[0] === "settings") return { page: "settings" };
  return { page: "list" };
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/** アドレスの # 以降を画面の場所として使う。端末の「戻る」がそのまま効く。 */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parse(hash);
}

export function go(path: string, opts: { replace?: boolean } = {}): void {
  const target = `#/${path}`;
  if (opts.replace) window.location.replace(target);
  else window.location.hash = target;
}

/** 一覧へ戻る。履歴があれば戻り、無ければ一覧を開く。 */
export function goBack(): void {
  if (window.history.length > 1) window.history.back();
  else go("");
}
