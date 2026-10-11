import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  model,
  signal,
  type OnInit,
} from '@angular/core';
import { CategoriesService } from './categories.service.ts';
import type { Category } from './generated/mam.types.ts';
import { LocaleService } from './locale.service.ts';

/**
 * Narrow a rule to category subtrees (authorization-model §4: `scope.categoryPaths`). The grant
 * editors' inline rules took a channel only, so a category-scoped grant — "edit news, nothing else"
 * — could be written by IAM's API but not by anyone in Studio. This offers the channel's LIVE tree
 * by path; a chosen path covers the category and everything below it, and nothing chosen leaves
 * the rule channel-wide. The paths are what the server matches, so they are what is shown.
 */
@Component({
  selector: 'atlas-category-scope',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="scope">
      <span>{{ locale.t('admin.categoryScope') }}</span>
      <select
        multiple
        name="categoryPaths"
        [attr.aria-label]="locale.t('admin.categoryScope')"
        (change)="pick($any($event.target))"
      >
        @for (c of options(); track c.id) {
          <option [value]="c.path" [selected]="paths().includes(c.path)">{{ c.path }}</option>
        }
      </select>
      <small class="muted">
        {{
          paths().length === 0
            ? locale.t('admin.categoryScopeNone')
            : locale.t('admin.categoryScopeSome')
        }}
      </small>
    </label>
  `,
  styles: `
    .scope {
      display: grid;
      gap: 2px;
      font-size: 0.75rem;
    }
    select {
      min-block-size: 4.5rem;
    }
  `,
})
export class CategoryScope implements OnInit {
  /** The chosen paths; empty means the rule is channel-wide. */
  readonly paths = model<string[]>([]);

  private readonly api = inject(CategoriesService);
  protected readonly locale = inject(LocaleService);
  private readonly categories = signal<Category[]>([]);
  /** The live tree, in path order — a deprecated branch is not offered for new grants. */
  protected readonly options = computed(() => this.categories().filter((c) => !c.deprecatedAt));

  ngOnInit(): void {
    this.api.list().subscribe({
      next: (all) => this.categories.set(all),
      // Without the tree the picker is empty and the rule stays channel-wide — never a wider one.
      error: () => undefined,
    });
  }

  protected pick(select: HTMLSelectElement): void {
    this.paths.set([...select.selectedOptions].map((o) => o.value));
  }
}

/** How a rule's scope reads in a list: its channels, and its category subtrees when narrowed. */
export function describeScope(
  scope: { channelIds?: string[]; categoryPaths?: string[] } | undefined,
): string {
  const channels = scope?.channelIds?.length ? ` @ ${scope.channelIds.join(', ')}` : '';
  const paths = scope?.categoryPaths?.length ? ` in ${scope.categoryPaths.join(', ')}` : '';
  return `${channels}${paths}`;
}
