// Workflows started by an EVENT (EP-22.7; bms.md §13g, decided 2026-10-17): a start step whose
// `trigger.event` is one of WORKFLOW_TRIGGERS — today `ingest.accepted` — starts an instance of every
// ACTIVE workflow of the event's channel that names it, once per event, when its `trigger.filter`
// (FEEL over `incoming`, the event's payload) is true.
//
// The instance runs as BMS (`startedBy: bms`, `triggeredBy` naming the event and the message) on its
// publisher's authority — the same vouching a person's start relies on (bms.md §13d): whoever
// published or activated the workflow held what its commands require. The event is the start step's
// `incoming`; `trigger.output` maps it into vars; its `assetId`, when it has one, is the instance's.
//
// Idempotent without a seen-mark: the instance id is DERIVED from the message and the workflow, so a
// redelivery inserts nothing and only asks the runtime again — which starts an instance once per id
// (Temporal's workflow id). The runtime away is thrown to the broker, which redelivers: the row is
// written, the start is not, and the next delivery starts it.

import { envelopeShapeErrors, type Envelope } from '@atlas/contracts';
import { WORKFLOW_TRIGGERS, type StartConfig } from '@atlas/contracts/workflow';
import type { Message } from '@atlas/messaging';
import { Unavailable, ValidationError } from '@atlas/service-kit';
import { feelEval } from './engine/feel-eval.ts';
import { derivedUlid } from './ids.ts';
import { isTerminal, type Instance } from './instance.ts';
import type { InstanceRunner } from './runner.ts';
import { instanceAudit } from './runtime.ts';
import type { BmsService } from './service.ts';
import type { WorkflowStore } from './store.ts';

const SELF = { kind: 'service' as const, id: 'bms' };

export interface TriggerOutcome {
  /** Instances started (or asked again, on a redelivery) — by id. */
  started: string[];
  /** Workflows that name the event but whose filter said no. */
  filtered: string[];
}

export interface TriggerStarterOptions {
  store: WorkflowStore;
  service: BmsService;
  runner?: InstanceRunner;
  now?: () => Date;
}

export class TriggerStarter {
  private readonly store: WorkflowStore;
  private readonly service: BmsService;
  private readonly runner: InstanceRunner | undefined;
  private readonly now: () => Date;

  constructor(options: TriggerStarterOptions) {
    this.store = options.store;
    this.service = options.service;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date());
  }

  async handle(msg: Message): Promise<TriggerOutcome> {
    const shape = envelopeShapeErrors(msg.body);
    if (!shape.valid)
      throw new ValidationError(`message ${msg.id} on ${msg.subject} is not an envelope`);
    const envelope = msg.body as Envelope;
    const outcome: TriggerOutcome = { started: [], filtered: [] };
    if (!WORKFLOW_TRIGGERS.includes(envelope.type)) return outcome;
    const incoming = envelope.payload;
    const { items } = await this.service.catalog({ channelId: envelope.channelId });
    for (const entry of items) {
      const trigger = startOf(entry.definition)?.trigger;
      if (trigger?.event !== envelope.type) continue;
      if (trigger.filter !== undefined && !passes(trigger.filter, incoming)) {
        outcome.filtered.push(entry.id);
        continue;
      }
      if (!this.runner) throw new Unavailable('the workflow runtime is not configured');
      const assetId = typeof incoming['assetId'] === 'string' ? incoming['assetId'] : undefined;
      const instance: Instance = {
        id: derivedUlid(
          Date.parse(envelope.occurredAt),
          `trigger:${envelope.messageId}:${entry.id}`,
        ),
        channelId: envelope.channelId,
        workflowId: entry.id,
        version: entry.version,
        ...(assetId !== undefined ? { assetId } : {}),
        state: 'running',
        currentSteps: [],
        startedAt: this.now().toISOString(),
        startedBy: SELF.id,
        triggeredBy: { event: envelope.type, messageId: envelope.messageId },
      };
      const known = await this.store.transaction(async (tx) => {
        // The header's lock, as a person's start takes it (EP-22.11): never an instance of a
        // workflow deactivated meanwhile.
        const locked = await tx.workflowForUpdate(entry.id);
        if (locked?.state !== 'active') return undefined;
        if (await tx.insertInstance(instance)) {
          await tx.enqueue(
            instanceAudit(instance, 1, 'workflow-instance.started', undefined, SELF),
          );
          return instance;
        }
        return tx.instanceForUpdate(instance.id); // a redelivery: the row as it stands
      });
      if (!known || isTerminal(known.state)) continue;
      await this.runner.start({
        definition: entry.definition,
        start: { instanceId: known.id, incoming, triggered: true },
      });
      outcome.started.push(known.id);
    }
    return outcome;
  }
}

function startOf(def: { steps: { kind: string; config?: unknown }[] }): StartConfig | undefined {
  return def.steps.find((s) => s.kind === 'start')?.config as StartConfig | undefined;
}

/** A filter that cannot be evaluated starts nothing — as a branch's condition takes no edge. */
function passes(filter: string, incoming: Record<string, unknown>): boolean {
  try {
    const v = feelEval(filter, { vars: {}, incoming, steps: {}, instance: { id: '' } });
    return v !== null && v !== undefined && v !== false;
  } catch {
    return false;
  }
}

/** Every channel's triggering events — one durable per type. */
export const triggerPatterns = (): string[] => WORKFLOW_TRIGGERS.map((t) => `atlas.*.${t}`);
