// The people register and cast & crew (EP-28.5; data-model §1.4, FR-PPL-1…6) — pure.
//
// A PERSON is minimal PII by design (D5, FR-PPL-2): a name and, optionally, a reference to an image
// — nothing else about them is stored. What they DID on a piece of media is the asset's cast entry:
// a person and a ROLE, the role a term of the `cast-role` vocabulary whose `roleClass` says whether
// it is on-screen or crew (decided with the product owner: the class belongs to the role, so a
// "director" is crew wherever it appears).
//
// Cast inherits PER ROLE (FR-TAX-9a, data-model §2.2): a category's cast defaults give each role
// its people; an asset that names anyone for a role replaces that role's defaults, and inherits
// every role it does not name.

import { ValidationError } from '@atlas/service-kit';
import type { Category } from './category.ts';
import type { Origin } from './inheritance.ts';

export interface Person {
  id: string;
  channelId: string;
  name: string;
  /** A reference to an image of the person (an asset id or a URL) — optional, never the bytes. */
  imageRef?: string;
  deprecatedAt?: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePersonInput {
  name: string;
  imageRef?: string;
}

export interface UpdatePersonInput {
  name?: string;
  imageRef?: string;
  deprecated?: boolean;
}

/** One person in one role on one piece of media (or as a category's default). */
export interface CastEntry {
  personId: string;
  /** A `cast-role` term id. */
  roleId: string;
}

/** A cast entry a reader inherits, with the category it comes from. */
export interface InheritedCastEntry extends CastEntry {
  from: Origin;
}

export const MAX_CAST = 100;

export function personProblems(input: Record<string, unknown>, creating: boolean): string[] {
  const problems: string[] = [];
  const name = input['name'];
  if (
    name === undefined ? creating : typeof name !== 'string' || !name.trim() || name.length > 200
  ) {
    problems.push('name is required — at most 200 characters');
  }
  const imageRef = input['imageRef'];
  if (imageRef !== undefined && (typeof imageRef !== 'string' || imageRef.length > 512)) {
    problems.push('imageRef must be text of at most 512 characters');
  }
  if (input['deprecated'] !== undefined && typeof input['deprecated'] !== 'boolean') {
    problems.push('deprecated must be true or false');
  }
  // FR-PPL-2: a name and an image — nothing else about a person is kept.
  const extra = Object.keys(input).filter(
    (k) => !['name', 'imageRef', ...(creating ? [] : ['deprecated'])].includes(k),
  );
  if (extra.length > 0) {
    problems.push(`a person is a name and an image only (FR-PPL-2) — not ${extra.join(', ')}`);
  }
  return problems;
}

/** Every reason a cast list is refused — its shape only; the ids are checked against the store. */
export function castProblems(value: unknown, where = 'cast'): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CAST) {
    return [`${where} must be a list of at most ${MAX_CAST} { personId, roleId } entries`];
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  value.forEach((e: unknown, i) => {
    const entry = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    const keys = Object.keys(entry);
    if (
      typeof entry['personId'] !== 'string' ||
      typeof entry['roleId'] !== 'string' ||
      keys.some((k) => k !== 'personId' && k !== 'roleId')
    ) {
      problems.push(`${where}[${i}] must be { personId, roleId }`);
      return;
    }
    const pair = `${entry['personId']}|${entry['roleId']}`;
    if (seen.has(pair)) problems.push(`${where}[${i}] repeats a person in the same role`);
    seen.add(pair);
  });
  return problems;
}

export function refusePerson(problems: string[]): void {
  if (problems.length > 0) throw new ValidationError(problems.join('; '));
}

/**
 * The cast a reader inherits, PER ROLE: for every role the reader does not name, the entries of the
 * nearest category in `chain` (root first) that names it. `ownRoles` are the roles the reader sets.
 */
export function inheritedCast(
  chain: readonly Category[],
  ownRoles: ReadonlySet<string>,
): InheritedCastEntry[] {
  const out: InheritedCastEntry[] = [];
  const settled = new Set(ownRoles);
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]!;
    const roles = new Set((c.defaults?.cast ?? []).map((e) => e.roleId));
    for (const role of roles) {
      if (settled.has(role)) continue;
      for (const e of c.defaults!.cast!.filter((x) => x.roleId === role)) {
        out.push({ ...e, from: { categoryId: c.id, path: c.path } });
      }
    }
    for (const role of roles) settled.add(role);
  }
  return out;
}
