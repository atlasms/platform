import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { CategoriesService } from './categories.service.ts';
import { CategoryScope, describeScope } from './category-scope.ts';
import type { Category } from './generated/mam.types.ts';
import { LocaleService } from './locale.service.ts';

const at = '2026-10-11T00:00:00.000Z';
const cat = (id: string, path: string, over: Partial<Category> = {}): Category => ({
  id,
  channelId: 'ch12',
  key: path.split('/').filter(Boolean).at(-1)!,
  path,
  depth: path.split('/').filter(Boolean).length,
  labels: { en: id },
  sortOrder: 0,
  mediaAddable: true,
  version: 1,
  createdBy: 'u1',
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe('the category scope picker', () => {
  it('offers the LIVE tree by path, and a pick sets the paths a rule is narrowed to', () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: CategoriesService,
          useValue: {
            list: () =>
              of([
                cat('N', '/news/'),
                cat('S', '/sport/'),
                cat('O', '/old/', { deprecatedAt: at }),
              ]),
          },
        },
        { provide: LocaleService, useValue: { t: (k: string) => k } },
      ],
    });
    const fixture = TestBed.createComponent(CategoryScope);
    fixture.detectChanges();
    const select = (fixture.nativeElement as HTMLElement).querySelector('select')!;
    expect([...select.options].map((o) => o.value)).toEqual(['/news/', '/sport/']);

    select.options[1]!.selected = true;
    select.dispatchEvent(new Event('change'));
    expect(fixture.componentInstance.paths()).toEqual(['/sport/']);
  });

  it('describes a scope by its channels and, when narrowed, its subtrees', () => {
    expect(describeScope({ channelIds: ['ch12'] })).toBe(' @ ch12');
    expect(describeScope({ channelIds: ['ch12'], categoryPaths: ['/news/'] })).toBe(
      ' @ ch12 in /news/',
    );
    expect(describeScope(undefined)).toBe('');
  });
});
