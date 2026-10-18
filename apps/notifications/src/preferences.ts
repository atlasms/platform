// A person's notification preferences (EP-25.6; notifications.md §13f), decided 2026-10-18: per
// TYPE, on or off — until they choose, the type's `defaultOn` as their channel has it — and a type
// the registry marks `mandatory` cannot be turned off: the write is refused, not quietly kept.
//
// One row per person per channel (`types: { key: on }`), replaced whole by `PUT /preferences`, a
// compare-and-set on its version (0 for the first) — two tabs saving at once is one write and one
// 409, never a silent merge. Every save is audited (`preference`, the delta of what they chose).

import { delta, type EventPayloads } from '@atlas/contracts';
import { Conflict, ValidationError } from '@atlas/service-kit';
import { BUILT_IN_TYPES, resolveType, type ResolvedType } from './notification-types.ts';
import { outboxRecord } from './record.ts';
import type { Caller } from './service.ts';
import type { InboxStore } from './store.ts';

export interface Preferences {
  channelId: string;
  userId: string;
  /** What they chose, by type key; a type not here is its default. */
  types: Record<string, boolean>;
  version: number;
  updatedAt: string;
}

/** One type as a person sees it: on or off, and why. */
export interface PreferenceView {
  key: string;
  on: boolean;
  /** The channel's default for it. */
  defaultOn: boolean;
  /** On, and they cannot turn it off. */
  mandatory: boolean;
  /** Whether `on` is their own choice rather than the default. */
  chosen: boolean;
}

/** The channel's types, as it has them — the built-ins with its overrides. */
export async function channelTypes(store: InboxStore, channelId: string): Promise<ResolvedType[]> {
  const overrides = new Map((await store.typeOverrides(channelId)).map((o) => [o.key, o] as const));
  return Object.values(BUILT_IN_TYPES).map((b) => resolveType(b, overrides.get(b.key)));
}

/** Whether a person gets a type: mandatory always; otherwise their choice, else the default. */
export function isOn(type: ResolvedType, prefs: Preferences | undefined): boolean {
  if (type.mandatory) return true;
  return prefs?.types[type.key] ?? type.defaultOn;
}

export class PreferencesService {
  private readonly store: InboxStore;
  private readonly now: () => Date;

  constructor(options: { store: InboxStore; now?: () => Date }) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  /** The caller's own — there is no parameter that names a user. */
  async get(caller: Caller): Promise<{ items: PreferenceView[]; version: number }> {
    const [types, prefs] = await Promise.all([
      channelTypes(this.store, caller.channelId),
      this.store.preferences(caller.channelId, caller.userId),
    ]);
    return {
      items: types.map((t) => ({
        key: t.key,
        on: isOn(t, prefs),
        defaultOn: t.defaultOn,
        mandatory: t.mandatory,
        chosen: !t.mandatory && prefs?.types[t.key] !== undefined,
      })),
      version: prefs?.version ?? 0,
    };
  }

  async put(
    caller: Caller & { correlationId?: string },
    ifVersion: number,
    body: Record<string, unknown>,
  ): Promise<{ items: PreferenceView[]; version: number }> {
    for (const key of Object.keys(body))
      if (key !== 'types') throw new ValidationError(`unknown field ${key}`);
    const chosen = body['types'];
    if (typeof chosen !== 'object' || chosen === null || Array.isArray(chosen))
      throw new ValidationError('types must be { "<type key>": true | false }');
    const types = new Map(
      (await channelTypes(this.store, caller.channelId)).map((t) => [t.key, t]),
    );
    const next: Record<string, boolean> = {};
    for (const [key, on] of Object.entries(chosen)) {
      const type = types.get(key);
      if (!type)
        throw new ValidationError(`"${key}" is not a notification type`, { code: 'UNKNOWN_TYPE' });
      if (typeof on !== 'boolean') throw new ValidationError(`types.${key} must be true or false`);
      if (type.mandatory && !on)
        throw new ValidationError(
          `"${key}" is mandatory in this channel — it cannot be turned off`,
          {
            code: 'MANDATORY',
          },
        );
      if (!type.mandatory) next[key] = on;
    }
    const before = await this.store.preferences(caller.channelId, caller.userId);
    if ((before?.version ?? 0) !== ifVersion)
      throw new Conflict(`preferences are at version ${before?.version ?? 0}, not ${ifVersion}`);
    const after: Preferences = {
      channelId: caller.channelId,
      userId: caller.userId,
      types: next,
      version: ifVersion + 1,
      updatedAt: this.now().toISOString(),
    };
    const chain = {
      actor: { kind: 'user' as const, id: caller.userId },
      ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
    };
    await this.store.transaction(async (tx) => {
      if (!(await tx.putPreferences(after, ifVersion)))
        throw new Conflict('preferences changed under you — read them again');
      await tx.enqueue(
        outboxRecord(
          'audit.recorded',
          caller.channelId,
          {
            entityType: 'preference',
            entityId: `${caller.channelId}:${caller.userId}`,
            revision: after.version,
            action: 'preference.updated',
            origin: { service: 'notifications' },
            delta: delta(before ? { types: before.types } : undefined, { types: after.types }),
          } satisfies EventPayloads['audit.recorded'],
          chain,
        ),
      );
    });
    return this.get(caller);
  }
}
