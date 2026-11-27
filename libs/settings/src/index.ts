// Tier-3 settings, served by the service that acts on them (EP-33.2).
//
// Design: docs/architecture/configuration-and-reference-data.md §2.4–2.5, §5, §7–8.
//
// `@atlas/reference` declares a setting and validates and resolves a value; `@atlas/data` (and
// `@atlas/data-pg`) store the value at a level. This is the piece between them that every owning
// service would otherwise write for itself: WHO may write a level, what a reader is shown, and
// what a write must commit with — the row, its `audit.recorded` (§7) and its `config.changed`
// (§5 step 3), in one unit of work. It plans; the service commits, through its own transaction
// and its own outbox, which is why nothing here touches a database or a broker.

import { isUlid, type EventPayloads } from '@atlas/contracts';
import type { StoredSetting } from '@atlas/data';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import {
  levelPermitted,
  resolveSetting,
  validateWrite,
  type Resolved,
  type ScopeContext,
  type ScopeLevel,
  type SettingDescriptor,
  type SettingRow,
  type SettingsRegistry,
  type SettingValue,
} from '@atlas/reference';
import { Conflict, Forbidden, NotFound, ValidationError } from '@atlas/service-kit';

/** The caller as an owning service knows them: who, in which channel, under which policy. */
export interface SettingsCaller {
  userId: string;
  channelId: string;
  policy?: EffectivePolicy;
}

/** A level and the scope instance at it — `scopeId` is `''` at `deployment`. */
export interface SettingScope {
  level: ScopeLevel;
  scopeId: string;
}

/** One level's stored value, as a reader is shown it. */
export interface LevelValue {
  /** Absent when the row was reset (`set: false`) or the value is sensitive. */
  value?: SettingValue;
  set: boolean;
  /** The compare-and-set token: send it back as `?version=` to change or reset this level. */
  version: number;
  updatedBy: string;
  updatedAt: string;
  /** The value exists but is not shown (`sensitive: true`). */
  redacted?: boolean;
}

/** One setting as `GET /settings/{area}` answers it. */
export interface SettingView {
  key: string;
  descriptor: SettingDescriptor;
  /** What the caller's channel (and the caller) get now, and from which level. */
  resolved: Omit<Resolved, 'value'> & { value?: SettingValue; redacted?: boolean };
  /** The rows behind it, by level: only the levels the reader's scope reaches. */
  levels: Partial<Record<ScopeLevel, LevelValue>>;
  /** The levels this caller may write — what Studio offers an editor for. */
  writable: ScopeLevel[];
}

export interface SettingsView {
  area: string;
  configVersion: number;
  settings: SettingView[];
}

/** What a write commits: the row, how to compare-and-set it, and the two records it announces. */
export interface SettingWrite {
  row: StoredSetting;
  /** `undefined` = a first row at this level (insert only). */
  ifVersion?: number;
  /** The `audit.recorded` payload — revision is the row's version. */
  audit: EventPayloads['audit.recorded'];
  /** The `config.changed` payload, once the service knows the version its snapshot moved to. */
  changed: (configVersion: number) => EventPayloads['config.changed'];
}

const REDACTED = '(changed)';

/**
 * The settings of ONE area (an owning service), and the rules for reading and writing them.
 *
 * Permissions (configuration §8, FR-CFG-10): reading is `config:read` or `config:admin` in the
 * channel; writing is `config:admin` SCOPED TO THE LEVEL — the caller's channel for `channel`,
 * an UNSCOPED grant for `deployment` (a channel's grant cannot reach it, the same strict check as
 * MTS's platform-wide profiles). A descriptor's `permission` replaces `config:admin` for its key.
 * A `user` value is the caller's own preference and needs no permission — but only their own.
 */
export class SettingsAdmin {
  readonly area: string;
  private readonly descriptors: Map<string, SettingDescriptor>;
  private readonly service: string;

  constructor(registry: SettingsRegistry, options: { service?: string } = {}) {
    this.area = registry.area;
    this.descriptors = new Map(Object.entries(registry.descriptors));
    this.service = options.service ?? registry.area;
  }

  /** Every descriptor, key order. */
  list(): SettingDescriptor[] {
    return [...this.descriptors.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  descriptor(key: string): SettingDescriptor {
    const d = this.descriptors.get(key);
    if (!d) throw new NotFound(`no setting "${key}" in ${this.area}`);
    return d;
  }

  /**
   * The level a request names, normalised and held to the caller.
   *
   * A channel value is written for the caller's OWN channel and a user value for the caller
   * themselves: the token is minted for one channel (AGENTS.md §5.3), and an admin of two
   * channels switches channel to administer the other. `category` is refused until a service
   * that owns categories wires the subtree check (configuration §2.5 — MAM's category policies
   * are their own mechanism today, data-model §2.7).
   */
  scopeOf(caller: SettingsCaller, level: string, scopeId?: string): SettingScope {
    switch (level) {
      case 'deployment':
        if (scopeId !== undefined && scopeId !== '') {
          throw new ValidationError('a deployment value has no scopeId');
        }
        return { level, scopeId: '' };
      case 'channel':
        if (scopeId !== undefined && scopeId !== caller.channelId) {
          throw new Forbidden(
            'a channel value is written in the channel the caller is signed in to',
          );
        }
        return { level, scopeId: caller.channelId };
      case 'user':
        if (scopeId !== undefined && scopeId !== caller.userId) {
          throw new Forbidden("a user value is the caller's own; nobody writes another person's");
        }
        return { level, scopeId: caller.userId };
      case 'category':
        throw new ValidationError(`${this.area} does not take category values`);
      default:
        throw new ValidationError(`unknown level "${level}"`);
    }
  }

  /** `config:read` or `config:admin` in the caller's channel. */
  authorizeRead(caller: SettingsCaller): void {
    const policy = this.policyOf(caller);
    const context = { type: 'setting', channelId: caller.channelId };
    const allowed = ['config:read', 'config:admin'].some(
      (p) => canEnforce(policy, p, context).allowed,
    );
    if (!allowed) throw new Forbidden('config:read required');
  }

  /** May the caller write `key` at `scope`? Throws Forbidden with the reason when not. */
  authorizeWrite(caller: SettingsCaller, d: SettingDescriptor, scope: SettingScope): void {
    if (!levelPermitted(d, scope.level)) {
      throw new ValidationError(
        `${this.area}.${d.key} cannot be set at "${scope.level}"; the deepest level is "${d.scope}"`,
      );
    }
    if (scope.level === 'user') return; // the caller's own — scopeOf held it to them
    if (!this.mayWrite(caller, d, scope.level)) {
      const permission = d.permission ?? 'config:admin';
      throw new Forbidden(
        scope.level === 'deployment'
          ? `an unscoped ${permission} is required for a deployment value`
          : `${permission} required`,
      );
    }
  }

  /**
   * The reader's view: every setting, what it resolves to for them and from where, the rows
   * behind it at the levels they can see, and the levels they may write.
   */
  view(caller: SettingsCaller, rows: StoredSetting[], configVersion: number): SettingsView {
    this.authorizeRead(caller);
    const context: ScopeContext = { channel: caller.channelId, user: caller.userId };
    const settings = this.list().map((d): SettingView => {
      const mine = rows.filter((r) => r.area === this.area && r.key === d.key);
      const resolved = resolveSetting(d, toRows(mine), context);
      const levels: Partial<Record<ScopeLevel, LevelValue>> = {};
      for (const r of mine) {
        if (!visible(r, caller)) continue;
        levels[r.level as ScopeLevel] = levelValue(d, r);
      }
      const { value, ...rest } = resolved;
      return {
        key: d.key,
        descriptor: d,
        resolved:
          d.sensitive === true && resolved.origin !== 'default'
            ? { ...rest, redacted: true }
            : { ...rest, value },
        levels,
        writable: (['deployment', 'channel', 'user'] as const).filter(
          (level) =>
            levelPermitted(d, level) && (level === 'user' || this.mayWrite(caller, d, level)),
        ),
      };
    });
    return { area: this.area, configVersion, settings };
  }

  /** What `key` resolves to for a channel (and optionally a user) — for the service's own use. */
  resolve(key: string, rows: StoredSetting[], context: ScopeContext): Resolved {
    const d = this.descriptor(key);
    return resolveSetting(
      d,
      toRows(rows.filter((r) => r.area === this.area && r.key === d.key)),
      context,
    );
  }

  /**
   * Plan setting `key` to `value` at `scope`.
   *
   * `existing` is the row at that level as read BEFORE the transaction (never read back inside
   * it — AGENTS.md §6); `expectVersion` is the caller's `?version=`. A row that exists must be
   * named by its version, and a first value must not name one: either mismatch is a 409, so two
   * administrators editing one level cannot overwrite each other unseen.
   */
  planSet(
    caller: SettingsCaller,
    key: string,
    scope: SettingScope,
    value: SettingValue,
    existing: StoredSetting | undefined,
    expectVersion: number | undefined,
    now: Date,
  ): SettingWrite {
    const d = this.descriptor(key);
    this.authorizeWrite(caller, d, scope);
    const check = validateWrite(d, value, scope.level);
    if (!check.valid) {
      throw new ValidationError(`${this.area}.${key} is not valid`, { problems: check.problems });
    }
    this.expect(existing, expectVersion, key, scope);
    const row = this.rowOf(caller, d, scope, now, existing, { set: true, value });
    return this.write(caller, d, scope, row, existing, 'setting.set');
  }

  /**
   * Plan a reset of `key` at `scope` to whatever the next level up says. The row is kept, unset,
   * so its version — the audit revision — carries on (see `StoredSetting.value`).
   */
  planReset(
    caller: SettingsCaller,
    key: string,
    scope: SettingScope,
    existing: StoredSetting | undefined,
    expectVersion: number | undefined,
    now: Date,
  ): SettingWrite | undefined {
    const d = this.descriptor(key);
    this.authorizeWrite(caller, d, scope);
    if (!existing || !existing.set) return undefined; // nothing set here: already inherited
    this.expect(existing, expectVersion, key, scope);
    const row = this.rowOf(caller, d, scope, now, existing, { set: false });
    return this.write(caller, d, scope, row, existing, 'setting.reset');
  }

  // --- internals ---------------------------------------------------------------------------------

  private policyOf(caller: SettingsCaller): EffectivePolicy {
    if (!caller.policy) throw new Forbidden('no policy for the caller');
    return caller.policy;
  }

  private mayWrite(caller: SettingsCaller, d: SettingDescriptor, level: ScopeLevel): boolean {
    if (!caller.policy) return false;
    const permission = d.permission ?? 'config:admin';
    // No channel in the context at `deployment`: only a grant with no channel scope matches it.
    const context =
      level === 'deployment'
        ? { type: 'setting' }
        : { type: 'setting', channelId: caller.channelId };
    return canEnforce(caller.policy, permission, context).allowed;
  }

  private expect(
    existing: StoredSetting | undefined,
    expectVersion: number | undefined,
    key: string,
    scope: SettingScope,
  ): void {
    const at = `${this.area}.${key} at ${scope.level}`;
    if (existing && expectVersion === undefined) {
      throw new Conflict(`${at} already has a row; send its version`, {
        version: existing.version,
      });
    }
    if (existing && expectVersion !== existing.version) {
      throw new Conflict(`${at} is at version ${existing.version}, not ${expectVersion}`, {
        version: existing.version,
      });
    }
    if (!existing && expectVersion !== undefined) {
      throw new Conflict(`${at} has no row to be at version ${expectVersion}`);
    }
  }

  private rowOf(
    caller: SettingsCaller,
    d: SettingDescriptor,
    scope: SettingScope,
    now: Date,
    existing: StoredSetting | undefined,
    content: { set: true; value: SettingValue } | { set: false },
  ): StoredSetting {
    return {
      area: this.area,
      key: d.key,
      level: scope.level,
      scopeId: scope.scopeId,
      // A deployment value is the platform's; every other level belongs to the caller's channel.
      channelId: scope.level === 'deployment' ? null : caller.channelId,
      value: content.set ? content.value : undefined,
      set: content.set,
      version: (existing?.version ?? 0) + 1,
      updatedBy: caller.userId,
      updatedAt: now.toISOString(),
    };
  }

  private write(
    caller: SettingsCaller,
    d: SettingDescriptor,
    scope: SettingScope,
    row: StoredSetting,
    existing: StoredSetting | undefined,
    action: 'setting.set' | 'setting.reset',
  ): SettingWrite {
    const before = existing?.set === true ? existing.value : undefined;
    const after = row.set ? row.value : undefined;
    const entry: { before?: unknown; after?: unknown } = {};
    // Sensitive values are redacted in the diff: it says THAT the value changed, never what to
    // (configuration §7, FR-CFG-9).
    if (before !== undefined) entry.before = d.sensitive === true ? REDACTED : before;
    if (after !== undefined) entry.after = d.sensitive === true ? REDACTED : after;
    const audit: EventPayloads['audit.recorded'] = {
      entityType: 'setting',
      entityId: entityIdOf(this.area, d.key, scope),
      revision: row.version,
      action,
      origin: { service: this.service },
      delta: { value: entry },
    };
    return {
      row,
      ...(existing ? { ifVersion: existing.version } : {}),
      audit,
      changed: (configVersion) => ({
        area: this.area,
        tier: 'setting',
        keys: [d.key],
        scopeLevel: scope.level,
        ...(scope.level !== 'deployment' ? { scopeId: scope.scopeId } : {}),
        configVersion,
        ...(d.restart === true ? { restartRequired: true } : {}),
        // `actorId` is a ULID by contract; a caller id that is not one (a service actor's name)
        // is simply not carried, rather than failing the write's own event.
        ...(isUlid(caller.userId) ? { actorId: caller.userId } : {}),
      }),
    };
  }
}

/**
 * A setting's audit identity: `<area>.<key>@<level>[:<scopeId>]`. The level is part of it — a
 * channel's value and the platform's are two histories, like MTS's platform-wide profiles.
 */
export function entityIdOf(area: string, key: string, scope: SettingScope): string {
  return `${area}.${key}@${scope.level}${scope.scopeId ? `:${scope.scopeId}` : ''}`;
}

/** Stored rows as the resolver reads them — reset rows are not values. */
function toRows(rows: StoredSetting[]): SettingRow[] {
  return rows
    .filter((r) => r.set)
    .map((r) => ({
      key: r.key,
      level: r.level as ScopeLevel,
      ...(r.level !== 'deployment' ? { scopeId: r.scopeId } : {}),
      value: r.value as SettingValue,
    }));
}

/** A reader sees the platform's row, their channel's, and their own — never another user's. */
function visible(r: StoredSetting, caller: SettingsCaller): boolean {
  if (r.level === 'deployment') return true;
  if (r.level === 'user') return r.scopeId === caller.userId;
  return r.channelId === caller.channelId;
}

function levelValue(d: SettingDescriptor, r: StoredSetting): LevelValue {
  const base = { set: r.set, version: r.version, updatedBy: r.updatedBy, updatedAt: r.updatedAt };
  if (!r.set) return base;
  return d.sensitive === true
    ? { ...base, redacted: true }
    : { ...base, value: r.value as SettingValue };
}

/**
 * The settings rows a service holds in memory, per channel, for a bounded time (§5: settings are
 * read from a snapshot, never row-by-row per request).
 *
 * A write in THIS replica clears it; another replica's write reaches it through `config.changed`
 * (subscribed in broadcast mode — every replica, not one of them) and the TTL bounds what a lost
 * event delays. A miss is loaded once even under concurrent reads; a failed load is not cached.
 */
export class SettingsCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { at: number; rows: Promise<StoredSetting[]> }>();

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  async get(channelId: string, load: () => Promise<StoredSetting[]>): Promise<StoredSetting[]> {
    const hit = this.entries.get(channelId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.rows;
    const rows = load();
    this.entries.set(channelId, { at: this.now(), rows });
    rows.catch(() => {
      if (this.entries.get(channelId)?.rows === rows) this.entries.delete(channelId);
    });
    return rows;
  }

  /** Forget everything — after a write here, or on any `config.changed` for this area. */
  clear(): void {
    this.entries.clear();
  }
}
