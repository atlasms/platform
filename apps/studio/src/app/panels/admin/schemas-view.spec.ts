// The Admin panel's Field schemas view (EP-27.4): lists MAM's schemas by where they apply,
// creates one with no fields yet, and opens it as a field-schema editor tab.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { CategoriesService } from '../../core/categories.service.ts';
import { FieldSchemasService } from '../../core/field-schemas.service.ts';
import type { Category, FieldSchema } from '../../core/generated/mam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { EditorStore } from '../../workbench/editor.store.ts';
import { SchemasView } from './schemas-view.ts';

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

function setup() {
  const fake = new FakeSchemas();
  const tree = new Subject<Category[]>();
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: FieldSchemasService, useValue: fake },
      { provide: CategoriesService, useValue: { list: () => tree } },
      { provide: LocaleService, useClass: FakeLocale },
    ],
  });
  const fixture = TestBed.createComponent(SchemasView);
  fixture.detectChanges();
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    component: fixture.componentInstance as unknown as {
      create(): void;
      mediaType: string;
      categoryPath: string;
    },
    fake,
    tree,
    editors: TestBed.inject(EditorStore),
  };
}

describe('SchemasView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists each schema by where it applies and how many fields it defines', () => {
    const t = setup();
    t.fake.lists[0]?.next([
      { id: 'a', mediaType: 'video', fields: [{ name: 'x', label: 'X', type: 'string' }] },
      { id: 'b', mediaType: 'audio', categoryPath: '/news/', fields: [] },
    ]);
    t.fixture.detectChanges();
    const rows = [...t.root.querySelectorAll('.items li')].map((li) => [
      li.querySelector('.title')?.textContent?.trim(),
      li.querySelector('.state')?.textContent?.replace(/\s+/g, ' ').trim(),
    ]);
    expect(rows).toEqual([
      ['video · admin.wholeChannel', '1 admin.fieldsCount'],
      ['audio · /news/', '0 admin.fieldsCount'],
    ]);
  });

  it('creates a schema with no fields — a browser-minted ULID, the branch chosen — and opens its tab', () => {
    const t = setup();
    t.fake.lists[0]?.next([]);
    t.component.mediaType = 'image';
    t.component.categoryPath = '/sports/';
    t.component.create();
    const sent = t.fake.puts[0]!;
    expect(sent.version).toBeUndefined(); // a NEW schema
    expect(sent.schema.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(sent.schema).toMatchObject({ mediaType: 'image', categoryPath: '/sports/', fields: [] });
    sent.result.next({ ...sent.schema, version: 1 });
    const tabs = t.editors.layout().groups.flatMap((g) => g.tabs);
    expect(tabs.map((x) => x.id)).toEqual([`field-schema:${sent.schema.id}`]);
  });
});
