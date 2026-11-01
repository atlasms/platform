import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { FieldSchemasService } from '../core/field-schemas.service.ts';
import type { FieldSchema } from '../core/generated/mam.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { FieldSchemaEditor } from './field-schema-editor.ts';

const schema = (overrides: Partial<FieldSchema> = {}): FieldSchema => ({
  id: 'fs1',
  channelId: 'ch12',
  mediaType: 'video',
  version: 2,
  fields: [{ name: 'rating', label: 'Rating', type: 'number', required: true }],
  ...overrides,
});

class FakeSchemas {
  readonly lists: Subject<FieldSchema[]>[] = [];
  readonly puts: Array<{ schema: FieldSchema; version?: number; result: Subject<FieldSchema> }> =
    [];
  list() {
    const s = new Subject<FieldSchema[]>();
    this.lists.push(s);
    return s;
  }
  put(schema: FieldSchema, version?: number) {
    const result = new Subject<FieldSchema>();
    this.puts.push({ schema, ...(version !== undefined ? { version } : {}), result });
    return result;
  }
}

class FakeLocale {
  locale = () => 'en';
  loading = () => false;
  t(key: string): string {
    return key;
  }
  setLocale(_locale: 'en' | 'ar'): Promise<void> {
    return Promise.resolve();
  }
}

interface Internal {
  add(): void;
  remove(i: number): void;
  move(i: number, by: -1 | 1): void;
  set(i: number, key: string, value: unknown): void;
  save(): void;
  error: () => string | null;
  notice: () => string | null;
  dirty: () => boolean;
  canEdit: () => boolean;
}

function setup(permissions = ['taxonomy:admin', 'asset:read']) {
  const fake = new FakeSchemas();
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: FieldSchemasService, useValue: fake },
      { provide: LocaleService, useClass: FakeLocale },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'u1',
    channelId: 'ch12',
    policy: { subjectId: 'u1', permVersion: 1, rules: [{ id: 'r', permissions }] },
  });
  const fixture = TestBed.createComponent(FieldSchemaEditor);
  fixture.componentRef.setInput('schemaId', 'fs1');
  fixture.componentRef.setInput('tabId', 'field-schema:fs1');
  fixture.detectChanges();
  const load = (list: FieldSchema[] = [schema()]) => {
    fake.lists.at(-1)?.next(list);
    fixture.detectChanges();
  };
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    component: fixture.componentInstance as unknown as Internal,
    fake,
    load,
  };
}

describe('FieldSchemaEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('edits the fields and saves the whole schema over the version read', () => {
    const t = setup();
    t.load();
    expect(t.component.dirty()).toBe(false);
    t.component.add();
    t.component.set(1, 'name', 'competition');
    t.component.set(1, 'label', 'Competition');
    t.component.set(1, 'type', 'enum');
    t.component.set(1, 'options', 'League\nCup');
    t.component.move(1, -1);
    expect(t.component.dirty()).toBe(true);
    t.component.save();
    expect(t.fake.puts[0]?.version).toBe(2);
    expect(t.fake.puts[0]?.schema).toEqual({
      id: 'fs1',
      mediaType: 'video',
      fields: [
        { name: 'competition', label: 'Competition', type: 'enum', options: ['League', 'Cup'] },
        { name: 'rating', label: 'Rating', type: 'number', required: true },
      ],
    });
    t.fake.puts[0]?.result.next(schema({ version: 3 }));
    expect(t.component.notice()).toBe('schemaEditor.saved');
    expect(t.component.dirty()).toBe(false);
  });

  it('MAM’s 422 is placed under the control each problem names', () => {
    const t = setup();
    t.load();
    t.component.set(0, 'name', '9lives');
    t.component.save();
    t.fake.puts[0]?.result.error(
      new HttpErrorResponse({
        status: 422,
        error: {
          code: 'VALIDATION',
          details: { problems: [{ path: 'fields[0].name', message: 'must start with a letter' }] },
        },
      }),
    );
    t.fixture.detectChanges();
    expect(t.component.error()).toBe('schemaEditor.invalid');
    const field = t.root.querySelector('.field') as HTMLElement;
    expect(field.querySelector('.problem')?.textContent?.trim()).toBe('must start with a letter');
  });

  it('a 409 reads the schema again — someone else’s save is never overwritten', () => {
    const t = setup();
    t.load();
    t.component.set(0, 'label', 'Score');
    t.component.save();
    t.fake.puts[0]?.result.error(new HttpErrorResponse({ status: 409 }));
    expect(t.component.error()).toBe('schemaEditor.moved');
    expect(t.fake.lists.length).toBe(2);
  });

  it('a rename is warned about before saving: values under the old name become orphaned', () => {
    const t = setup();
    t.load();
    t.component.set(0, 'name', 'score');
    t.fixture.detectChanges();
    expect(t.root.querySelector('.warning code')?.textContent).toBe('rating');
  });

  it('a type shows only the controls it takes', () => {
    const t = setup();
    t.load();
    const controls = () =>
      [...t.root.querySelectorAll('.field label span')].map((s) => s.textContent?.trim());
    expect(controls()).not.toContain('schemaEditor.options');
    t.component.set(0, 'type', 'enum');
    t.fixture.detectChanges();
    expect(controls()).toContain('schemaEditor.options');
    expect(controls()).not.toContain('schemaEditor.maxLength');
    t.component.set(0, 'type', 'text');
    t.fixture.detectChanges();
    expect(controls()).toContain('schemaEditor.maxLength');
  });

  it('without taxonomy:admin it is read-only; a schema that is gone says so', () => {
    const reader = setup(['asset:read']);
    reader.load();
    expect(reader.component.canEdit()).toBe(false);
    expect(reader.root.querySelector('.add')).toBeNull();
    expect((reader.root.querySelector('.field input') as HTMLInputElement).disabled).toBe(true);
    TestBed.resetTestingModule();
    const gone = setup();
    gone.load([]);
    expect(gone.component.error()).toBe('schemaEditor.gone');
  });
});
