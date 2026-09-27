import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { Capture, Recorder, RecorderInput } from './generated/rim.types.ts';
import { RimOperations as ops } from './generated/rim.operations.ts';

/**
 * RIM's recorders, through the gateway (EP-39; ADR-0007). A recorder records an IP feed inside
 * recording windows, each file a grid slot padded on both sides and captured by two workers taking
 * turns. `ingest:admin`. Disabled, never deleted — the files it made name it.
 *
 * RIM refuses a recorder that could not run with a 422 naming every reason, each starting with its
 * field (`input.url must carry no credential…`, `windows[0].to must be after from…`).
 */
@Injectable({ providedIn: 'root' })
export class RecordersService {
  private readonly api = inject(ApiClient);

  list() {
    return this.api.call(ops.listRecorders).as<Recorder[]>();
  }

  get(id: string) {
    return this.api.call(ops.getRecorder, { params: { id } }).as<Recorder>();
  }

  create(input: RecorderInput) {
    return this.api.call(ops.createRecorder, { body: input }).as<Recorder>();
  }

  /** The whole recorder — RIM replaces it, plans again what has not started, bumps `version`. */
  replace(id: string, input: RecorderInput) {
    return this.api.call(ops.replaceRecorder, { params: { id }, body: input }).as<Recorder>();
  }

  /** Its captures from `from` (RIM's default: six hours ago), oldest first. */
  captures(id: string, from?: string) {
    return this.api
      .call(ops.listRecorderCaptures, { params: { id }, query: { from, limit: 100 } })
      .as<Capture[]>();
  }
}
