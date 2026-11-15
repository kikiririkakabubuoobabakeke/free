import type { TagInfo } from "../db/types";

export interface TagNode {
  tag: TagInfo;
  depth: number;
}

/**
 * タグを親子の順に並べる。親の直後に子が来る。
 * 2台で別々に親を決めた結果、輪になってしまったタグは、根として並べる。
 */
export function tagTree(tags: TagInfo[]): TagNode[] {
  const ids = new Set(tags.map((t) => t.id));
  const children = new Map<string | null, TagInfo[]>();
  for (const tag of tags) {
    const parent = tag.parent_id && ids.has(tag.parent_id) ? tag.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), tag]);
  }
  const out: TagNode[] = [];
  const seen = new Set<string>();
  const visit = (tag: TagInfo, depth: number) => {
    if (seen.has(tag.id)) return;
    seen.add(tag.id);
    out.push({ tag, depth });
    for (const child of children.get(tag.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  for (const tag of tags) visit(tag, 0);
  return out;
}

/** あるタグの子孫のID */
export function descendantIds(tags: TagInfo[], rootId: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const tag of tags) {
      if (tag.parent_id && !out.has(tag.id) && tag.id !== rootId && (tag.parent_id === rootId || out.has(tag.parent_id))) {
        out.add(tag.id);
        grew = true;
      }
    }
  }
  return out;
}
