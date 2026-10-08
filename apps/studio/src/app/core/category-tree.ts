import type { Category } from './generated/mam.types.ts';

/**
 * The category tree as Studio shows it (#260) — pure, so the browse tree, the asset editor's picker
 * and the admin view agree, and the specs can drive it without a component.
 *
 * MAM answers the tree flat and in PATH order, which is already depth-first: a parent's path is a
 * prefix of its children's, so it sorts before them. Nothing here re-sorts by anything else.
 */

/** A category's label in the locale, falling back to English, then any, then the key. */
export function categoryLabel(category: Pick<Category, 'labels' | 'key'>, locale: string): string {
  const labels = category.labels as Record<string, string>;
  return labels[locale] ?? labels['en'] ?? Object.values(labels)[0] ?? category.key;
}

export interface TreeRow {
  readonly category: Category;
  /** 0 at the root — for indentation. */
  readonly level: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

/** The rows a tree shows: the roots, and the children of every expanded node, in path order. */
export function visibleRows(all: readonly Category[], expanded: ReadonlySet<string>): TreeRow[] {
  const byParent = new Map<string | undefined, Category[]>();
  for (const c of all) {
    const key = c.parentId;
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const ids = new Set(all.map((c) => c.id));
  const rows: TreeRow[] = [];
  const walk = (parentId: string | undefined, level: number): void => {
    const children = [...(byParent.get(parentId) ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.path.localeCompare(b.path),
    );
    for (const c of children) {
      const open = expanded.has(c.id);
      rows.push({ category: c, level, hasChildren: byParent.has(c.id), expanded: open });
      if (open) walk(c.id, level + 1);
    }
  };
  walk(undefined, 0);
  // A node whose parent is not in the list (filtered out) still shows, at the root — never lost.
  for (const c of all) {
    if (c.parentId !== undefined && !ids.has(c.parentId)) {
      rows.push({ category: c, level: 0, hasChildren: byParent.has(c.id), expanded: false });
    }
  }
  return rows;
}

export interface PickerOption {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  /** False for a node media cannot be put in directly — shown, but not choosable. */
  readonly choosable: boolean;
}

/** The asset editor's choices: the whole live tree, indented, only addable nodes choosable. */
export function pickerOptions(all: readonly Category[], locale: string): PickerOption[] {
  return [...all]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((c) => ({
      id: c.id,
      label: `${'  '.repeat(c.depth - 1)}${categoryLabel(c, locale)}`,
      path: c.path,
      choosable: c.mediaAddable && c.deprecatedAt === undefined,
    }));
}

/**
 * Where a category may move: anywhere but under itself or one of its descendants — the same
 * refusal MAM makes, offered as choices rather than discovered as a 422.
 */
export function moveTargets(all: readonly Category[], moving: Category): Category[] {
  return all.filter((c) => !c.path.startsWith(moving.path) && c.id !== moving.parentId);
}
