import { useSyncExternalStore } from "react";

/** 一覧の絞り込み条件。タグのページからも設定できるよう、画面の外に持つ。 */
export interface Filter {
  query: string;
  tagIds: string[];
}

let filter: Filter = { query: "", tagIds: [] };
const listeners = new Set<() => void>();

export function setFilter(patch: Partial<Filter>): void {
  filter = { ...filter, ...patch };
  for (const listener of listeners) listener();
}

export function useFilter(): Filter {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => filter,
  );
}
