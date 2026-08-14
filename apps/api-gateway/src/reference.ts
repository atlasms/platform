// `GET /reference` — one snapshot from many services (EP-08.5).
//
// Design: [configuration-and-reference-data.md §5](../../../docs/architecture/configuration-and-reference-data.md)
// step 2 — "the BFF aggregates them into one snapshot with a combined configVersion + ETag; Studio
// and services cache it and revalidate cheaply."
//
// Each owning service serves its OWN reference data (EP-04.8). This fans out, merges, and hands
// back a single document, so Studio holds one snapshot rather than one per service and revalidates
// once rather than N times.

import type { Versioned } from '@atlas/service-kit';

/** A service that owns reference data, and where to ask it. */
export interface ReferenceSource {
  /** Service name. Becomes the key its data is filed under. */
  service: string;
  /** Absolute URL of that service's snapshot endpoint. */
  url: string;
}

export interface AggregatedSnapshot extends Versioned {
  /**
   * The SUM of the contributing versions.
   *
   * Monotonic because every contributor is monotonic — and collision-free for the same reason: two
   * different combinations can only share a sum if one contributor went DOWN, which a persisted
   * counter never does. That is why EP-04.8 persists MAM's rather than keeping it in memory; a
   * counter that resets on restart would make this number reusable, and a reused version is a false
   * 304 that serves a stale vocabulary.
   */
  configVersion: number;
  /** Each contributor's own version, so an operator can see WHICH service moved. */
  sources: Record<string, number>;
  /** Everything the services returned, filed under the service that owns it. */
  services: Record<string, unknown>;
}

export interface AggregateOptions {
  sources: readonly ReferenceSource[];
  fetchImpl?: typeof fetch;
  /** Forwarded so the upstreams see the same request identity and correlation. */
  headers?: Record<string, string>;
}

/**
 * Thrown when a contributor cannot be reached, rather than returning what did answer.
 *
 * **A partial snapshot is the dangerous outcome**, and it is worth being explicit about why. The
 * snapshot is what validation reads (§5 step 4), so one missing service does not degrade the answer
 * — it changes it: "is this a known classification?" starts returning NO for every term that
 * service owned, and writes get rejected as invalid.
 *
 * A client cannot tell a partial snapshot from a complete one. It CAN tell a failure from a
 * success, and `SnapshotClient` already keeps the last good snapshot when a refresh fails — which
 * is exactly FR-PLat-7's "a stale snapshot keeps the system fully operational". So failing loudly
 * hands the situation to the one component equipped to handle it.
 */
export class ReferenceUnavailable extends Error {
  readonly service: string;
  constructor(service: string, cause: string) {
    super(`reference source "${service}" is unavailable: ${cause}`);
    this.service = service;
    this.name = 'ReferenceUnavailable';
  }
}

export async function aggregateReference(options: AggregateOptions): Promise<AggregatedSnapshot> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  // In parallel: the fan-out is the whole cost, and doing it in series would multiply the slowest
  // upstream by the number of services.
  const results = await Promise.all(
    options.sources.map(async (source) => {
      let response: Response;
      try {
        response = await doFetch(source.url, { headers: options.headers ?? {} });
      } catch (err) {
        throw new ReferenceUnavailable(source.service, (err as Error).message);
      }
      if (!response.ok) {
        throw new ReferenceUnavailable(source.service, `HTTP ${response.status}`);
      }

      const body = (await response.json()) as Partial<Versioned> & Record<string, unknown>;
      if (typeof body.configVersion !== 'number') {
        // A source that cannot say what version it is at cannot participate in a shared ETag: the
        // aggregate would appear unchanged while that service's data moved underneath it.
        throw new ReferenceUnavailable(source.service, 'no configVersion in the response');
      }
      return { source, body, version: body.configVersion };
    }),
  );

  const sources: Record<string, number> = {};
  const services: Record<string, unknown> = {};
  let configVersion = 0;

  // Sorted by service name so the document is byte-stable across runs: `Promise.all` preserves
  // input order, but the SOURCE list is configuration and a reordering there should not look like
  // a content change to anything comparing bodies.
  for (const { source, body, version } of [...results].sort((a, b) =>
    a.source.service.localeCompare(b.source.service),
  )) {
    sources[source.service] = version;
    services[source.service] = body;
    configVersion += version;
  }

  return { configVersion, sources, services };
}
