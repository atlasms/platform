import { describe, expect, it } from 'vitest';
import type { FieldSchema } from '../core/generated/mam.types.ts';
import {
  blankRow,
  draftOf,
  inputOf,
  moved,
  problemsByPath,
  renamed,
} from './field-schema.model.ts';

const schema: FieldSchema = {
  id: 'fs1',
  channelId: 'ch12',
  mediaType: 'video',
  categoryPath: '/sports/',
  version: 3,
  fields: [
    { name: 'competition', label: 'Competition', type: 'enum', options: ['League', 'Cup'] },
    { name: 'notes', label: 'Notes', type: 'text', maxLength: 500, fieldGroup: 'rights' },
    { name: 'genre', label: 'Genre', type: 'vocabulary', vocabulary: 'genre', required: true },
  ],
};

describe('the field-schema form model', () => {
  it('round-trips a schema through the form unchanged', () => {
    const back = inputOf(draftOf(schema), 'fs1');
    expect(back).toEqual({
      id: 'fs1',
      mediaType: 'video',
      categoryPath: '/sports/',
      fields: schema.fields,
    });
  });

  it('sends only what a row’s type uses — switching type drops the rest, blanks are absent', () => {
    const d = draftOf(schema);
    d.fields[0] = { ...d.fields[0]!, type: 'string' }; // was an enum with options
    d.fields[1] = { ...d.fields[1]!, type: 'number' }; // was text with a bound
    d.fields[2] = { ...d.fields[2]!, type: 'boolean', helpText: '  ' };
    d.categoryPath = '  ';
    const out = inputOf(d, 'fs1');
    expect(out.categoryPath).toBeUndefined();
    expect(out.fields).toEqual([
      { name: 'competition', label: 'Competition', type: 'string' },
      { name: 'notes', label: 'Notes', type: 'number', fieldGroup: 'rights' },
      { name: 'genre', label: 'Genre', type: 'boolean', required: true },
    ]);
  });

  it('an enum’s options are one per line, blank lines ignored', () => {
    const d = draftOf(schema);
    d.fields[0] = { ...d.fields[0]!, options: 'League\n\n  Cup  \nFriendly' };
    expect(inputOf(d, 'fs1').fields[0]?.options).toEqual(['League', 'Cup', 'Friendly']);
  });

  it('a renamed field is noticed — its stored values would be orphaned; a new row is not', () => {
    const d = draftOf(schema);
    d.fields[1] = { ...d.fields[1]!, name: 'remarks' };
    d.fields.push({ ...blankRow(), name: 'brandNew' });
    expect(renamed(d).map((r) => r.readName)).toEqual(['notes']);
  });

  it('MAM’s problems are placed by path; anything else in details is ignored', () => {
    expect(
      problemsByPath({
        problems: [
          { path: 'fields[0].options', message: 'a' },
          { path: 'fields[0].options', message: 'b' },
          { path: 'mediaType', message: 'c' },
          { nonsense: true },
        ],
      }),
    ).toEqual({ 'fields[0].options': ['a', 'b'], mediaType: ['c'] });
    expect(problemsByPath(null)).toEqual({});
  });

  it('rows move up and down within bounds', () => {
    const rows = draftOf(schema).fields;
    expect(moved(rows, 0, 1).map((r) => r.name)).toEqual(['notes', 'competition', 'genre']);
    expect(moved(rows, 0, -1).map((r) => r.name)).toEqual(['competition', 'notes', 'genre']);
    expect(moved(rows, 2, 1).map((r) => r.name)).toEqual(['competition', 'notes', 'genre']);
  });
});
