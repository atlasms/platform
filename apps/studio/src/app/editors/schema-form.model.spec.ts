import { describe, expect, it } from 'vitest';
import {
  entriesOf,
  fieldKind,
  labelOf,
  optionsOf,
  parseVersion,
  propertiesOf,
  renameKey,
  withProperty,
  type Schema,
} from './schema-form.model.ts';

// Shaped as BMS's palette serves them (@atlas/contracts `palette()`): every $ref inlined, FEEL and
// durations annotated, the closed-list fields marked.
const FEEL = { type: 'string', 'x-atlas-type': 'feel', description: 'A FEEL expression …' };
const MAPPING = { type: 'object', additionalProperties: FEEL };
const COMMAND: Schema = {
  type: 'object',
  required: ['action', 'request'],
  properties: {
    action: { type: 'string' },
    request: {
      type: 'object',
      required: ['event'],
      properties: {
        event: { type: 'string', 'x-choices': 'commands' },
        input: MAPPING,
      },
    },
    await: {
      type: 'object',
      properties: { correlate: FEEL, output: MAPPING },
    },
  },
};
const CHOICES = {
  commands: [{ event: 'transcode.job.create', target: 'mts', completes: ['transcode.completed'] }],
};

describe('fieldKind — what a field is, from its schema alone', () => {
  it('reads the palette’s annotations before the plain types', () => {
    expect(fieldKind(COMMAND)).toBe('object');
    expect(fieldKind(FEEL)).toBe('feel');
    expect(fieldKind({ type: 'string', 'x-atlas-type': 'duration' })).toBe('duration');
    expect(fieldKind({ type: 'string', 'x-choices': 'events' })).toBe('choice');
    expect(fieldKind(MAPPING)).toBe('map');
    expect(fieldKind({ enum: ['approve', 'edit'] })).toBe('enum');
    expect(fieldKind({ type: 'boolean' })).toBe('boolean');
    expect(fieldKind({ type: 'integer', minimum: 1 })).toBe('number');
    expect(fieldKind({ type: 'string' })).toBe('text');
  });

  it('a sub-flow version — a number or `latest` — is its own field; anything unknown is JSON', () => {
    expect(fieldKind({ oneOf: [{ type: 'integer', minimum: 1 }, { const: 'latest' }] })).toBe(
      'version',
    );
    // A human task's `form` is an object with no properties: still editable, as JSON.
    expect(fieldKind({ type: 'object' })).toBe('json');
    expect(fieldKind({ oneOf: [{ type: 'string' }, { type: 'array' }] })).toBe('json');
  });
});

describe('the rest of the form model', () => {
  it('properties keep the schema’s order and mark the required', () => {
    expect(propertiesOf(COMMAND).map((p) => [p.key, p.required])).toEqual([
      ['action', true],
      ['request', true],
      ['await', false],
    ]);
  });

  it('a closed list offers its values — a command by its event — and keeps a retired current value', () => {
    const event = { type: 'string', 'x-choices': 'commands' };
    expect(optionsOf(event, CHOICES, undefined)).toEqual(['transcode.job.create']);
    expect(optionsOf(event, CHOICES, 'publish.web.requested')).toEqual([
      'transcode.job.create',
      'publish.web.requested',
    ]);
    expect(optionsOf({ enum: ['a', 'b'] }, undefined, 'a')).toEqual(['a', 'b']);
    expect(optionsOf(event, undefined, undefined)).toEqual([]);
  });

  it('an emptied optional field is removed, not kept as an empty string', () => {
    expect(withProperty({ a: 1, b: 2 }, 'a', '')).toEqual({ b: 2 });
    expect(withProperty({ a: 1 }, 'a', undefined)).toEqual({});
    expect(withProperty(undefined, 'a', 'x')).toEqual({ a: 'x' });
    const input = { a: 1 };
    withProperty(input, 'b', 2);
    expect(input).toEqual({ a: 1 }); // never mutated
  });

  it('a version is a whole number, latest, or blank — anything else is said to be wrong', () => {
    expect(parseVersion('3')).toBe(3);
    expect(parseVersion(' latest ')).toBe('latest');
    expect(parseVersion('')).toBeUndefined();
    expect(parseVersion('0')).toBeNull();
    expect(parseVersion('1.5')).toBeNull();
  });

  it('a mapping row renamed keeps its place; renamed onto another key it replaces it', () => {
    const map = { 'vars.a': '= 1', 'vars.b': '= 2', 'vars.c': '= 3' };
    expect(Object.keys(renameKey(map, 'vars.b', 'vars.x'))).toEqual(['vars.a', 'vars.x', 'vars.c']);
    expect(renameKey(map, 'vars.b', 'vars.c')).toEqual({ 'vars.a': '= 1', 'vars.c': '= 2' });
    expect(entriesOf(map)[1]).toEqual(['vars.b', '= 2']);
  });

  it('labels come from keys', () => {
    expect(labelOf('reviewPointId')).toBe('Review point id');
    expect(labelOf('dueIn')).toBe('Due in');
    expect(labelOf('workflowId')).toBe('Workflow id');
  });
});
