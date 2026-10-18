// The event → notification pipeline (EP-25.5; notifications.md §13e), routed as decided on
// 2026-10-18:
//
// | event                | type                  | to                                        |
// |----------------------|-----------------------|-------------------------------------------|
// | `asset.approved`     | `asset.approved`      | the asset's creator                       |
// | `asset.rejected`     | `asset.rejected`      | the asset's creator                       |
// | `asset.expired`      | `asset.re-review-due` | whoever approved it last                  |
// | `transcode.failed`   | `transcode.failed`    | whoever asked for the transcode           |
// | `message.sent`       | `message.mention`     | a user @-mentioned who can read it        |
//
// Every recipient is RE-CHECKED before anything is written: their policy (IAM's, as for a request)
// must let them read the subject — an asset in its category, owned by its creator — or they are
// told nothing (notifications.md §10: a notification must not reveal what its reader cannot see).
// Someone with no policy — a service id, a user since disabled — is told nothing. A mention reaches
// only someone the message is to, by name or through a group they are in now.
//
// One transaction per event: the seen-mark, every notification row and its `notification.raised`.
// The type as the channel has it decides whether anything is raised (`enabled`), its severity and
// its title in every locale; a person's own preference is EP-25.6's (`wants`).

import {
  envelopeShapeErrors,
  ulid,
  validatePayload,
  type EntityRef,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import type { Message as BrokerMessage } from '@atlas/messaging';
import { canEnforce, type EffectivePolicy, type ResourceContext } from '@atlas/policy';
import { Conflict, Forbidden, ValidationError } from '@atlas/service-kit';
import { delta } from '@atlas/contracts';
import type { Notification } from './inbox.ts';
import {
  BUILT_IN_TYPES,
  LOCALES,
  parseOverride,
  render,
  resolveType,
  type ResolvedType,
  type TypeOverride,
} from './notification-types.ts';
import type { PrincipalSource } from './principals.ts';
import { outboxRecord } from './record.ts';
import type { InboxStore } from './store.ts';
import type { ActingCaller } from './task-actions.ts';

export type RaiseOutcome = 'applied' | 'duplicate' | 'skipped';

export interface PipelineOptions {
  store: InboxStore;
  /** A recipient's compiled policy, from IAM — undefined for someone with none. Required. */
  policyFor: (userId: string) => Promise<EffectivePolicy | undefined> | EffectivePolicy | undefined;
  /** For mentions: whether the mentioned person is in a group the message is to. */
  principals?: PrincipalSource;
  /** A person's own choice for a type (EP-25.6); absent, the type's default holds. */
  wants?: (channelId: string, userId: string, type: ResolvedType) => Promise<boolean>;
  now?: () => Date;
}

/** `@` and a user id (a ULID) — how a message names someone it means. */
const MENTION = /@([0-9A-HJKMNP-TV-Z]{26})\b/g;

export class NotificationPipeline {
  private readonly store: InboxStore;
  private readonly policyFor: PipelineOptions['policyFor'];
  private readonly principals: PrincipalSource | undefined;
  private readonly wants: NonNullable<PipelineOptions['wants']>;
  private readonly now: () => Date;

  constructor(options: PipelineOptions) {
    this.store = options.store;
    this.policyFor = options.policyFor;
    this.principals = options.principals;
    this.wants = options.wants ?? (async (_c, _u, type) => type.mandatory || type.defaultOn);
    this.now = options.now ?? (() => new Date());
  }

  // --- the registry, as a channel has it ---------------------------------------------------------

  /** Every type, as it applies in the channel — any authenticated caller (preferences read it). */
  async types(channelId: string): Promise<ResolvedType[]> {
    const overrides = new Map(
      (await this.store.typeOverrides(channelId)).map((o) => [o.key, o] as const),
    );
    return Object.values(BUILT_IN_TYPES).map((b) => resolveType(b, overrides.get(b.key)));
  }

  async type(channelId: string, key: string): Promise<ResolvedType | undefined> {
    return (await this.types(channelId)).find((t) => t.key === key);
  }

  /**
   * An operator's change to one type in their channel — `config:admin` there (the registry is
   * configuration, as transcode profiles are), a compare-and-set on the override's `version` (0 for
   * the first), audited.
   */
  async putType(
    caller: ActingCaller,
    key: string,
    ifVersion: number,
    body: Record<string, unknown>,
  ): Promise<ResolvedType> {
    const decision = canEnforce(caller.policy, 'config:admin', { channelId: caller.channelId });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? 'missing config:admin');
    const fields = parseOverride(key, body);
    const before = (await this.store.typeOverrides(caller.channelId)).find((o) => o.key === key);
    if ((before?.version ?? 0) !== ifVersion)
      throw new Conflict(
        `notification type ${key} is at version ${before?.version ?? 0}, not ${ifVersion}`,
      );
    const after: TypeOverride = {
      key,
      channelId: caller.channelId,
      ...fields,
      version: ifVersion + 1,
      updatedBy: caller.userId,
      updatedAt: this.now().toISOString(),
    };
    const chain = {
      actor: { kind: 'user' as const, id: caller.userId },
      ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
    };
    await this.store.transaction(async (tx) => {
      if (!(await tx.putTypeOverride(after, ifVersion)))
        throw new Conflict(`notification type ${key} changed under you — read it again`);
      await tx.enqueue(
        outboxRecord(
          'audit.recorded',
          caller.channelId,
          {
            entityType: 'notification-type',
            entityId: `${caller.channelId}:${key}`,
            revision: after.version,
            action: 'notification-type.updated',
            origin: { service: 'notifications' },
            delta: delta(before ? { ...before } : undefined, { ...after }),
          } satisfies EventPayloads['audit.recorded'],
          chain,
        ),
      );
    });
    return resolveType(BUILT_IN_TYPES[key]!, after);
  }

  // --- consumers ---------------------------------------------------------------------------------

  async consumeAssetApproved(msg: BrokerMessage): Promise<RaiseOutcome> {
    const e = this.envelopeOf<EventPayloads['asset.approved']>(msg, 'asset.approved');
    const p = e.payload;
    if (p.automatic === true || p.createdBy === undefined) return 'skipped'; // nobody asked
    return this.raise(
      msg,
      e,
      'asset.approved',
      [p.createdBy],
      assetRef(p.assetId),
      assetRead(e.channelId, p),
      {
        approver: p.approver,
      },
    );
  }

  async consumeAssetRejected(msg: BrokerMessage): Promise<RaiseOutcome> {
    const e = this.envelopeOf<EventPayloads['asset.rejected']>(msg, 'asset.rejected');
    const p = e.payload;
    if (p.createdBy === undefined) return 'skipped';
    return this.raise(
      msg,
      e,
      'asset.rejected',
      [p.createdBy],
      assetRef(p.assetId),
      assetRead(e.channelId, p),
      {
        reason: p.reason,
        ...(p.rejectedBy !== undefined ? { rejectedBy: p.rejectedBy } : {}),
      },
    );
  }

  async consumeAssetExpired(msg: BrokerMessage): Promise<RaiseOutcome> {
    const e = this.envelopeOf<EventPayloads['asset.expired']>(msg, 'asset.expired');
    const p = e.payload;
    if (p.priorApprover === undefined) return 'skipped'; // nobody to tell
    return this.raise(
      msg,
      e,
      'asset.re-review-due',
      [p.priorApprover],
      assetRef(p.assetId),
      assetRead(e.channelId, p),
      {},
    );
  }

  async consumeTranscodeFailed(msg: BrokerMessage): Promise<RaiseOutcome> {
    const e = this.envelopeOf<EventPayloads['transcode.failed']>(msg, 'transcode.failed');
    const p = e.payload;
    if (p.requestedBy === undefined) return 'skipped';
    // MTS does not know the asset's category: a reader narrowed to categories is not told, which is
    // the strict check failing closed rather than a reader told about an asset they cannot open.
    return this.raise(
      msg,
      e,
      'transcode.failed',
      [p.requestedBy],
      assetRef(p.assetId),
      { permission: 'asset:read', resource: { channelId: e.channelId, type: 'asset' } },
      { error: p.error.message },
    );
  }

  /** `@<userId>` in a message → that person, when the message is theirs to read. */
  async consumeMessageSent(msg: BrokerMessage): Promise<RaiseOutcome> {
    const e = this.envelopeOf<EventPayloads['message.sent']>(msg, 'message.sent');
    const p = e.payload;
    const mentioned = new Set([...p.body.matchAll(MENTION)].map((m) => m[1]!));
    mentioned.delete(p.from);
    if (mentioned.size === 0) return 'skipped';
    const readers: string[] = [];
    for (const userId of mentioned) if (await this.readsMessage(userId, p.to)) readers.push(userId);
    if (readers.length === 0) return 'skipped';
    return this.raise(
      msg,
      e,
      'message.mention',
      readers,
      { entityType: 'message', entityId: p.id },
      undefined,
      {
        from: p.from,
      },
    );
  }

  // --- the one write -----------------------------------------------------------------------------

  private async raise(
    msg: BrokerMessage,
    envelope: Pick<Envelope, 'channelId' | 'messageId' | 'correlationId'>,
    key: string,
    recipients: string[],
    subjectRef: EntityRef,
    read: { permission: string; resource: ResourceContext } | undefined,
    vars: Record<string, string | undefined>,
  ): Promise<RaiseOutcome> {
    const type = await this.type(envelope.channelId, key);
    if (!type?.enabled) return 'skipped';
    const titles = Object.fromEntries(LOCALES.map((l) => [l, render(type.title[l], vars)]));
    const at = this.now().toISOString();
    const notifications: Notification[] = [];
    for (const userId of new Set(recipients)) {
      const policy = await this.policyFor(userId);
      if (!policy) continue; // a service, or someone IAM no longer has
      if (read && !canEnforce(policy, read.permission, read.resource).allowed) continue;
      if (!type.mandatory && !(await this.wants(envelope.channelId, userId, type))) continue;
      notifications.push({
        id: ulid(),
        channelId: envelope.channelId,
        userId,
        type: key,
        severity: type.severity,
        subjectRef,
        title: titles['en']!,
        titles,
        read: false,
        createdAt: at,
      });
    }
    if (notifications.length === 0) return 'skipped';
    let outcome: RaiseOutcome = 'applied';
    await this.store.transaction(async (tx) => {
      if (!(await tx.markSeen(msg.id))) {
        outcome = 'duplicate';
        return;
      }
      for (const n of notifications) {
        await tx.insertNotification(n);
        await tx.enqueue(
          outboxRecord(
            'notification.raised',
            n.channelId,
            {
              id: n.id,
              userId: n.userId,
              type: n.type,
              severity: n.severity,
              ...(n.subjectRef !== undefined ? { subjectRef: n.subjectRef } : {}),
              ...(n.title !== undefined ? { title: n.title } : {}),
              createdAt: n.createdAt,
            } satisfies EventPayloads['notification.raised'],
            {
              actor: { kind: 'service', id: 'notifications' },
              correlationId: envelope.correlationId ?? envelope.messageId,
              causationId: envelope.messageId,
            },
          ),
        );
      }
    });
    return outcome;
  }

  /** Is the message theirs to read — to them by name, or to a group they are in now? */
  private async readsMessage(
    userId: string,
    to: EventPayloads['message.sent']['to'],
  ): Promise<boolean> {
    if (to.some((r) => r.kind === 'user' && r.id === userId)) return true;
    const groups = to.filter((r) => r.kind === 'group').map((r) => r.id);
    if (groups.length === 0 || !this.principals) return false;
    // IAM away: thrown to the broker, which redelivers — a mention is not dropped for an outage.
    const theirs = await this.principals.principalsOf(userId);
    return theirs.some((p) => p.kind === 'group' && groups.includes(p.id));
  }

  private envelopeOf<P extends object>(msg: BrokerMessage, type: string): Envelope<P> {
    const shape = envelopeShapeErrors(msg.body);
    if (!shape.valid)
      throw new ValidationError(`message ${msg.id} on ${msg.subject} is not an envelope`);
    const envelope = msg.body as Envelope;
    if (envelope.type !== type)
      throw new ValidationError(`message ${msg.id} is a ${envelope.type}, not a ${type}`);
    const payload = validatePayload(type, envelope.payload);
    if (!payload.valid)
      throw new ValidationError(
        `message ${msg.id} payload does not match ${type}: ${payload.errors
          .map((x) => `${x.path} ${x.message}`)
          .join('; ')}`,
      );
    return envelope as Envelope<P>;
  }
}

const assetRef = (assetId: string): EntityRef => ({ entityType: 'asset', entityId: assetId });

/** Read the asset as MAM would let them: in its category, owned by its creator. */
function assetRead(
  channelId: string,
  p: { categoryPath?: string; createdBy?: string },
): { permission: string; resource: ResourceContext } {
  return {
    permission: 'asset:read',
    resource: {
      channelId,
      type: 'asset',
      ...(p.categoryPath !== undefined ? { categoryPath: p.categoryPath } : {}),
      ...(p.createdBy !== undefined ? { ownerId: p.createdBy } : {}),
    },
  };
}
