// A behaviour suite every IamStore must pass — sqlite in tests, Postgres in production.
//
// Driven through the service, because the properties that matter are properties of the unit of
// work: a login that records its event AND its token or neither; a refresh token that can be
// rotated exactly once whoever asks; a username that is taken exactly once; a seed that runs on
// every start and changes nothing after the first. The password tests, the lockout policy and the
// token format have their own suites on the double; this is what only a store can get wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Conflict } from '@atlas/service-kit';
import { STARTER_ROLES, seedStarterRoles } from './roles.ts';
import { IamService } from './service.ts';
import type { IamStore } from './store.ts';
import { KeyRing, hashRefreshToken } from './tokens.ts';

export interface IamStoreHarness {
  /** A clean store; `cleanup` drops whatever it created. */
  make: () => Promise<{ store: IamStore; cleanup?: () => Promise<void> }>;
  /**
   * Try to alter a login event by whatever means the adapter's backing store offers — a raw
   * UPDATE. Must throw if append-only holds. The suite cannot reach around the port; the adapter
   * knows how.
   */
  tamper: (store: IamStore, eventId: string) => Promise<void>;
}

const PASSWORD = 'correct horse battery';

export function iamStoreConformance(name: string, harness: IamStoreHarness): void {
  async function withService(
    fn: (service: IamService, store: IamStore) => Promise<void>,
    options: { now?: () => number; lockout?: { threshold: number } } = {},
  ): Promise<void> {
    const { store, cleanup } = await harness.make();
    try {
      const keyRing = await KeyRing.create('k1');
      const service = new IamService({ keyRing, store, ...options });
      await fn(service, store);
    } finally {
      await cleanup?.();
      await store.close().catch(() => undefined);
    }
  }

  test(`[${name}] a user, a credential and a login event persist, and a username is taken once`, async () => {
    await withService(async (service, store) => {
      const jo = await service.createUser({
        username: 'jo',
        password: PASSWORD,
        channelId: 'ch12',
      });
      assert.deepEqual(await store.user(jo.id), jo);
      assert.equal((await store.credential(jo.id))?.userId, jo.id);
      await assert.rejects(
        service.createUser({ username: 'jo', password: 'x' }),
        (e: unknown) => e instanceof Conflict,
        'the second "jo" is a Conflict, decided by the store',
      );
      assert.equal((await store.users()).length, 1, 'and nothing half-written');

      await service.login('jo', PASSWORD, { ip: '10.0.0.1' });
      const events = await store.loginEvents({ userId: jo.id });
      assert.equal(events[0]?.result, 'success');
      assert.equal(events[0]?.ip, '10.0.0.1');
      assert.equal(
        (await store.user(jo.id))?.lastIp,
        '10.0.0.1',
        'lastIp is written with the event',
      );
    });
  });

  test(`[${name}] a refresh token rotates once: the second holder is a REUSE and the family dies`, async () => {
    await withService(async (service, store) => {
      const jo = await service.createUser({ username: 'jo', password: PASSWORD });
      const first = await service.login('jo', PASSWORD);
      const second = await service.refresh(first.refreshToken);
      assert.notEqual(second.refreshToken, first.refreshToken);

      const rotated = await store.refreshTokenByHash(hashRefreshToken(first.refreshToken));
      assert.ok(rotated?.revokedAt, 'the rotated token is revoked in the store');

      await assert.rejects(service.refresh(first.refreshToken), /reuse detected/);
      const family = await store.family(rotated!.familyId);
      assert.equal(family.length, 2);
      assert.ok(
        family.every((r) => r.revokedAt !== undefined),
        'every token in the family is revoked, the fresh one included',
      );
      await assert.rejects(service.refresh(second.refreshToken), /reuse detected/);
      assert.equal((await store.userTokens(jo.id)).length, 2);
    });
  });

  test(`[${name}] CONCURRENT refreshes with one token: exactly one wins, the other is a reuse`, async () => {
    await withService(async (service) => {
      await service.createUser({ username: 'jo', password: PASSWORD });
      const { refreshToken } = await service.login('jo', PASSWORD);
      const results = await Promise.allSettled([
        service.refresh(refreshToken),
        service.refresh(refreshToken),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      assert.equal(won.length, 1, 'the database let exactly one rotation through');
      assert.equal(lost.length, 1);
      assert.match(String((lost[0] as PromiseRejectedResult).reason), /reuse detected/);
    });
  });

  test(`[${name}] logout revokes the family, or every session; twice is idempotent`, async () => {
    await withService(async (service, store) => {
      const jo = await service.createUser({ username: 'jo', password: PASSWORD });
      const a = await service.login('jo', PASSWORD);
      const b = await service.login('jo', PASSWORD);
      await service.logout(a.refreshToken);
      await service.logout(a.refreshToken);
      const tokens = await store.userTokens(jo.id);
      assert.equal(tokens.filter((t) => t.revokedAt).length, 1, 'only a’s family');
      await assert.rejects(service.refresh(a.refreshToken), /reuse detected/);
      await service.refresh(b.refreshToken);

      await service.logout(b.refreshToken, { allSessions: true });
      assert.ok(
        (await store.userTokens(jo.id)).every((t) => t.revokedAt),
        'every session',
      );
    });
  });

  test(`[${name}] a lockout is a persisted state: the run, the lock and the lift all reach the store`, async () => {
    let clock = Date.parse('2026-09-14T12:00:00.000Z');
    await withService(
      async (service, store) => {
        const jo = await service.createUser({ username: 'jo', password: PASSWORD });
        await assert.rejects(service.login('jo', 'wrong'));
        assert.equal((await store.user(jo.id))?.failedAttempts, 1);
        await assert.rejects(service.login('jo', 'wrong'));
        const locked = await store.user(jo.id);
        assert.equal(locked?.state, 'locked');
        assert.ok(locked?.lockedUntil);
        assert.ok(
          (await store.loginEvents({ userId: jo.id })).some((e) => e.result === 'locked'),
          'the lock transition is in the trail',
        );
        await assert.rejects(service.login('jo', PASSWORD), 'still locked with the right password');

        clock += 16 * 60_000;
        await service.login('jo', PASSWORD);
        const lifted = await store.user(jo.id);
        assert.equal(lifted?.state, 'active');
        assert.equal(lifted?.failedAttempts, undefined, 'the run is cleared with the lift');
      },
      { now: () => clock, lockout: { threshold: 2 } },
    );
  });

  test(`[${name}] the effective policy is the union of the user’s grants and their groups’ roles`, async () => {
    await withService(async (service, store) => {
      await seedStarterRoles(store);
      const jo = await service.createUser({
        username: 'jo',
        password: PASSWORD,
        channelId: 'ch12',
      });
      await store.transaction(async (tx) => {
        await tx.putAssignment({ id: 'a1', userId: jo.id, roleId: 'viewer' });
        await tx.putGroup({ id: 'g-approvers', name: 'Approvers', roleIds: ['approver'] });
        await tx.putMembership({ userId: jo.id, groupId: 'g-approvers' });
      });
      const policy = await service.effectivePolicy(jo.id);
      const permissions = new Set(policy.rules.flatMap((r) => r.permissions));
      assert.ok(permissions.has('asset:read'), 'from the viewer role, assigned directly');
      assert.ok(permissions.has('asset:approve'), 'from the approver role, through the group');
      assert.ok(!permissions.has('asset:write'));

      await store.transaction((tx) =>
        tx.deleteMembership({ userId: jo.id, groupId: 'g-approvers' }),
      );
      const after = await service.effectivePolicy(jo.id);
      assert.ok(!new Set(after.rules.flatMap((r) => r.permissions)).has('asset:approve'));
    });
  });

  test(`[${name}] the starter roles seed once, and never overwrite an operator’s edit`, async () => {
    await withService(async (_service, store) => {
      assert.equal(await seedStarterRoles(store), STARTER_ROLES.length);
      assert.equal(await seedStarterRoles(store), 0, 'a restart adds nothing');
      const editor = (await store.role('editor'))!;
      await store.transaction((tx) => tx.putRole({ ...editor, name: 'Narrowed editor' }));
      assert.equal(await seedStarterRoles(store), 0);
      assert.equal((await store.role('editor'))?.name, 'Narrowed editor');
    });
  });

  test(`[${name}] the login trail is APPEND-ONLY, in the database`, async () => {
    await withService(async (service, store) => {
      await service.createUser({ username: 'jo', password: PASSWORD });
      await assert.rejects(service.login('jo', 'wrong'));
      const [event] = await store.loginEvents({ username: 'jo' });
      assert.ok(event);
      await assert.rejects(harness.tamper(store, event.id), /append-only/);
    });
  });
}
