import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type {
  SettingLevel,
  SettingView,
  SettingsView,
  SettingWriteInput,
} from './generated/mam.types.ts';
import { MamOperations as ops } from './generated/mam.operations.ts';

/**
 * Every service that owns Tier-3 settings, and its three operations (EP-33.2): each serves its own
 * `/settings/<area>`. A new owner adds a row here when its contract declares the routes.
 */
const AREAS = {
  mam: { get: ops.getMamSettings, put: ops.putMamSetting, reset: ops.resetMamSetting },
} as const;
export type SettingsArea = keyof typeof AREAS;
export const SETTINGS_AREAS = Object.keys(AREAS) as SettingsArea[];

/**
 * Settings through the gateway (EP-33.3; configuration-and-reference-data.md §2.4, §11). A write
 * and a reset are compare-and-set on the level's version — a 409 is a reload, never a retry.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly api = inject(ApiClient);

  list(area: SettingsArea) {
    return this.api.call(AREAS[area].get, {}).as<SettingsView>();
  }

  put(area: SettingsArea, key: string, input: SettingWriteInput, version?: number) {
    return this.api
      .call(AREAS[area].put, {
        params: { key },
        ...(version !== undefined ? { query: { version } } : {}),
        body: input,
      })
      .as<SettingView>();
  }

  reset(area: SettingsArea, key: string, level: SettingLevel, version?: number) {
    return this.api
      .call(AREAS[area].reset, {
        params: { key },
        query: { level, ...(version !== undefined ? { version } : {}) },
      })
      .as<SettingView>();
  }
}
