import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { Watcher, WatcherInput } from './generated/rim.types.ts';
import { RimOperations as ops } from './generated/rim.operations.ts';

/**
 * RIM's folder watchers, through the gateway (EP-15.2). A watcher is a folder under the channel's
 * own directory of RIM's watch root; a file that has settled there becomes an ingest job, exactly
 * as an upload does. `ingest:admin` for all of it. Disabled, never deleted — jobs name their
 * watcher as source — so there is no delete here.
 *
 * RIM refuses a watcher that could never run with a 422 naming each reason (a path out of the
 * channel's directory, symlinks included) and two enabled watchers on one folder with a 409.
 */
@Injectable({ providedIn: 'root' })
export class WatchersService {
  private readonly api = inject(ApiClient);

  list() {
    return this.api.call(ops.listWatchers).as<Watcher[]>();
  }

  get(id: string) {
    return this.api.call(ops.getWatcher, { params: { id } }).as<Watcher>();
  }

  create(input: WatcherInput) {
    return this.api.call(ops.createWatcher, { body: input }).as<Watcher>();
  }

  /** The whole watcher, as given — RIM replaces it and bumps `version`. */
  replace(id: string, input: WatcherInput) {
    return this.api.call(ops.replaceWatcher, { params: { id }, body: input }).as<Watcher>();
  }
}
