// How an event meets a step waiting for it (EP-22.6/22.7; bms.md §13f) — one set of rules for both
// ways it can happen: the router delivering an event as it arrives, and a step that starts waiting
// taking an event already buffered (decided 2026-10-17). What a review step receives, and the
// `workflow.task.resolved` that closes its task, are built here for the same reason.

import type { Envelope, EventPayloads } from '@atlas/contracts';
import { REVIEW_VERDICTS } from '@atlas/contracts/workflow';
import type { EventAwait } from './instance.ts';
import { outboxRecord } from './record.ts';
import type { WorkflowStore } from './store.ts';

/** Every key equal, and — for a review — the verdict naming this point or none. */
export function matches(awaited: EventAwait, payload: Record<string, unknown>): boolean {
  for (const [path, value] of Object.entries(awaited.match))
    if (!sameValue(valueAt(payload, path), value)) return false;
  if (awaited.reviewPointId === undefined) return true;
  const named = payload['reviewPointId'];
  return named === undefined || named === awaited.reviewPointId;
}

function valueAt(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** FEEL's `=` over JSON values — but a key that evaluated to null never matches anything. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The verdict a review await turns an event into, or undefined for a plain wait. */
export function verdictOf(
  awaited: EventAwait,
  eventType: string,
  payload: Record<string, unknown>,
): { outcome: string; by?: string; reviewPointId?: string } | undefined {
  if (awaited.reviewPointId === undefined) return undefined;
  const verdict = REVIEW_VERDICTS[eventType];
  if (!verdict) return undefined;
  const by = payload[verdict.by];
  const point = payload['reviewPointId'];
  return {
    outcome: verdict.outcome,
    ...(typeof by === 'string' ? { by } : {}),
    ...(typeof point === 'string' ? { reviewPointId: point } : {}),
  };
}

/** What the waiting step receives as `incoming`: the event, or — for a review — its verdict. */
export function signalPayload(
  awaited: EventAwait,
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const verdict = verdictOf(awaited, eventType, payload);
  if (!verdict) return payload;
  const assetId = payload['assetId'];
  return {
    ...verdict,
    taskId: awaited.correlationId,
    ...(typeof assetId === 'string' ? { assetId } : {}),
    ...(typeof payload['reason'] === 'string' ? { reason: payload['reason'] } : {}),
    ...(typeof payload['expiresAt'] === 'string' ? { expiresAt: payload['expiresAt'] } : {}),
  };
}

/** The review's task closed with its verdict — Notifications applies it. */
export function taskResolved(
  awaited: EventAwait,
  verdict: { outcome: string; by?: string; reviewPointId?: string },
  cause: { messageId: string; correlationId?: string; assetId?: string },
  at: string,
): ReturnType<typeof outboxRecord> {
  return outboxRecord(
    'workflow.task.resolved',
    awaited.channelId,
    {
      taskId: awaited.correlationId,
      workflowInstanceId: awaited.instanceId,
      outcome: verdict.outcome,
      ...(verdict.by !== undefined ? { by: verdict.by } : {}),
      ...(cause.assetId !== undefined ? { assetId: cause.assetId } : {}),
      ...(verdict.reviewPointId !== undefined ? { reviewPointId: verdict.reviewPointId } : {}),
      at,
    } satisfies EventPayloads['workflow.task.resolved'],
    {
      actor: { kind: 'service', id: 'bms' },
      correlationId: cause.correlationId ?? cause.messageId,
      causationId: cause.messageId,
    },
  );
}

/**
 * Answer an event await with this event — once: `false` when another event, or another delivery,
 * got there first. A review's answer also answers its task's await and closes the task — even for an
 * instance that has ended, since the verdict was given all the same.
 */
export async function answerWith(
  store: WorkflowStore,
  awaited: EventAwait,
  event: Pick<Envelope, 'type' | 'messageId' | 'correlationId' | 'payload'>,
  at: string,
): Promise<boolean> {
  return store.transaction(async (tx) => {
    if (!(await tx.answerEventAwaits(awaited.correlationId, at, event.messageId))) return false;
    const verdict = verdictOf(awaited, event.type, event.payload);
    if (verdict === undefined) return true;
    // Notifications' `done` for the task is then a duplicate here.
    await tx.answerAwait(awaited.correlationId, at, event.messageId);
    const assetId = event.payload['assetId'];
    await tx.enqueue(
      taskResolved(
        awaited,
        verdict,
        {
          messageId: event.messageId,
          ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
          ...(typeof assetId === 'string' ? { assetId } : {}),
        },
        at,
      ),
    );
    return true;
  });
}
