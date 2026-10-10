import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import type { Person } from '../../core/generated/mam.types.ts';
import { LocaleService } from '../../core/locale.service.ts';
import { PeopleService } from '../../core/people.service.ts';
import { PermissionService } from '../../core/permission.service.ts';

/**
 * The Admin panel's People view (EP-28.5): the people register — a name and an optional image
 * reference per person, nothing else (FR-PPL-2). Rename, deprecate and restore, each over the
 * version read; a 409 reloads. What someone did on a piece of media is that asset's cast.
 */
@Component({
  selector: 'atlas-people-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (canWrite()) {
      <form class="new" (ngSubmit)="create()">
        <label>
          <span>{{ locale.t('people.name') }}</span>
          <input name="name" [(ngModel)]="name" autocomplete="off" />
        </label>
        <label>
          <span>{{ locale.t('people.imageRef') }}</span>
          <input name="imageRef" [(ngModel)]="imageRef" autocomplete="off" />
        </label>
        <p class="muted">{{ locale.t('people.minimal') }}</p>
        <button type="submit" [disabled]="busy() || !name.trim()">
          {{ locale.t('admin.create') }}
        </button>
      </form>
    }
    <label class="check">
      <input
        type="checkbox"
        [ngModel]="showDeprecated()"
        (ngModelChange)="showDeprecated.set($event); load()"
      />
      <span>{{ locale.t('categories.showDeprecated') }}</span>
    </label>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (loading()) {
      <p class="muted">{{ locale.t('admin.loading') }}</p>
    } @else if (people().length === 0) {
      <p class="muted">{{ locale.t('people.none') }}</p>
    } @else {
      <ul class="items">
        @for (p of people(); track p.id) {
          <li>
            @if (canWrite() && editing() === p.id) {
              <form class="row" (ngSubmit)="rename(p)">
                <input name="editName" [(ngModel)]="editName" />
                <button type="submit" [disabled]="busy() || !editName.trim()">
                  {{ locale.t('admin.save') }}
                </button>
                <button type="button" class="link" (click)="editing.set(null)">
                  {{ locale.t('admin.revert') }}
                </button>
              </form>
            } @else {
              <span class="title">{{ p.name }}</span>
              @if (p.deprecatedAt) {
                <span class="state" data-state="disabled">{{
                  locale.t('categories.deprecated')
                }}</span>
              }
              @if (canWrite()) {
                <button type="button" class="link" (click)="edit(p)">
                  {{ locale.t('vocab.edit') }}
                </button>
                <button type="button" class="link" [disabled]="busy()" (click)="deprecate(p)">
                  {{
                    p.deprecatedAt
                      ? locale.t('categories.restore')
                      : locale.t('categories.deprecate')
                  }}
                </button>
              }
            }
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './admin-view.scss',
  styles: `
    .check,
    .row {
      display: flex;
      gap: var(--space-1);
      align-items: center;
      font-size: 0.75rem;
    }
  `,
})
export class PeopleView {
  private readonly api = inject(PeopleService);
  private readonly permissions = inject(PermissionService);
  protected readonly locale = inject(LocaleService);

  protected readonly people = signal<Person[]>([]);
  protected readonly showDeprecated = signal(false);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** UX only — MAM enforces `people:admin` in the channel. */
  protected readonly canWrite = computed(() => this.permissions.can('people:admin'));

  protected name = '';
  protected imageRef = '';
  protected editName = '';

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.api.list(this.showDeprecated()).subscribe({
      next: (all) => {
        this.people.set(all);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(this.locale.t('admin.loadError'));
        this.loading.set(false);
      },
    });
  }

  protected edit(p: Person): void {
    this.editName = p.name;
    this.editing.set(p.id);
  }

  protected create(): void {
    if (this.busy() || !this.name.trim()) return;
    this.write(
      this.api.create({
        name: this.name.trim(),
        ...(this.imageRef.trim() ? { imageRef: this.imageRef.trim() } : {}),
      }),
      () => {
        this.name = '';
        this.imageRef = '';
      },
    );
  }

  protected rename(p: Person): void {
    this.write(this.api.update(p.id, p.version, { name: this.editName.trim() }));
  }

  protected deprecate(p: Person): void {
    this.write(this.api.update(p.id, p.version, { deprecated: !p.deprecatedAt }));
  }

  private write(request: Observable<Person>, then?: () => void): void {
    this.busy.set(true);
    this.error.set(null);
    request.subscribe({
      next: () => {
        this.busy.set(false);
        this.editing.set(null);
        then?.();
        this.load();
      },
      error: (err: { status?: number; error?: { message?: string } }) => {
        this.busy.set(false);
        this.error.set(
          err.status === 409
            ? this.locale.t('vocab.conflict')
            : (err.error?.message ?? this.locale.t('admin.writeError')),
        );
        if (err.status === 409) this.load();
      },
    });
  }
}
