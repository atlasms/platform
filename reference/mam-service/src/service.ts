import { buildEnvelope, follow, validateMessage, type Envelope } from '../../contracts/src/index.ts';
import { idempotent, InMemorySeenStore, OutboxRelay, type Broker, type Message } from '../../messaging/src/index.ts';
import { createLogger, runWithContext, Internal, NotFound, Conflict, type Logger } from '../../service-kit/src/index.ts';
import { AssetStore } from './store.ts';
import type { Asset, AssetCore } from './asset.ts';

/**
 * MAM vertical slice. Consumes ingest.accepted (-> create) and transcode.completed (-> ready);
 * exposes approve/reject. Built entirely from the foundation libs: contracts (build/validate
 * events), messaging (idempotent consumers + outbox relay), service-kit (logger/correlation/errors).
 */
export class MamService {
  private seen = new InMemorySeenStore();
  private relay: OutboxRelay;
  private log: Logger;

  constructor(private broker: Broker, private store: AssetStore) {
    this.relay = new OutboxRelay(store.outbox, broker);
    this.log = createLogger('mam');
  }

  start(): void {
    this.broker.subscribe('atlas.*.ingest.accepted', idempotent((m) => this.onIngestAccepted(m), this.seen));
    this.broker.subscribe('atlas.*.transcode.completed', idempotent((m) => this.onTranscodeCompleted(m), this.seen));
  }

  /** Flush the outbox to the broker. A background loop does this in production; tests call it. */
  drain(): Promise<number> { return this.relay.drain(); }

  getAsset(id: string): Asset | undefined { return this.store.get(id); }

  private async onIngestAccepted(msg: Message): Promise<void> {
    const env = msg.body as Envelope;
    const { assetId, technicalMetadata, source, path } = env.payload as any;
    await runWithContext({ correlationId: env.correlationId ?? env.messageId }, async () => {
      const core = deriveCore(technicalMetadata, source, path);
      const asset: Asset = { id: assetId, channelId: env.channelId, state: 'processing', core, renditions: [], version: 1 };
      const created = this.checked(follow(env, { type: 'asset.created', channelId: env.channelId, payload: { assetId, core } }));
      await this.store.commit(asset, [created]);
      this.log.info('asset created', { assetId });
    });
  }

  private async onTranscodeCompleted(msg: Message): Promise<void> {
    const env = msg.body as Envelope;
    const { assetId, renditions } = env.payload as any;
    const asset = this.store.get(assetId);
    if (!asset) { this.log.warn('transcode for unknown asset', { assetId }); return; }
    await runWithContext({ correlationId: env.correlationId ?? env.messageId }, async () => {
      const ready = mandatoryPresent(asset.core);
      const updated: Asset = { ...asset, renditions, state: ready ? 'ready' : asset.state, version: asset.version + 1 };
      const events = ready ? [this.checked(follow(env, { type: 'asset.ready', channelId: env.channelId, payload: { assetId } }))] : [];
      await this.store.commit(updated, events);
      this.log.info('asset ready', { assetId, ready });
    });
  }

  async approve(assetId: string, approver: string, opts: { expiresAt?: string; correlationId?: string } = {}): Promise<Asset> {
    const asset = this.require(assetId);
    if (asset.state !== 'ready' && asset.state !== 'expired') throw new Conflict(`cannot approve from state "${asset.state}"`);
    const updated: Asset = { ...asset, state: 'approved', expiresAt: opts.expiresAt, version: asset.version + 1 };
    const env = this.checked(buildEnvelope({
      type: 'asset.approved', channelId: asset.channelId, correlationId: opts.correlationId, actor: { kind: 'user', id: approver },
      payload: { assetId, approver, approvedAt: new Date().toISOString(), ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) },
    }));
    await this.store.commit(updated, [env]);
    return updated;
  }

  /** The review-lifecycle scheduler transition Approved -> Expired (MAM's internal scheduler, FR-APP-7). */
  async expire(assetId: string, opts: { priorApprover?: string } = {}): Promise<Asset> {
    const asset = this.require(assetId);
    if (asset.state !== 'approved') throw new Conflict(`cannot expire from state "${asset.state}"`);
    const updated: Asset = { ...asset, state: 'expired', version: asset.version + 1 };
    const env = this.checked(buildEnvelope({
      type: 'asset.expired', channelId: asset.channelId,
      payload: { assetId, expiredAt: asset.expiresAt ?? new Date().toISOString(), ...(opts.priorApprover ? { priorApprover: opts.priorApprover } : {}) },
    }));
    await this.store.commit(updated, [env]);
    return updated;
  }

  async reject(assetId: string, reason: string, opts: { rejectedBy?: string; retainUntil?: string } = {}): Promise<Asset> {
    const asset = this.require(assetId);
    const updated: Asset = { ...asset, state: 'rejected', retainUntil: opts.retainUntil, version: asset.version + 1 };
    const env = this.checked(buildEnvelope({
      type: 'asset.rejected', channelId: asset.channelId,
      payload: { assetId, reason, ...(opts.rejectedBy ? { rejectedBy: opts.rejectedBy } : {}), ...(opts.retainUntil ? { retainUntil: opts.retainUntil } : {}) },
    }));
    await this.store.commit(updated, [env]);
    return updated;
  }

  /** Validate every outgoing event against its contract before it can be committed. */
  private checked(env: Envelope): Envelope {
    const res = validateMessage(env);
    if (!res.valid) throw new Internal(`invalid outgoing ${env.type}: ${JSON.stringify(res.errors)}`);
    return env;
  }
  private require(id: string): Asset { const a = this.store.get(id); if (!a) throw new NotFound(`asset ${id}`); return a; }
}

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function deriveCore(tech: any, source?: string, path?: string): AssetCore {
  return clean({
    title: (path?.split('/').pop() || source || 'Untitled'),
    fileType: tech?.container ?? 'unknown',
    durationSec: tech?.durationSec,
    resolution: tech?.width && tech?.height ? `${tech.width}x${tech.height}` : undefined,
    aspectRatio: tech?.aspectRatio,
    audioChannels: tech?.audioChannels,
  }) as AssetCore;
}

const mandatoryPresent = (core: AssetCore): boolean => !!(core.title && core.fileType);
