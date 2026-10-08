// The category tree (#260; data-model.md §2.6) — pure: shapes, validation, and path arithmetic.
//
// A category is a hierarchical vocabulary term with the aggregate's own fields. Its materialized
// `path` is built from KEYS — `/sports/football/highlights/` — so a category-scoped grant
// (`categoryPaths: ['/sports/']`) and a field schema keyed by path are readable, and `/sports/` is a
// prefix of everything under Sports but never of `/sportsnight/` (the trailing slash). A key is
// fixed at creation; a path changes only when the node or an ancestor MOVES, and a move rewrites the
// whole subtree in one transaction (service.ts).

import { ValidationError } from '@atlas/service-kit';

export interface Category {
  id: string;
  channelId: string;
  /** Absent at the root. */
  parentId?: string;
  key: string;
  path: string;
  /** 1 at the root. */
  depth: number;
  labels: Record<string, string>;
  description?: string;
  /** department, program, season, … — a word, not an enum: code never branches on it. */
  kind?: string;
  sortOrder: number;
  mediaAddable: boolean;
  deprecatedAt?: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCategoryInput {
  parentId?: string;
  key: string;
  labels: Record<string, string>;
  description?: string;
  kind?: string;
  sortOrder?: number;
  mediaAddable?: boolean;
}

export interface UpdateCategoryInput {
  labels?: Record<string, string>;
  description?: string;
  kind?: string;
  sortOrder?: number;
  mediaAddable?: boolean;
  deprecated?: boolean;
}

/** data-model.md §2.1: "nests arbitrarily deep — up to ~20 levels". */
export const MAX_CATEGORY_DEPTH = 20;

const KEY = /^[a-z0-9][a-z0-9-]*$/;
const LOCALE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/** The path of a child of `parent` (or of a root) with this key. */
export function childPath(parentPath: string | undefined, key: string): string {
  return `${parentPath ?? '/'}${key}/`;
}

/** Whether `path` is `ancestor` or below it — the same prefix rule a grant uses. */
export function within(path: string, ancestor: string): boolean {
  return path.startsWith(ancestor);
}

/** Every reason a create is refused, at once (the services' 422 convention). */
export function createProblems(input: Partial<CreateCategoryInput>): string[] {
  const problems: string[] = [];
  if (typeof input.key !== 'string' || !KEY.test(input.key) || input.key.length > 64) {
    problems.push(
      'key must be lower-case letters, digits and hyphens, starting with a letter or digit, at most 64',
    );
  }
  problems.push(...commonProblems(input, true));
  if (input.parentId !== undefined && typeof input.parentId !== 'string') {
    problems.push('parentId must be a category id');
  }
  return problems;
}

/** Every reason an update is refused. */
export function updateProblems(
  input: Partial<UpdateCategoryInput> & Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  if ('key' in input)
    problems.push('key cannot change — a path is built from keys; create a new category instead');
  if ('parentId' in input || 'path' in input)
    problems.push('parentId cannot change here — use move');
  if (input.deprecated !== undefined && typeof input.deprecated !== 'boolean') {
    problems.push('deprecated must be true or false');
  }
  problems.push(...commonProblems(input, false));
  return problems;
}

function commonProblems(input: Partial<UpdateCategoryInput>, labelsRequired: boolean): string[] {
  const problems: string[] = [];
  const labels = input.labels;
  if (labels === undefined) {
    if (labelsRequired) problems.push('labels are required — at least one locale');
  } else if (
    typeof labels !== 'object' ||
    labels === null ||
    Array.isArray(labels) ||
    Object.keys(labels).length === 0 ||
    Object.entries(labels).some(
      ([locale, text]) => !LOCALE.test(locale) || typeof text !== 'string' || !text.trim(),
    )
  ) {
    problems.push('labels must map locale tags (en, ar, …) to non-empty text, at least one');
  }
  if (input.kind !== undefined && (typeof input.kind !== 'string' || input.kind.length > 32)) {
    problems.push('kind must be a word of at most 32 characters');
  }
  if (input.sortOrder !== undefined && !Number.isInteger(input.sortOrder)) {
    problems.push('sortOrder must be a whole number');
  }
  if (input.mediaAddable !== undefined && typeof input.mediaAddable !== 'boolean') {
    problems.push('mediaAddable must be true or false');
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    problems.push('description must be text');
  }
  return problems;
}

export function refuse(problems: string[]): void {
  if (problems.length > 0) throw new ValidationError(problems.join('; '));
}

/**
 * The subtree after a move: every node of `subtree` (the moved node first, then its descendants,
 * all sharing its old path as a prefix) re-rooted under `newParent`'s path. Pure — the service
 * checks the refusals that need the store (a sibling key taken at the destination) and writes it.
 */
export function moved(
  subtree: readonly Category[],
  node: Category,
  newParent: Category | undefined,
): Category[] {
  const oldPrefix = node.path;
  const newPrefix = childPath(newParent?.path, node.key);
  const depthShift = (newParent?.depth ?? 0) + 1 - node.depth;
  return subtree.map((c) => {
    const next: Category = {
      ...c,
      path: newPrefix + c.path.slice(oldPrefix.length),
      depth: c.depth + depthShift,
    };
    if (c.id === node.id) {
      if (newParent) next.parentId = newParent.id;
      else delete next.parentId;
    }
    return next;
  });
}

/** Display label in a locale, falling back to English, then to any, then to the key. */
export function labelOf(category: Pick<Category, 'labels' | 'key'>, locale = 'en'): string {
  return (
    category.labels[locale] ??
    category.labels['en'] ??
    Object.values(category.labels)[0] ??
    category.key
  );
}
