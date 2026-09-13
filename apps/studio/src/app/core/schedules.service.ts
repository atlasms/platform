import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type {
  CreateSchedule,
  Schedule,
  ScheduleItem,
  ScheduleItemInput,
  SchedulePage,
  ScheduleWithItems,
} from './generated/scheduling.types.ts';
import { SchedulingOperations as ops } from './generated/scheduling.operations.ts';

/**
 * Scheduling, through the gateway (EP-20.5). Types and operations come from `generated/` —
 * projected from `docs/architecture/openapi/scheduling.yaml`.
 *
 * The one write the editor uses is `replaceItems`: the whole reel, as the editor holds it. The
 * service stores what it is given (its write path is thin — data-model §3.4); the arrangement is
 * this app's responsibility, in `editors/reel.model.ts`.
 */
@Injectable({ providedIn: 'root' })
export class SchedulesService {
  private readonly api = inject(ApiClient);

  /** The channel's program tables, newest day first; `broadcastDate` narrows to one day. */
  list(options: { broadcastDate?: string; after?: string; limit?: number } = {}) {
    return this.api.call(ops.listSchedules, { query: { ...options } }).as<SchedulePage>();
  }

  create(body: CreateSchedule) {
    return this.api.call(ops.createSchedule, { body }).as<Schedule>();
  }

  /** The header with its reel, in reel order. */
  get(id: string) {
    return this.api.call(ops.getSchedule, { params: { id } }).as<ScheduleWithItems>();
  }

  /** The editor's save: the reel as given, ids kept where sent. Returns the reel as stored. */
  replaceItems(id: string, items: ScheduleItemInput[]) {
    return this.api
      .call(ops.replaceScheduleItems, { params: { id }, body: items })
      .as<ScheduleItem[]>();
  }
}
