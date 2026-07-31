// EP-06.4 — the cached snapshot client.
//
// Reference data is read from a VERSIONED SNAPSHOT, never row-by-row per request (design §5).
// That is what makes "is this a known classification?" an in-memory set lookup on every service
// and in the browser — and what keeps an air-gapped site working from stale local state.
//
// Uses global fetch only (browser-safe). No Node built-ins.

import type { RegistryEntry, Resolved, SettingValue } from './types.ts';

export interface ReferenceSnapshot {
  configVersion: number;
  vocabularies?: Record<string, Array<{ id: string; key: string; deprecatedAt?: string | null }>>;
  registries?: Record<string, RegistryEntry[]>;
  settings?: Record<string, Resolved | SettingValue>;
}

export interface SnapshotClientOptions {
  /** Where to GET the snapshot, e.g. "/api/v1/reference". */
  url: string;
  /** Injected so this stays testable and browser-safe; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Caches a reference snapshot and revalidates it cheaply with an ETag.
 *
 * **A stale snapshot keeps the system operable.** If a refresh fails, the previous snapshot is
 * retained and the error surfaced — an unreachable config endpoint must not take a service down
 * ([FR-PLat-7](../../../docs/requirements/05-functional-requirements.md#platform)).
 */
export class SnapshotClient {
  #url: string;
  #fetch: typeof fetch;
  #snapshot: ReferenceSnapshot | undefined;
  #etag: string | undefined;

  constructor(options: SnapshotClientOptions) {
    this.#url = options.url;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** The cached snapshot, or undefined before the first successful load. */
  get current(): ReferenceSnapshot | undefined {
    return this.#snapshot;
  }

  get configVersion(): number | undefined {
    return this.#snapshot?.configVersion;
  }

  /**
   * Fetch, or revalidate with `If-None-Match`.
   * Returns `true` when the snapshot changed, `false` on a 304 or an unchanged version.
   */
  async refresh(): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (this.#etag !== undefined) headers['If-None-Match'] = this.#etag;

    const res = await this.#fetch(this.#url, { headers });

    if (res.status === 304) return false;
    if (!res.ok) {
      throw new Error(`reference snapshot fetch failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as ReferenceSnapshot;
    const etag = res.headers.get('ETag');
    if (etag !== null) this.#etag = etag;

    const changed = body.configVersion !== this.#snapshot?.configVersion;
    this.#snapshot = body;
    return changed;
  }

  /**
   * Handle a `config.changed` event. Refreshes only when the event reports a version NEWER than
   * the cached one, so a fan-out to many replicas does not become a thundering herd of refetches
   * for a version already held.
   */
  async onConfigChanged(event: { configVersion: number }): Promise<boolean> {
    const held = this.#snapshot?.configVersion;
    if (held !== undefined && event.configVersion <= held) return false;
    return this.refresh();
  }

  /** In-memory membership test — the point of holding a snapshot at all. */
  hasVocabularyTerm(vocabulary: string, key: string): boolean {
    const terms = this.#snapshot?.vocabularies?.[vocabulary];
    if (!terms) return false;
    return terms.some((t) => t.key === key && !t.deprecatedAt);
  }

  /** Registry entries for a kind, e.g. every enabled transcode profile. */
  registryEntries(registry: string): RegistryEntry[] {
    return this.#snapshot?.registries?.[registry] ?? [];
  }
}
