import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_TYPES,
  orphanedFields,
  requiredFieldNames,
  resolveFields,
  validateExtended,
  type FieldDefinition,
  type FieldSchema,
} from '../src/index.ts';

const CHANNEL = 'ch12';

const schema = (over: Partial<FieldSchema> & Pick<FieldSchema, 'id' | 'fields'>): FieldSchema => ({
  channelId: CHANNEL,
  mediaType: 'video',
  ...over,
});

const field = (
  over: Partial<FieldDefinition> & Pick<FieldDefinition, 'name'>,
): FieldDefinition => ({
  label: over.name,
  type: 'string',
  ...over,
});

// =============================================================================
// Which fields apply
// =============================================================================

test('a channel-wide schema applies to every asset of its media type', () => {
  const schemas = [schema({ id: 's1', fields: [field({ name: 'genre' })] })];

  assert.deepEqual(
    resolveFields(schemas, { channelId: CHANNEL, mediaType: 'video' }).map((f) => f.name),
    ['genre'],
  );
  assert.deepEqual(resolveFields(schemas, { channelId: CHANNEL, mediaType: 'photo' }), []);
});

test('SECURITY: a schema never leaks across a channel', () => {
  const schemas = [schema({ id: 's1', channelId: 'ch99', fields: [field({ name: 'genre' })] })];
  assert.deepEqual(resolveFields(schemas, { channelId: CHANNEL, mediaType: 'video' }), []);
});

test('a category-scoped schema matches its whole subtree', () => {
  const schemas = [
    schema({ id: 's1', categoryPath: '/sports/', fields: [field({ name: 'competition' })] }),
  ];

  const inSubtree = resolveFields(schemas, {
    channelId: CHANNEL,
    mediaType: 'video',
    categoryPath: '/sports/football/highlights/',
  });
  assert.deepEqual(
    inSubtree.map((f) => f.name),
    ['competition'],
  );

  assert.deepEqual(
    resolveFields(schemas, { channelId: CHANNEL, mediaType: 'video', categoryPath: '/news/' }),
    [],
  );
});

test('DANGER: prefix matching cannot cross a segment boundary', () => {
  // Without normalisation `/sports/foot` matches `/sports/football/`, silently applying a sibling
  // branch's fields — the same hazard the policy evaluator has.
  const schemas = [
    schema({ id: 's1', categoryPath: '/sports/foot', fields: [field({ name: 'wrong' })] }),
  ];

  assert.deepEqual(
    resolveFields(schemas, {
      channelId: CHANNEL,
      mediaType: 'video',
      categoryPath: '/sports/football/',
    }),
    [],
  );
});

test('a category-scoped schema does not apply to an uncategorised asset', () => {
  const schemas = [
    schema({ id: 's1', categoryPath: '/sports/', fields: [field({ name: 'competition' })] }),
  ];
  assert.deepEqual(resolveFields(schemas, { channelId: CHANNEL, mediaType: 'video' }), []);
});

test('schemas MERGE, and the more specific one wins a name collision', () => {
  // This is what lets a branch tighten an inherited field without restating everything above it.
  const schemas = [
    schema({
      id: 'wide',
      fields: [field({ name: 'genre' }), field({ name: 'note', required: false })],
    }),
    schema({
      id: 'narrow',
      categoryPath: '/sports/football/',
      fields: [field({ name: 'note', required: true, label: 'Match note' })],
    }),
  ];

  const resolved = resolveFields(schemas, {
    channelId: CHANNEL,
    mediaType: 'video',
    categoryPath: '/sports/football/',
  });

  assert.deepEqual(new Set(resolved.map((f) => f.name)), new Set(['genre', 'note']));
  const note = resolved.find((f) => f.name === 'note');
  assert.equal(note?.required, true, 'the narrower schema must win');
  assert.equal(note?.label, 'Match note');
});

test('specificity beats declaration order', () => {
  // Declared narrowest-first, which would give the wrong answer if order were trusted.
  const schemas = [
    schema({
      id: 'narrow',
      categoryPath: '/a/b/',
      fields: [field({ name: 'x', label: 'narrow' })],
    }),
    schema({ id: 'wide', fields: [field({ name: 'x', label: 'wide' })] }),
  ];

  const resolved = resolveFields(schemas, {
    channelId: CHANNEL,
    mediaType: 'video',
    categoryPath: '/a/b/c/',
  });
  assert.equal(resolved[0]?.label, 'narrow');
});

// =============================================================================
// Validation
// =============================================================================

const fields: FieldDefinition[] = [
  field({ name: 'title2', type: 'string', maxLength: 5 }),
  field({ name: 'synopsis', type: 'text' }),
  field({ name: 'rating', type: 'number' }),
  field({ name: 'live', type: 'boolean' }),
  field({ name: 'airDate', type: 'date' }),
  field({ name: 'format', type: 'enum', options: ['16:9', '4:3'] }),
  field({ name: 'genre', type: 'vocabulary', vocabulary: 'genres' }),
];

const vocabularies = new Map([['genres', new Set(['drama', 'documentary'])]]);

test('every field type accepts its own values', () => {
  const errors = validateExtended(
    fields,
    {
      title2: 'abc',
      synopsis: 'a longer piece of prose',
      rating: 4.5,
      live: true,
      airDate: '2026-08-06T12:00:00.000Z',
      format: '16:9',
      genre: 'drama',
    },
    { vocabularies },
  );
  assert.deepEqual(errors, []);
});

test('every field type refuses the wrong shape', () => {
  const cases: [string, unknown][] = [
    ['title2', 42],
    ['synopsis', { not: 'a string' }],
    ['rating', 'four'],
    ['live', 'yes'],
    ['airDate', 'next Tuesday'],
    ['format', '21:9'],
    ['genre', 'sci-fi'],
  ];

  for (const [name, value] of cases) {
    const errors = validateExtended(fields, { [name]: value }, { vocabularies });
    assert.equal(errors.length, 1, `${name} = ${JSON.stringify(value)} should be one error`);
    assert.equal(errors[0]?.field, name);
  }
});

test('DANGER: NaN and Infinity are refused, though typeof says number', () => {
  // Both survive a JS caller and serialize to `null`, so they would be stored as a value that
  // reads back as something else entirely.
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
    const errors = validateExtended(fields, { rating: value });
    assert.equal(errors.length, 1, `${String(value)} must be refused`);
    assert.match(errors[0]?.message ?? '', /finite/);
  }
});

test('DANGER: an unparseable date is refused rather than stored as Invalid Date', () => {
  // `new Date('nonsense')` does not throw — it yields Invalid Date, which stores happily and fails
  // much later, wherever someone formats it.
  const errors = validateExtended(fields, { airDate: '2026-13-45' });
  assert.equal(errors.length, 1);
});

test('SECURITY: an unknown field is refused, not stored', () => {
  // A typo that silently becomes data is a value nothing renders, nothing searches, and nobody
  // discovers until they ask where their input went.
  const errors = validateExtended(fields, { genreee: 'drama' }, { vocabularies });
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? '', /no field "genreee"/);
});

test('DANGER: an unloaded vocabulary is an error, never a pass', () => {
  // Accepting a term nobody could check defeats the point of the list being controlled — and the
  // value would sit in the document looking validated.
  const errors = validateExtended(fields, { genre: 'drama' }, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? '', /not loaded/);
});

test('null clears a field; omitting it leaves the field alone', () => {
  assert.deepEqual(validateExtended(fields, { rating: null }), []);
  assert.deepEqual(validateExtended(fields, {}), []);
});

test('validation is PARTIAL — a required field missing from a patch is not an error', () => {
  // A patch setting one field is not claiming the asset is complete. Completeness is the
  // lifecycle's question, asked at markReady. Enforcing it here would make every partial edit fail.
  const withRequired = [field({ name: 'genre2', type: 'string', required: true })];
  assert.deepEqual(validateExtended(withRequired, {}), []);
});

test('all errors are reported, not just the first', () => {
  const errors = validateExtended(
    fields,
    { rating: 'x', live: 'y', format: 'z' },
    { vocabularies },
  );
  assert.equal(errors.length, 3);
});

// =============================================================================
// Feeding the mandatory gate, and surviving a schema edit
// =============================================================================

test('requiredFieldNames feeds the lifecycle gate', () => {
  const resolved = [
    field({ name: 'a', required: true }),
    field({ name: 'b' }),
    field({ name: 'c', required: true }),
  ];
  assert.deepEqual(requiredFieldNames(resolved), ['a', 'c']);
});

test('a field removed from the schema orphans its data rather than destroying it', () => {
  // An operator removing a field is usually reorganising, not asking for every asset's data to be
  // deleted — and there is no undo for that.
  const resolved = [field({ name: 'kept' })];
  assert.deepEqual(orphanedFields(resolved, { kept: 1, gone: 'still here' }), ['gone']);
});

test('the field-type list is closed', () => {
  // Tier 0: the validator and the form renderer each switch on it, so adding one is a pull request
  // with a schema-version bump, not an operator edit.
  assert.deepEqual(
    [...FIELD_TYPES],
    ['string', 'text', 'number', 'boolean', 'date', 'enum', 'vocabulary'],
  );
});
