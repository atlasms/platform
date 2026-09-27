// A hole in a recording, said out loud (EP-39 slice 2; ADR-0007).
//
// The product owner's rule is that blank intervals are not acceptable, so every capture that ends
// short of its span raises `alert.raised` — in the SAME transaction as the state change, through
// RIM's outbox (the worker writes RIM's schema, so its alerts go out by RIM's relay like any event):
//   - `recording-missed`, CRITICAL: nothing was recorded for a file — no worker took it, the feed
//     sent nothing, or the file was lost with its pod. A real hole.
//   - `recording-partial`, WARNING: a capture was cut (a crash, a lost worker, a drain) and was
//     continued; the gap is the seconds between — small, and still a gap.
// The alert names the recorder as its subject, and the file's span in its message.

import {
  buildEnvelope,
  subjectFor,
  ulid,
  validatePayload,
  type EventPayloads,
} from '@atlas/contracts';
import type { OutboxRecord } from '@atlas/messaging';
import type { Capture } from './capture.ts';

export type RecordingAlertKind = 'recording-missed' | 'recording-partial';

export function recordingAlert(
  capture: Pick<Capture, 'recorderId' | 'channelId' | 'fileStart' | 'fileEnd' | 'part'>,
  kind: RecordingAlertKind,
  reason: string,
  options: { recorderName?: string; now: Date; actor: { kind: 'service'; id: string } },
): OutboxRecord {
  const span = `${capture.fileStart.slice(11, 19)}–${capture.fileEnd.slice(11, 19)} UTC ${capture.fileStart.slice(0, 10)}`;
  const who = options.recorderName ?? `recorder ${capture.recorderId}`;
  const what =
    kind === 'recording-missed'
      ? `${who}: ${span} was NOT recorded`
      : `${who}: ${span} was recorded with a gap (part ${capture.part} was cut short)`;
  const payload = {
    alertId: ulid(),
    source: 'rim',
    kind,
    severity: kind === 'recording-missed' ? 'critical' : 'warning',
    subjectRef: { entityType: 'recorder', entityId: capture.recorderId },
    message: `${what} — ${reason}`.slice(0, 1000),
    raisedAt: options.now.toISOString(),
  } satisfies EventPayloads['alert.raised'];
  const check = validatePayload('alert.raised', payload);
  if (!check.valid) {
    throw new Error(
      `alert.raised does not match its schema: ${check.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
    );
  }
  const envelope = buildEnvelope({
    type: 'alert.raised',
    channelId: capture.channelId,
    payload,
    actor: options.actor,
  });
  return {
    id: envelope.messageId,
    message: {
      id: envelope.messageId,
      subject: subjectFor(capture.channelId, 'alert.raised'),
      body: envelope,
    },
  };
}
