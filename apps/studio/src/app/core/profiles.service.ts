import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { Profile, ProfileInput } from './generated/mts.types.ts';
import { MtsOperations as ops } from './generated/mts.operations.ts';

/** Which registry a profile lives in: the signed-in channel's, or the platform-wide one. */
export type ProfileScope = 'channel' | 'platform';

/**
 * MTS's transcode profile registry, through the gateway (EP-16.6). A profile is a STRUCTURED
 * target that MTS compiles to FFmpeg arguments — there are no raw arguments to edit, by design.
 * A job's preset id resolves to the channel's enabled profile, then the platform's, then the
 * built-in, at the moment the job runs.
 *
 * `config:read` to read, `config:admin` to write, scoped by level: a platform-wide profile needs
 * an unscoped grant. MTS refuses a combination FFmpeg would refuse with a 422 naming each rule,
 * and a replace carrying a stale `version` with a 409.
 */
@Injectable({ providedIn: 'root' })
export class ProfilesService {
  private readonly api = inject(ApiClient);

  /** The channel's profiles and the platform-wide ones, enabled or not. */
  list() {
    return this.api.call(ops.listProfiles).as<Profile[]>();
  }

  get(id: string, scope: ProfileScope) {
    return this.api.call(ops.getProfile, { params: { id }, query: { scope } }).as<Profile>();
  }

  /** `channelId: null` in the body makes it platform-wide; omitted, it is the caller's channel. */
  create(input: ProfileInput) {
    return this.api.call(ops.createProfile, { body: input }).as<Profile>();
  }

  /** A compare-and-set on `version`: 409 when someone else wrote it since it was read. */
  replace(id: string, input: ProfileInput & { version: number }, scope: ProfileScope) {
    return this.api
      .call(ops.replaceProfile, { params: { id }, query: { scope }, body: input })
      .as<Profile>();
  }
}
