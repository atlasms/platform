// EP-10.4 — the administration of users, groups, roles and grants. EP-10.6 — what it emits.
//
// AUTHORIZATION. Every operation requires `user:admin` (authorization-model.md §9) in the channel
// of the row it touches, enforced with `canEnforce` and the full resource context — so a
// channel-scoped admin manages their channel and nothing else, and a platform-wide row (no
// channel: the starter roles, a platform group) requires an UNSCOPED grant, because a strict check
// with no channel to match cannot be satisfied by a channel-scoped rule. The caller's policy is
// this service's own `effectivePolicy`: IAM is the source of policies and needs no client.
//
// EMISSION. Every mutation writes its rows, its `audit.recorded` delta (AGENTS.md §5.6) and its
// domain events in ONE transaction through the outbox. Whenever what a user MAY DO changes —
// a grant given or revoked, a membership, a role or group whose rules changed, an account
// disabled — the user's `permVersion` is bumped and `permissions.changed` carries the new value,
// which is what lets the gateway refuse the old token and the WebSocket service drop the old
// subscriptions within one access-token TTL (FR-IAM-8). A change to a role reaches every user who
// holds it, directly or through a group: one bump and one event per affected user.

import {
  buildEnvelope,
  delta,
  subjectFor,
  ulid,
  validatePayload,
  type Delta,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { OutboxRecord } from '@atlas/messaging';
import { canEnforce, type EffectivePolicy, type Rule } from '@atlas/policy';
import { Conflict, Forbidden, NotFound, ValidationError } from '@atlas/service-kit';
import { hashPassword } from './passwords.ts';
import type { IamService } from './service.ts';
import type { Assignment, Group, IamStore, IamTx, StoredRole, User } from './store.ts';

export interface AdminCaller {
  userId: string;
  /** The channel the caller acts in — the default for what they create. */
  channelId?: string;
  correlationId?: string;
}

export interface IamAdminOptions {
  service: IamService;
  store: IamStore;
  now?: () => number;
  /** Trace context for the outbox rows, captured where the event is created (EP-13.3). */
  traceHeaders?: () => Record<string, string> | undefined;
}

export interface CreateUserInput {
  username: string;
  password?: string;
  name?: string;
  /** `null` is platform-wide; absent is the caller's channel. */
  channelId?: string | null;
  state?: 'active' | 'invited';
}

export interface UpdateUserInput {
  name?: string;
  state?: 'active' | 'disabled';
  password?: string;
}

export interface RoleInput {
  id?: string;
  channelId?: string | null;
  name?: string;
  description?: string;
  rules?: Rule[];
}

export interface GroupInput {
  channelId?: string | null;
  name?: string;
  description?: string;
  rules?: Rule[];
  roleIds?: string[];
}

export type AssignmentInput = { roleId: string; rule?: never } | { rule: Rule; roleId?: never };

/**
 * What `GET /roles/{id}/holders` answers — `RoleHolders` in iam.yaml.
 *
 * `users` is flattened across paths: a person who holds the role directly AND through a group is
 * one row carrying both facts, because "who does this rule change reach" has one answer per
 * person.
 */
export interface RoleHolders {
  users: { id: string; username: string; assignmentId?: string; viaGroupIds: string[] }[];
  groups: { id: string; name: string }[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class IamAdmin {
  private readonly service: IamService;
  private readonly store: IamStore;
  private readonly now: () => number;
  private readonly traceHeaders: () => Record<string, string> | undefined;

  constructor(options: IamAdminOptions) {
    this.service = options.service;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.traceHeaders = options.traceHeaders ?? (() => undefined);
  }

  // --- users ------------------------------------------------------------------------------------------

  async listUsers(
    caller: AdminCaller,
    options: { channelId?: string; after?: string; limit?: number } = {},
  ): Promise<{ items: User[]; nextCursor?: string }> {
    const policy = await this.policy(caller);
    const channelId = options.channelId ?? caller.channelId;
    this.authorize(policy, channelId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const page = await this.store.users({
      ...(channelId !== undefined ? { channelId } : {}),
      ...(options.after !== undefined ? { after: options.after } : {}),
      limit: limit + 1,
    });
    const items = page.slice(0, limit);
    const last = items[items.length - 1];
    return { items, ...(page.length > limit && last ? { nextCursor: last.id } : {}) };
  }

  async getUser(caller: AdminCaller, id: string): Promise<User> {
    const policy = await this.policy(caller);
    return this.userFor(policy, id);
  }

  async createUser(caller: AdminCaller, input: CreateUserInput): Promise<User> {
    const policy = await this.policy(caller);
    const channelId = input.channelId === null ? undefined : (input.channelId ?? caller.channelId);
    this.authorize(policy, channelId);
    if (typeof input.username !== 'string' || input.username.trim() === '') {
      throw new ValidationError('username is required');
    }
    const user = await this.service.createUser({
      username: input.username.trim(),
      ...(input.password !== undefined ? { password: input.password } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(channelId !== undefined ? { channelId } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
    });
    // The record is written by the service; the events ride a second, small transaction because
    // `createUser` hashes the password before its own. The outbox is what makes that safe: the
    // rows exist, and the events either land or the request fails loudly with them.
    await this.store.transaction(async (tx) => {
      await tx.enqueue(
        this.record(caller, channelOf(user), 'user.created', {
          userId: user.id,
          username: user.username,
          ...(user.name !== undefined ? { name: user.name } : {}),
          state: user.state,
          createdBy: caller.userId,
          createdAt: user.createdAt,
        } satisfies EventPayloads['user.created']),
      );
      await tx.enqueue(this.audit(caller, 'user', user.id, user, undefined, 'user.created'));
    });
    return user;
  }

  async updateUser(caller: AdminCaller, id: string, patch: UpdateUserInput): Promise<User> {
    const policy = await this.policy(caller);
    const before = await this.userFor(policy, id);
    if (patch.state !== undefined && patch.state !== 'active' && patch.state !== 'disabled') {
      throw new ValidationError('state must be active or disabled');
    }
    const after: User = { ...before, version: before.version + 1 };
    const changed: string[] = [];
    if (patch.name !== undefined && patch.name !== before.name) {
      after.name = patch.name;
      changed.push('name');
    }
    let sessionsRevoked = false;
    if (patch.state !== undefined && patch.state !== before.state) {
      // `active` on a locked account is the operator's unlock: the lock and its run go too.
      after.state = patch.state;
      delete after.lockedUntil;
      delete after.failedAttempts;
      delete after.firstFailedAt;
      after.permVersion += 1;
      sessionsRevoked = patch.state === 'disabled';
      changed.push('state');
    }
    const hash = patch.password !== undefined ? await hashPassword(patch.password) : undefined;
    const now = this.iso();
    if (hash !== undefined) {
      after.lastPasswordChange = now;
      changed.push('password');
    }
    if (changed.length === 0) return before;

    await this.store.transaction(async (tx) => {
      await tx.putUser(after);
      if (hash !== undefined) await tx.putCredential({ userId: id, hash, updatedAt: now });
      if (sessionsRevoked) {
        const tokens = await this.store.userTokens(id);
        await tx.revokeTokens(
          tokens.map((t) => t.id),
          now,
        );
      }
      await tx.enqueue(
        this.record(caller, channelOf(after), 'user.updated', {
          userId: id,
          changed,
          ...(changed.includes('state') ? { state: after.state } : {}),
          at: now,
        } satisfies EventPayloads['user.updated']),
      );
      if (changed.includes('state')) await tx.enqueue(this.permissionsChanged(caller, after));
      // The credential is not on the record and never in a delta; the audit says a password
      // changed, not what to.
      await tx.enqueue(
        this.audit(caller, 'user', id, after, before, 'user.updated', {
          ...(hash !== undefined ? { password: { after: '[changed]' } } : {}),
        }),
      );
    });
    return after;
  }

  async effectivePolicyOf(caller: AdminCaller, id: string): Promise<EffectivePolicy> {
    if (id !== caller.userId) {
      const policy = await this.policy(caller);
      await this.userFor(policy, id);
    }
    return this.service.effectivePolicy(id);
  }

  // --- assignments ------------------------------------------------------------------------------------

  async listAssignments(caller: AdminCaller, userId: string): Promise<Assignment[]> {
    const policy = await this.policy(caller);
    await this.userFor(policy, userId);
    return this.store.assignments(userId);
  }

  async createAssignment(
    caller: AdminCaller,
    userId: string,
    input: AssignmentInput,
  ): Promise<Assignment> {
    const policy = await this.policy(caller);
    const user = await this.userFor(policy, userId);
    const assignment: Assignment = { id: ulid(), userId };
    if (input.roleId !== undefined) {
      const role = await this.store.role(input.roleId);
      if (!role) throw new ValidationError(`role ${input.roleId} does not exist`);
      // A channel admin may hand out the platform's roles and their channel's, not another's.
      if (role.channelId !== undefined && role.channelId !== user.channelId) {
        throw new ValidationError(`role ${input.roleId} belongs to another channel`);
      }
      assignment.roleId = input.roleId;
    } else if (input.rule !== undefined) {
      assignment.rule = parseRule(input.rule, 'rule');
      // A grant an admin writes by hand must not reach beyond what they administer.
      this.ruleWithinReach(policy, assignment.rule);
    } else {
      throw new ValidationError('an assignment names a roleId or carries a rule');
    }
    const before = await this.store.assignments(userId);
    const after = { ...user, permVersion: user.permVersion + 1, version: user.version + 1 };
    await this.store.transaction(async (tx) => {
      await tx.putAssignment(assignment);
      await tx.putUser(after);
      await tx.enqueue(this.permissionsChanged(caller, after));
      await tx.enqueue(
        this.audit(caller, 'user', userId, after, user, 'user.updated', {
          assignments: { before: before.map(summary), after: [...before, assignment].map(summary) },
        }),
      );
    });
    return assignment;
  }

  async deleteAssignment(caller: AdminCaller, userId: string, assignmentId: string): Promise<void> {
    const policy = await this.policy(caller);
    const user = await this.userFor(policy, userId);
    const before = await this.store.assignments(userId);
    const target = before.find((a) => a.id === assignmentId);
    if (!target) throw new NotFound(`assignment ${assignmentId}`);
    const after = { ...user, permVersion: user.permVersion + 1, version: user.version + 1 };
    await this.store.transaction(async (tx) => {
      await tx.deleteAssignment(assignmentId);
      await tx.putUser(after);
      await tx.enqueue(this.permissionsChanged(caller, after));
      await tx.enqueue(
        this.audit(caller, 'user', userId, after, user, 'user.updated', {
          assignments: {
            before: before.map(summary),
            after: before.filter((a) => a.id !== assignmentId).map(summary),
          },
        }),
      );
    });
  }

  // --- groups -----------------------------------------------------------------------------------------

  async listGroups(caller: AdminCaller, options: { channelId?: string } = {}): Promise<Group[]> {
    const policy = await this.policy(caller);
    const channelId = options.channelId ?? caller.channelId;
    const groups = await this.store.groups(channelId !== undefined ? { channelId } : {});
    return groups.filter((g) => this.may(policy, g.channelId));
  }

  async getGroup(caller: AdminCaller, id: string): Promise<Group & { members: string[] }> {
    const policy = await this.policy(caller);
    const group = await this.groupFor(policy, id);
    const members = (await this.store.members(id)).map((m) => m.userId);
    return { ...group, members };
  }

  async createGroup(caller: AdminCaller, input: GroupInput): Promise<Group> {
    const policy = await this.policy(caller);
    const channelId = input.channelId === null ? undefined : (input.channelId ?? caller.channelId);
    this.authorize(policy, channelId);
    // A ULID, minted here: group ids travel in `group.membership.changed`, whose schema says so.
    // Roles are the named things (`editor`); a group is addressed through its name in the UI.
    const id = ulid();
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new ValidationError('name is required');
    }
    const group: Group = {
      id,
      ...(channelId !== undefined ? { channelId } : {}),
      name: input.name.trim(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.rules !== undefined ? { rules: this.parseRules(policy, input.rules) } : {}),
      ...(input.roleIds !== undefined
        ? { roleIds: await this.roleIdsFor(channelId, input.roleIds) }
        : {}),
      version: 1,
    };
    await this.store.transaction(async (tx) => {
      await tx.putGroup(group);
      await tx.enqueue(this.audit(caller, 'group', id, group, undefined, 'group.created'));
    });
    return group;
  }

  async updateGroup(caller: AdminCaller, id: string, input: GroupInput): Promise<Group> {
    const policy = await this.policy(caller);
    const before = await this.groupFor(policy, id);
    const after: Group = { ...before, version: before.version + 1 };
    if (input.name !== undefined) after.name = input.name.trim();
    if (input.description !== undefined) after.description = input.description;
    if (input.rules !== undefined) after.rules = this.parseRules(policy, input.rules);
    if (input.roleIds !== undefined)
      after.roleIds = await this.roleIdsFor(before.channelId, input.roleIds);
    const grantsChanged =
      JSON.stringify(before.rules ?? []) !== JSON.stringify(after.rules ?? []) ||
      JSON.stringify(before.roleIds ?? []) !== JSON.stringify(after.roleIds ?? []);
    const members = grantsChanged ? (await this.store.members(id)).map((m) => m.userId) : [];
    await this.store.transaction(async (tx) => {
      await tx.putGroup(after);
      await tx.enqueue(this.audit(caller, 'group', id, after, before, 'group.updated'));
      for (const userId of members) await this.bump(tx, caller, userId);
    });
    return after;
  }

  async deleteGroup(caller: AdminCaller, id: string): Promise<void> {
    const policy = await this.policy(caller);
    const group = await this.groupFor(policy, id);
    const members = (await this.store.members(id)).map((m) => m.userId);
    await this.store.transaction(async (tx) => {
      for (const userId of members) {
        await tx.deleteMembership({ userId, groupId: id });
        const user = await this.bump(tx, caller, userId);
        await tx.enqueue(this.membershipChanged(caller, user, id, 'removed'));
      }
      await tx.deleteGroup(id);
      await tx.enqueue(this.audit(caller, 'group', id, undefined, group, 'group.deleted'));
    });
  }

  async listMembers(caller: AdminCaller, groupId: string): Promise<string[]> {
    const policy = await this.policy(caller);
    await this.groupFor(policy, groupId);
    return (await this.store.members(groupId)).map((m) => m.userId);
  }

  async addMember(caller: AdminCaller, groupId: string, userId: string): Promise<void> {
    const policy = await this.policy(caller);
    const group = await this.groupFor(policy, groupId);
    const user = await this.userFor(policy, userId);
    // A channel's group takes the channel's users; a platform group takes anyone.
    if (group.channelId !== undefined && user.channelId !== group.channelId) {
      throw new ValidationError('the user belongs to another channel');
    }
    const members = (await this.store.members(groupId)).map((m) => m.userId);
    if (members.includes(userId)) return; // idempotent: twice is one membership, no second event
    // A membership is a revision of the GROUP: its version moves, and the audit carries the new
    // revision. Auditing the same revision twice is what the sink's history key refuses — the
    // smoke suite found the second membership event redelivered forever.
    const revised: Group = { ...group, version: group.version + 1 };
    await this.store.transaction(async (tx) => {
      await tx.putMembership({ userId, groupId });
      await tx.putGroup(revised);
      const after = await this.bump(tx, caller, userId);
      await tx.enqueue(this.membershipChanged(caller, after, groupId, 'added'));
      await tx.enqueue(
        this.audit(caller, 'group', groupId, revised, group, 'group.updated', {
          members: { before: members, after: [...members, userId] },
        }),
      );
    });
  }

  async removeMember(caller: AdminCaller, groupId: string, userId: string): Promise<void> {
    const policy = await this.policy(caller);
    const group = await this.groupFor(policy, groupId);
    await this.userFor(policy, userId);
    const members = (await this.store.members(groupId)).map((m) => m.userId);
    if (!members.includes(userId)) return; // idempotent
    const revised: Group = { ...group, version: group.version + 1 };
    await this.store.transaction(async (tx) => {
      await tx.deleteMembership({ userId, groupId });
      await tx.putGroup(revised);
      const after = await this.bump(tx, caller, userId);
      await tx.enqueue(this.membershipChanged(caller, after, groupId, 'removed'));
      await tx.enqueue(
        this.audit(caller, 'group', groupId, revised, group, 'group.updated', {
          members: { before: members, after: members.filter((m) => m !== userId) },
        }),
      );
    });
  }

  // --- roles ------------------------------------------------------------------------------------------

  async listRoles(
    caller: AdminCaller,
    options: { channelId?: string } = {},
  ): Promise<StoredRole[]> {
    const policy = await this.policy(caller);
    const channelId = options.channelId ?? caller.channelId;
    const roles = await this.store.roles(channelId !== undefined ? { channelId } : {});
    // Readable when the caller administers the role's channel OR holds it: what a role grants is
    // not secret from the people it is granted to. Platform roles are readable by every admin.
    return roles.filter((r) => r.channelId === undefined || this.may(policy, r.channelId));
  }

  async getRole(caller: AdminCaller, id: string): Promise<StoredRole> {
    const policy = await this.policy(caller);
    const role = await this.store.role(id);
    if (!role || (role.channelId !== undefined && !this.may(policy, role.channelId))) {
      throw new NotFound(`role ${id}`);
    }
    return role;
  }

  async createRole(caller: AdminCaller, input: RoleInput): Promise<StoredRole> {
    const policy = await this.policy(caller);
    const channelId = input.channelId === null ? undefined : (input.channelId ?? caller.channelId);
    this.authorize(policy, channelId);
    const id = input.id ?? ulid().toLowerCase();
    if (!ID_RE.test(id)) throw new ValidationError('id must be kebab-case');
    if (await this.store.role(id)) throw new Conflict(`role ${id} exists`);
    const role: StoredRole = {
      id,
      ...(channelId !== undefined ? { channelId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      rules: this.parseRules(policy, input.rules ?? []),
      version: 1,
    };
    await this.store.transaction(async (tx) => {
      await tx.putRole(role);
      await tx.enqueue(this.audit(caller, 'role', id, role, undefined, 'role.created'));
    });
    return role;
  }

  async updateRole(caller: AdminCaller, id: string, input: RoleInput): Promise<StoredRole> {
    const policy = await this.policy(caller);
    const before = await this.roleFor(policy, id);
    const after: StoredRole = { ...before, version: before.version + 1 };
    if (input.name !== undefined) after.name = input.name;
    if (input.description !== undefined) after.description = input.description;
    if (input.rules !== undefined) after.rules = this.parseRules(policy, input.rules);
    const grantsChanged = JSON.stringify(before.rules) !== JSON.stringify(after.rules);
    const holders = grantsChanged ? await this.holdersOf(id) : [];
    await this.store.transaction(async (tx) => {
      await tx.putRole(after);
      await tx.enqueue(this.audit(caller, 'role', id, after, before, 'role.updated'));
      for (const userId of holders) await this.bump(tx, caller, userId);
    });
    return after;
  }

  /**
   * Who the role reaches: the groups that carry it, and every user it reaches by any path.
   *
   * The same question `deleteRole` asks to decide its 409 and `updateRole` asks to decide whose
   * `permVersion` to bump — surfaced, because an administrator about to change a role's rules is
   * entitled to see the blast radius first. A direct holder carries the id of the grant itself,
   * so revoking it needs no second request to read the user's assignments.
   */
  async roleHolders(caller: AdminCaller, id: string): Promise<RoleHolders> {
    const policy = await this.policy(caller);
    await this.roleFor(policy, id);
    const { assignments, groups } = await this.store.roleHolders(id);

    const users = new Map<string, RoleHolders['users'][number]>();
    const add = async (userId: string): Promise<RoleHolders['users'][number] | undefined> => {
      const existing = users.get(userId);
      if (existing) return existing;
      const user = await this.store.user(userId);
      // A membership or an assignment whose user is gone is not an error to report here; the row
      // is simply nobody. Deleting a user cascades both, so this is belt and braces.
      if (!user) return undefined;
      const entry = { id: user.id, username: user.username, viaGroupIds: [] as string[] };
      users.set(userId, entry);
      return entry;
    };

    for (const assignment of assignments) {
      const entry = await add(assignment.userId);
      if (entry) entry.assignmentId = assignment.id;
    }
    for (const group of groups) {
      for (const membership of await this.store.members(group.id)) {
        const entry = await add(membership.userId);
        entry?.viaGroupIds.push(group.id);
      }
    }

    return {
      users: [...users.values()].sort((a, b) => a.username.localeCompare(b.username)),
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
    };
  }

  async deleteRole(caller: AdminCaller, id: string): Promise<void> {
    const policy = await this.policy(caller);
    const role = await this.roleFor(policy, id);
    // Refused while anything carries it, rather than cascading a revocation nobody asked for by
    // name: revoke the grants first, then the role goes.
    if ((await this.holdersOf(id)).length > 0) throw new Conflict(`role ${id} is still granted`);
    await this.store.transaction(async (tx) => {
      await tx.deleteRole(id);
      await tx.enqueue(this.audit(caller, 'role', id, undefined, role, 'role.deleted'));
    });
  }

  // --- internals --------------------------------------------------------------------------------------

  private async policy(caller: AdminCaller): Promise<EffectivePolicy> {
    return this.service.effectivePolicy(caller.userId);
  }

  /** `user:admin` in the row's channel; with no channel, only an unscoped grant passes (strict). */
  private may(policy: EffectivePolicy, channelId: string | undefined): boolean {
    return canEnforce(policy, 'user:admin', {
      type: 'user',
      ...(channelId !== undefined ? { channelId } : {}),
    }).allowed;
  }

  private authorize(policy: EffectivePolicy, channelId: string | undefined): void {
    if (!this.may(policy, channelId)) {
      throw new Forbidden(
        channelId !== undefined
          ? `user:admin in channel ${channelId} required`
          : 'an unscoped user:admin is required for a platform-wide row',
      );
    }
  }

  /** A user the caller may administer; another channel's user is not found, not forbidden. */
  private async userFor(policy: EffectivePolicy, id: string): Promise<User> {
    const user = await this.store.user(id);
    if (!user || !this.may(policy, user.channelId)) throw new NotFound(`user ${id}`);
    return user;
  }

  private async groupFor(policy: EffectivePolicy, id: string): Promise<Group> {
    const group = await this.store.group(id);
    if (!group || !this.may(policy, group.channelId)) throw new NotFound(`group ${id}`);
    return group;
  }

  private async roleFor(policy: EffectivePolicy, id: string): Promise<StoredRole> {
    const role = await this.store.role(id);
    if (!role || !this.may(policy, role.channelId)) throw new NotFound(`role ${id}`);
    return role;
  }

  /** Roles a group in `channelId` may carry: the platform's and its own channel's. */
  private async roleIdsFor(channelId: string | undefined, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      const role = await this.store.role(id);
      if (!role) throw new ValidationError(`role ${id} does not exist`);
      if (role.channelId !== undefined && role.channelId !== channelId) {
        throw new ValidationError(`role ${id} belongs to another channel`);
      }
    }
    return unique;
  }

  private parseRules(policy: EffectivePolicy, rules: unknown): Rule[] {
    if (!Array.isArray(rules)) throw new ValidationError('rules must be an array');
    return rules.map((r, i) => {
      const rule = parseRule(r, `rules[${i}]`);
      this.ruleWithinReach(policy, rule);
      return rule;
    });
  }

  /**
   * A rule an admin writes must not grant beyond the channels they administer: a channel admin
   * cannot write a rule scoped to another channel, nor an unscoped one (which would be every
   * channel). An unscoped admin may write either.
   */
  private ruleWithinReach(policy: EffectivePolicy, rule: Rule): void {
    const channels = rule.scope?.channelIds;
    if (channels === undefined || channels.length === 0) {
      if (!this.may(policy, undefined)) {
        throw new Forbidden('an unscoped rule needs an unscoped user:admin');
      }
      return;
    }
    for (const channelId of channels) {
      if (!this.may(policy, channelId)) {
        throw new Forbidden(`a rule for channel ${channelId} needs user:admin there`);
      }
    }
  }

  /**
   * Users who hold the role directly or through a group.
   *
   * This used to walk every user in the estate — `users({ limit: 10_000 })`, then each one's
   * assignments, then each one's memberships, then each membership's group — which made the cost
   * of editing or deleting a role a function of how many people exist rather than of how many
   * hold it. It is now two indexed reads and the members of the groups that actually carry it.
   * The 10_000 was also a silent ceiling: user 10_001 kept a grant nobody could see.
   */
  private async holdersOf(roleId: string): Promise<string[]> {
    const { assignments, groups } = await this.store.roleHolders(roleId);
    const holders = new Set(assignments.map((a) => a.userId));
    for (const group of groups) {
      for (const membership of await this.store.members(group.id)) holders.add(membership.userId);
    }
    return [...holders];
  }

  /**
   * Bump the user's permVersion in `tx` and queue `permissions.changed`; returns the new record.
   *
   * `permVersion` only — not `version`. The user's record is not what changed here; the group or
   * role that reaches them was, and it carries the audit. `version` is the user's audited revision
   * counter, and a bump without an audit would leave a hole in their history.
   */
  private async bump(tx: IamTx, caller: AdminCaller, userId: string): Promise<User> {
    const user = await this.store.user(userId);
    if (!user) throw new NotFound(`user ${userId}`);
    const after = { ...user, permVersion: user.permVersion + 1 };
    await tx.putUser(after);
    await tx.enqueue(this.permissionsChanged(caller, after));
    return after;
  }

  private permissionsChanged(caller: AdminCaller, user: User): OutboxRecord {
    return this.record(caller, channelOf(user), 'permissions.changed', {
      userId: user.id,
      permVersion: user.permVersion,
    } satisfies EventPayloads['permissions.changed']);
  }

  private membershipChanged(
    caller: AdminCaller,
    user: User,
    groupId: string,
    action: 'added' | 'removed',
  ): OutboxRecord {
    return this.record(caller, channelOf(user), 'group.membership.changed', {
      userId: user.id,
      groupId,
      action,
      permVersion: user.permVersion,
      by: caller.userId,
      at: this.iso(),
    } satisfies EventPayloads['group.membership.changed']);
  }

  private audit(
    caller: AdminCaller,
    entityType: 'user' | 'group' | 'role',
    entityId: string,
    after: object | undefined,
    before: object | undefined,
    action: string,
    sideTables: Delta = {},
  ): OutboxRecord {
    // A deletion has no `after`: it is the revision AFTER the last one, not a repeat of it — the
    // sink keys history on (entity, revision), and a repeated revision is refused, not merged.
    const revision =
      (after as { version?: number } | undefined)?.version ??
      ((before as { version?: number } | undefined)?.version ?? 0) + 1;
    const channelId =
      (after as { channelId?: string } | undefined)?.channelId ??
      (before as { channelId?: string } | undefined)?.channelId ??
      PLATFORM;
    return this.record(caller, channelId, 'audit.recorded', {
      entityType,
      entityId,
      revision,
      action,
      origin: { service: 'iam' },
      delta: {
        ...delta(
          before as Record<string, unknown> | undefined,
          (after ?? {}) as Record<string, unknown>,
        ),
        ...sideTables,
      },
    } satisfies EventPayloads['audit.recorded']);
  }

  private record(
    caller: AdminCaller,
    channelId: string,
    type: string,
    payload: object,
  ): OutboxRecord {
    const check = validatePayload(type, payload);
    if (!check.valid) {
      throw new ValidationError(
        `${type} payload does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    }
    const envelope: Envelope = buildEnvelope({
      type,
      channelId,
      payload: payload as Record<string, unknown>,
      actor: { kind: 'user', id: caller.userId },
      ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
    });
    const headers = this.traceHeaders();
    return {
      id: envelope.messageId,
      message: {
        id: envelope.messageId,
        subject: subjectFor(channelId, type),
        body: envelope,
        ...(headers !== undefined ? { headers } : {}),
      },
    };
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/**
 * The channel segment of an event about a user without one. A platform-wide account's events
 * still need a subject, and `permissions.changed` is matched by its suffix wherever it is.
 */
export const PLATFORM = 'platform';
const channelOf = (user: User): string => user.channelId ?? PLATFORM;

const summary = (a: Assignment): Record<string, unknown> => ({
  id: a.id,
  ...(a.roleId !== undefined ? { roleId: a.roleId } : {}),
  ...(a.rule !== undefined ? { rule: a.rule.id } : {}),
});

/** A rule as policy-rule.schema.json describes it, checked at the edge before it is stored. */
export function parseRule(body: unknown, where: string): Rule {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError(`${where} must be an object`);
  }
  const r = body as Record<string, unknown>;
  const id = typeof r['id'] === 'string' && r['id'] !== '' ? r['id'] : ulid();
  if (!Array.isArray(r['permissions']) || r['permissions'].length === 0) {
    throw new ValidationError(`${where}.permissions must be a non-empty array`);
  }
  const permissions = r['permissions'].map((p) => {
    if (typeof p !== 'string' || !/^(\*|[a-z][a-z0-9-]*):(\*|[a-z][a-z0-9-]*)$/.test(p)) {
      throw new ValidationError(`${where}.permissions: "${String(p)}" is not resource:action`);
    }
    return p;
  });
  const effect = r['effect'];
  if (effect !== undefined && effect !== 'allow' && effect !== 'deny') {
    throw new ValidationError(`${where}.effect must be allow or deny`);
  }
  const strings = (key: string): string[] | undefined => {
    const v = r[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new ValidationError(`${where}.${key} must be an array of strings`);
    }
    return v as string[];
  };
  const scopeIn = r['scope'];
  let scope: Rule['scope'];
  if (scopeIn !== undefined) {
    if (typeof scopeIn !== 'object' || scopeIn === null) {
      throw new ValidationError(`${where}.scope must be an object`);
    }
    const s = scopeIn as Record<string, unknown>;
    const list = (key: string): string[] | undefined => {
      const v = s[key];
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
        throw new ValidationError(`${where}.scope.${key} must be an array of strings`);
      }
      return v as string[];
    };
    const channelIds = list('channelIds');
    const categoryPaths = list('categoryPaths');
    const states = list('states');
    const ownedOnly = s['ownedOnly'];
    if (ownedOnly !== undefined && typeof ownedOnly !== 'boolean') {
      throw new ValidationError(`${where}.scope.ownedOnly must be a boolean`);
    }
    scope = {
      ...(channelIds !== undefined ? { channelIds } : {}),
      ...(categoryPaths !== undefined ? { categoryPaths } : {}),
      ...(states !== undefined ? { states } : {}),
      ...(ownedOnly !== undefined ? { ownedOnly } : {}),
    };
  }
  const description = r['description'];
  if (description !== undefined && typeof description !== 'string') {
    throw new ValidationError(`${where}.description must be a string`);
  }
  const fieldGroups = strings('fieldGroups');
  return {
    id,
    permissions,
    ...(description !== undefined ? { description } : {}),
    ...(effect !== undefined ? { effect } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(fieldGroups !== undefined ? { fieldGroups } : {}),
  };
}
