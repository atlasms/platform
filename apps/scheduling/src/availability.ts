// Rendition availability (EP-31; scheduling.md §6.2, FR-SCH-2): is the file an item will air
// online, intact and in this channel? HSM is the system of record for where a file's bytes are
// (ADR-0009), so validation ASKS it, at validation time, rather than keeping a copy that could lag.
//
// The question goes over a signed internal call (ADR-0008, widened in ADR-0009 and again here):
// `POST /internal/v1/availability`, signed with a READ key that HSM accepts on that route alone —
// a leaked Scheduling key reads where files are and places, moves or deletes nothing. The answer
// names each file's channel; Scheduling holds it to the schedule's (authority from the resource).
//
// HSM away is not a verdict: the report says `availability` was unchecked, and why is the log's.

import { signInternal, INTERNAL_SIGNATURE_HEADER } from '@atlas/service-kit';

/** What airs when an item names no rendition: the broadcast preset (mts.md, EP-16.3). */
export const DEFAULT_RENDITION = 'broadcast';

export interface RenditionQuery {
  assetId: string;
  kind: string;
}

/** HSM's answer for one rendition (hsm `POST /internal/v1/availability`). */
export interface RenditionState extends RenditionQuery {
  found: boolean;
  channelId?: string;
  tier?: 'online' | 'near-line' | 'offline';
  status?: 'available' | 'restoring' | 'missing' | 'quarantined';
}

/** Where renditions are. Throws when it cannot say — the report then names availability unchecked. */
export interface AvailabilitySource {
  check(queries: readonly RenditionQuery[]): Promise<RenditionState[]>;
}

/** `assetId|kind` — how validation finds an item's answer. */
export const renditionKey = (assetId: string, kind: string): string => `${assetId}|${kind}`;

const PATH = '/internal/v1/availability';
/** HSM's bound on one request (hsm `MAX_AVAILABILITY_QUERIES`). */
const BATCH = 1000;

export function hsmAvailability(options: {
  origin: string;
  /** The first of `hsm-read-keys`: Scheduling signs with it. */
  key: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): AvailabilitySource {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async check(queries) {
      const answers: RenditionState[] = [];
      for (let i = 0; i < queries.length; i += BATCH) {
        const body = JSON.stringify({ files: queries.slice(i, i + BATCH) });
        const res = await doFetch(new URL(PATH, options.origin), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [INTERNAL_SIGNATURE_HEADER]: signInternal(options.key, {
              method: 'POST',
              path: PATH,
              body,
            }),
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HSM availability: ${res.status} ${await res.text()}`);
        const parsed = (await res.json()) as { files?: RenditionState[] };
        if (!Array.isArray(parsed.files)) throw new Error('HSM availability: no files in answer');
        answers.push(...parsed.files);
      }
      return answers;
    },
  };
}

/** For the suites: answers from a table, `undefined` for "found nothing". */
export function fakeAvailability(
  table: Record<string, Omit<RenditionState, 'assetId' | 'kind' | 'found'>>,
): AvailabilitySource & { asked: RenditionQuery[][] } {
  const asked: RenditionQuery[][] = [];
  return {
    asked,
    async check(queries) {
      asked.push([...queries]);
      return queries.map((q) => {
        const hit = table[renditionKey(q.assetId, q.kind)];
        return hit ? { ...q, found: true, ...hit } : { ...q, found: false };
      });
    },
  };
}
