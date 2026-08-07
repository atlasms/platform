// #225 — field-group scoping, which MAM asked for on tags and nowhere else.
//
// The trap this closes: omitting the field group does not fail closed, it fails OPEN. A rule
// declaring `fieldGroups` matches a check that names none, because there is nothing to fail the
// predicate against — so every unasked write was a grant quietly widened to every group, and the
// Editor/Librarian split in the starter roles was decorative.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, type Rule } from '@atlas/policy';
import {
  CORE_FIELD_GROUPS,
  DEFAULT_EXTENDED_GROUP,
  groupsForCoreFields,
  groupsForExtended,
  MamService,
  sqliteAssetStore,
  type Caller,
  type FieldSchema,
} from '../src/index.ts';

const CHANNEL = 'ch12';

/** The starter roles, verbatim from authorization-model.md §9. */
const EDITOR: Rule[] = [
  { id: 'read', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } },
  {
    id: 'write',
    permissions: ['asset:write'],
    scope: { channelIds: [CHANNEL] },
    fieldGroups: ['core', 'taxonomy', 'cast', 'shotlist'],
  },
];

const LIBRARIAN: Rule[] = [
  { id: 'read', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } },
  {
    id: 'write',
    permissions: ['asset:write'],
    scope: { channelIds: [CHANNEL] },
    fieldGroups: ['files', 'rights'],
  },
];

/** No `fieldGroups` at all — §3.1 says that grants every group. */
const UNSCOPED: Rule[] = [
  {
    id: 'r',
    permissions: ['asset:read', 'asset:write', 'taxonomy:admin'],
    scope: { channelIds: [CHANNEL] },
  },
];

function harness() {
  const store = sqliteAssetStore();
  const service = new MamService({ store });
  const caller = (rules: Rule[], userId = 'user-1'): Caller => ({
    userId,
    channelId: CHANNEL,
    policy: compile({ subjectId: userId, permVersion: 1, rules }),
  });
  return { store, service, caller };
}

const NEW_ASSET = { title: 'Clip', mediaType: 'video', fileType: 'mxf' };

// =============================================================================
// The mapping
// =============================================================================

test('the mapping is transcribed from §3.1, not invented', () => {
  assert.equal(CORE_FIELD_GROUPS.title, 'core');
  assert.equal(CORE_FIELD_GROUPS.description, 'core');
  // "taxonomy (category/structure/classification/subjects/tags)" — reclassifying an asset is a
  // different act from retitling it, and a role may allow one and not the other.
  assert.equal(CORE_FIELD_GROUPS.categoryId, 'taxonomy');
  assert.equal(CORE_FIELD_GROUPS.structureId, 'taxonomy');
  // "rights (allowed count, recommended window, expiry)"
  assert.equal(CORE_FIELD_GROUPS.expiresAt, 'rights');
  assert.equal(CORE_FIELD_GROUPS.allowedBroadcastCount, 'rights');
});

test('DANGER — every updatable field is classified', () => {
  // If `pickUpdatable`'s allowlist grows and this map does not, the new field lands in NO group and
  // falls back to the group-less check — which is the permissive path this whole change exists to
  // remove. The two lists must not be able to drift apart quietly.
  const updatable = [
    'title',
    'description',
    'categoryId',
    'structureId',
    'episodeNo',
    'durationSec',
    'allowedBroadcastCount',
    'expiresAt',
  ];
  for (const field of updatable) {
    assert.ok(
      groupsForCoreFields([field]).length === 1,
      `${field} is writable but belongs to no field group`,
    );
  }
});

test('a patch spanning groups reports all of them, sorted and deduplicated', () => {
  assert.deepEqual(groupsForCoreFields(['title', 'description']), ['core']);
  assert.deepEqual(groupsForCoreFields(['title', 'expiresAt', 'categoryId']), [
    'core',
    'rights',
    'taxonomy',
  ]);
  assert.deepEqual(
    groupsForCoreFields(['unknown']),
    [],
    'an unclassified name contributes nothing',
  );
});

test('an extended field defaults to core, and an annotated one does not', () => {
  const fields = [
    { name: 'competition', label: 'C', type: 'string' as const },
    { name: 'window', label: 'W', type: 'string' as const, fieldGroup: 'rights' },
  ];
  assert.deepEqual(groupsForExtended(fields, ['competition']), [DEFAULT_EXTENDED_GROUP]);
  assert.deepEqual(groupsForExtended(fields, ['window']), ['rights']);
  assert.deepEqual(groupsForExtended(fields, ['competition', 'window']), ['core', 'rights']);
  assert.deepEqual(groupsForExtended(fields, ['nope']), [], 'an unknown field contributes nothing');
});

// =============================================================================
// Enforcement
// =============================================================================

test('SECURITY: an Editor may retitle but NOT change the expiry', async () => {
  // The behaviour change. `expiresAt` decides when media stops being usable on air; §3.1 puts it in
  // `rights`, which the Editor role deliberately does not hold.
  const { service, caller } = harness();
  const editor = caller(EDITOR);
  const asset = await service.create(editor, NEW_ASSET);

  assert.equal((await service.update(editor, asset.id, { title: 'Renamed' })).title, 'Renamed');

  await assert.rejects(
    service.update(editor, asset.id, { expiresAt: '2027-01-01T00:00:00.000Z' }),
    /field group "rights"/,
  );
});

test('SECURITY: a Librarian may set the expiry but NOT retitle', async () => {
  // The mirror image, which is what proves the check is reading the group rather than denying
  // everything: the same call the Editor could make is the one the Librarian cannot, and vice versa.
  const { service, caller, store } = harness();
  const asset = await service.create(caller(UNSCOPED), NEW_ASSET);

  const librarian = new MamService({ store });
  const who = caller(LIBRARIAN, 'user-2');

  const updated = await librarian.update(who, asset.id, { expiresAt: '2027-01-01T00:00:00.000Z' });
  assert.equal(updated.expiresAt, '2027-01-01T00:00:00.000Z');

  await assert.rejects(librarian.update(who, asset.id, { title: 'Renamed' }), /field group "core"/);
});

test('SECURITY: a patch spanning groups needs ALL of them', async () => {
  // Holding one is not holding the other, and the cheap half must not carry the expensive one.
  const { service, caller } = harness();
  const editor = caller(EDITOR);
  const asset = await service.create(editor, NEW_ASSET);

  await assert.rejects(
    service.update(editor, asset.id, { title: 'Renamed', expiresAt: '2027-01-01T00:00:00.000Z' }),
    /field group "rights"/,
  );
  assert.equal((await service.get(editor, asset.id)).title, 'Clip', 'nothing was written');
});

test('a no-op field does not demand its group', async () => {
  // A form that resubmits an untouched `expiresAt` must not need a rights grant to change a title.
  // The group check runs on what CHANGED, after the no-op filter.
  const { service, caller, store } = harness();
  const created = await service.create(caller(UNSCOPED), {
    ...NEW_ASSET,
    expiresAt: '2027-01-01T00:00:00.000Z',
  });

  const editors = new MamService({ store });
  const editor = caller(EDITOR, 'user-2');
  const updated = await editors.update(editor, created.id, {
    title: 'Renamed',
    expiresAt: '2027-01-01T00:00:00.000Z', // unchanged
  });
  assert.equal(updated.title, 'Renamed');
});

test('SECURITY: creating WITH an expiry is a rights write; creating without is not', async () => {
  const { service, caller } = harness();
  const editor = caller(EDITOR);

  assert.ok(await service.create(editor, NEW_ASSET), 'the ordinary case stays an Editor action');

  await assert.rejects(
    service.create(editor, { ...NEW_ASSET, expiresAt: '2027-01-01T00:00:00.000Z' }),
    /field group "rights"/,
  );
});

test('SECURITY: attaching renditions is a FILES write', async () => {
  const { service, caller, store } = harness();
  const asset = await service.create(caller(UNSCOPED), NEW_ASSET);

  const editors = new MamService({ store });
  await assert.rejects(
    editors.attachRenditions(caller(EDITOR, 'user-2'), asset.id),
    /field group "files"/,
  );

  const librarians = new MamService({ store });
  assert.equal(
    (await librarians.attachRenditions(caller(LIBRARIAN, 'user-3'), asset.id)).hasRenditions,
    true,
  );
});

test('SECURITY: an extended field annotated `rights` is behind the rights grant', async () => {
  // The point of making the group operator-declarable: an operator can define a rights field
  // without thereby handing every editor rights.
  const { service, caller, store } = harness();
  const admin = caller(UNSCOPED);
  const schema: FieldSchema = {
    id: 'video-core',
    channelId: CHANNEL,
    mediaType: 'video',
    fields: [
      { name: 'competition', label: 'Competition', type: 'string' },
      { name: 'licenceWindow', label: 'Licence window', type: 'string', fieldGroup: 'rights' },
    ],
  };
  await service.putSchema(admin, schema);
  const asset = await service.create(admin, NEW_ASSET);

  const editors = new MamService({ store });
  const editor = caller(EDITOR, 'user-2');

  // Unannotated → core → the Editor holds it.
  assert.deepEqual(await editors.updateExtended(editor, asset.id, { competition: 'UEFA' }), {
    competition: 'UEFA',
  });

  await assert.rejects(
    editors.updateExtended(editor, asset.id, { licenceWindow: '2026-2027' }),
    /field group "rights"/,
  );
});

test('an unknown extended field is still a 422, not a 403', async () => {
  // Order matters: validation runs before the group lookup. Reversed, a caller could probe which
  // field names exist by watching a 403 turn into a 422.
  const { service, caller } = harness();
  const editor = caller(EDITOR);
  const asset = await service.create(editor, NEW_ASSET);

  await assert.rejects(
    service.updateExtended(editor, asset.id, { nonexistent: 'x' }),
    (e: Error) => (e as { status?: number }).status === 422,
  );
});

test('a rule with NO fieldGroups still grants every group', async () => {
  // §3.1: "A rule with no fieldGroups grants all groups." Existing single-rule deployments must
  // keep working exactly as they did — this change narrows what a SCOPED grant reaches, not what an
  // unscoped one does.
  const { service, caller } = harness();
  const admin = caller(UNSCOPED);
  const asset = await service.create(admin, {
    ...NEW_ASSET,
    expiresAt: '2027-01-01T00:00:00.000Z',
  });

  assert.ok(await service.update(admin, asset.id, { title: 'Renamed', episodeNo: 3 }));
  assert.ok(await service.attachRenditions(admin, asset.id));
});
