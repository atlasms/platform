// Retention and tiering (EP-19.4; logging-analytics.md §6.3, NFR-CMP-2).
//
// Two tiers, as built: the search index is HOT and Postgres is the record. A channel's policy
// says how many days a record stays hot; the tick removes older documents from the index — the
// browse stays fast over a window that does not grow — and every record stays in Postgres, where
// the chain and the append-only trigger are. A browse that reaches below the hot window falls
// through to the record (`tieredBrowser`), so nothing becomes unreadable by being old, only
// slower. `coldDays` is recorded and not yet acted on: there is no cold tier to move a record to
// until object storage exists (EP-14), and until then "cold" is Postgres and the retention there
// is forever. `legalHold` pauses the tick for the channel.
//
// The tick never removes a channel's newest document: the index is the projector's checkpoint.

import { ValidationError } from '@atlas/service-kit';
import type { AuditIndex } from './index-opensearch.ts';
import type { AuditEvent, AuditStore, LogBrowser, LogFilter, RetentionPolicy } from './store.ts';

export interface RetentionDefaults {
  hotDays: number;
  coldDays: number;
}

export const DEFAULT_HOT_DAYS = 90;
export const DEFAULT_COLD_DAYS = 0;
const MAX_DAYS = 36_500;

export interface RetentionPolicyInput {
  hotDays: number;
  coldDays: number;
  legalHold: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseRetentionPolicyInput(body: unknown): RetentionPolicyInput {
  if (!isRecord(body)) throw new ValidationError('body must be an object');
  const days = (key: string, min: number): number => {
    const v = body[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > MAX_DAYS) {
      throw new ValidationError(`${key} must be an integer between ${min} and ${MAX_DAYS}`);
    }
    return v;
  };
  const hotDays = days('hotDays', 1);
  const coldDays = days('coldDays', 0);
  const legalHold = body['legalHold'] ?? false;
  if (typeof legalHold !== 'boolean') throw new ValidationError('legalHold must be a boolean');
  return { hotDays, coldDays, legalHold };
}

/** The policy in force for a channel: what was set, or the deployment's defaults. */
export function effectivePolicy(
  channelId: string,
  stored: RetentionPolicy | undefined,
  defaults: RetentionDefaults,
): RetentionPolicy {
  return (
    stored ?? {
      channelId,
      hotDays: defaults.hotDays,
      coldDays: defaults.coldDays,
      legalHold: false,
      version: 0,
      updatedAt: '',
      updatedBy: '',
    }
  );
}

/** `now` minus the hot window, as the index compares it. */
export function hotCutoff(policy: Pick<RetentionPolicy, 'hotDays'>, now: Date): string {
  return new Date(now.getTime() - policy.hotDays * 24 * 60 * 60 * 1000).toISOString();
}

export interface RetentionTickOptions {
  store: AuditStore;
  index: AuditIndex;
  defaults: RetentionDefaults;
  now?: () => Date;
}

export interface TrimReport {
  channelId: string;
  /** Documents removed from the hot index; `undefined` when the channel is on legal hold. */
  trimmed: number | undefined;
}

/**
 * One pass over every channel the log knows: trim its hot index to its policy's window, unless
 * it is on legal hold. The head is kept whatever its age (see the header).
 */
export async function retentionTick(options: RetentionTickOptions): Promise<TrimReport[]> {
  const now = (options.now ?? (() => new Date()))();
  const reports: TrimReport[] = [];
  for (const head of await options.store.heads()) {
    const policy = effectivePolicy(
      head.channelId,
      await options.store.retentionPolicy(head.channelId),
      options.defaults,
    );
    if (policy.legalHold) {
      reports.push({ channelId: head.channelId, trimmed: undefined });
      continue;
    }
    const trimmed = await options.index.trim(head.channelId, hotCutoff(policy, now), head.seq);
    reports.push({ channelId: head.channelId, trimmed });
  }
  return reports;
}

export interface Retention {
  tick(): Promise<TrimReport[]>;
  stop(): void;
}

/** The tick on a timer; main.ts starts it alongside the projector when the index is configured. */
export function startRetention(
  options: RetentionTickOptions & {
    intervalMs: number;
    onTrimmed?: (reports: TrimReport[]) => void;
    onError?: (err: unknown) => void;
  },
): Retention {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  const tick = async (): Promise<TrimReport[]> => {
    if (running) return [];
    running = true;
    try {
      const reports = await retentionTick(options);
      if (reports.some((r) => (r.trimmed ?? 0) > 0)) options.onTrimmed?.(reports);
      return reports;
    } catch (err) {
      options.onError?.(err);
      return [];
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(() => void tick(), options.intervalMs);
    }
  };
  timer = setTimeout(() => void tick(), options.intervalMs);
  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * The browse over both tiers: the index first, and when the page it gives is short — the hot
 * window ran out before the page filled — the rest from the record, strictly older than the
 * last hot row so nothing is seen twice. A filter the index answered in full never touches
 * Postgres; one that reaches into the cold tier costs a second query, which is the price of a
 * record that is old rather than gone.
 */
export function tieredBrowser(hot: LogBrowser, record: LogBrowser): LogBrowser {
  return {
    async browse(channelId, filter): Promise<AuditEvent[]> {
      const fromHot = await hot.browse(channelId, filter);
      if (fromHot.length >= filter.limit) return fromHot;
      const last = fromHot[fromHot.length - 1];
      const rest: LogFilter = {
        ...filter,
        limit: filter.limit - fromHot.length,
        ...(last ? { before: last.seq } : {}),
      };
      return [...fromHot, ...(await record.browse(channelId, rest))];
    },
  };
}
