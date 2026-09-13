// The OpenSearch client, and the two things every Atlas service that indexes needs from it:
// a readiness answer and an index that exists.
//
// An index here is a DERIVED VIEW. The system of record is Postgres (@atlas/data-pg); what goes
// into OpenSearch is a projection of committed rows, keyed by the row's own id so re-indexing is
// an overwrite and never a duplicate. That is what makes "delete the index and let the projector
// rebuild it" a supported operation rather than a data-loss event — and it is why nothing in this
// package offers a transaction: there is none to offer, and a write that needs one belongs in the
// database that has them.

import { Client } from '@opensearch-project/opensearch';

export type OpenSearchClient = Client;

export interface OpenSearchOptions {
  /** e.g. `http://opensearch:9200`. */
  node: string;
  /** Per request. Short, because a slow index must not hold a request open behind it. */
  requestTimeoutMs?: number;
}

export function openSearch(options: OpenSearchOptions): OpenSearchClient {
  return new Client({
    node: options.node,
    requestTimeout: options.requestTimeoutMs ?? 5_000,
    // The client's own retries would multiply the timeout above: a node that is down would be
    // tried four times before the caller heard about it. Callers that want retry — the projector
    // ticks again anyway — do it on their own schedule.
    maxRetries: 0,
  });
}

/**
 * Health, for a service's readiness registry: true when the cluster answers and is at least
 * yellow — a single-node cluster is never green (its replicas have nowhere to go), so green would
 * mean "never ready in dev".
 *
 * Bounded by the client's request timeout, so it fits a readiness probe; the answer to "is the
 * index up" must arrive faster than the probe's own deadline or it is worse than no answer.
 */
export async function searchHealthy(client: OpenSearchClient): Promise<boolean> {
  try {
    const { body } = await client.cluster.health({ timeout: '2s' });
    return body.status === 'green' || body.status === 'yellow';
  } catch {
    return false;
  }
}

export interface IndexDefinition {
  name: string;
  /** The `mappings` document. Explicit: a dynamically mapped index guesses, and guesses wrong once. */
  mappings: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

/**
 * Create the index if it does not exist. Idempotent, and safe to race: two replicas starting at
 * once both try, one gets `resource_already_exists_exception`, and that is success.
 *
 * Mappings are only ever CREATED here, never updated — a changed mapping is a new index and a
 * rebuild, which is the honest shape of that change; OpenSearch itself refuses most in-place
 * mapping changes for the same reason.
 */
export async function ensureIndex(
  client: OpenSearchClient,
  definition: IndexDefinition,
): Promise<{ created: boolean }> {
  const { body: exists } = await client.indices.exists({ index: definition.name });
  if (exists) return { created: false };
  try {
    await client.indices.create({
      index: definition.name,
      body: {
        mappings: definition.mappings,
        ...(definition.settings ? { settings: definition.settings } : {}),
      },
    });
    return { created: true };
  } catch (err) {
    if (isAlreadyExists(err)) return { created: false };
    throw err;
  }
}

function isAlreadyExists(err: unknown): boolean {
  const body = (err as { meta?: { body?: { error?: { type?: string } } } })?.meta?.body;
  return body?.error?.type === 'resource_already_exists_exception';
}
