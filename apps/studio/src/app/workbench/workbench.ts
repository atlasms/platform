import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { LocaleService } from '../core/locale.service.ts';
import { EditorArea } from './editor-area.ts';
import { EditorStore } from './editor.store.ts';
import { PANELS, type PanelDefinition } from './panels.ts';

const MIN_SIDE_BAR = 160;
const MAX_SIDE_BAR = 640;

/**
 * The workbench frame — Activity Bar, Primary Side Bar, Editor Area, Status Bar
 * ([studio-frontend.md §1.1](../../../../../docs/architecture/studio-frontend.md)).
 *
 * The routed panel renders in the **side bar**, not the editor area: the activity bar switches
 * which panel's views are shown, while the editor area is tabbed and holds whatever the user
 * opened from them. That separation is the whole point of the workbench model.
 */
@Component({
  selector: 'atlas-workbench',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterOutlet, EditorArea],
  template: `
    <div class="workbench" [style.--side-bar-width.px]="sideBarWidth()">
      <nav class="activity-bar" aria-label="Panels">
        @for (panel of visiblePanels(); track panel.id) {
          <a
            class="activity-item"
            [class.disabled]="!panel.available"
            [class.active]="panel.id === activePanelId()"
            [routerLink]="panel.available ? panel.route : null"
            [attr.aria-disabled]="!panel.available"
            [title]="panel.available ? panel.title : panel.title + ' — not built yet'"
            (click)="panel.available && activePanelId.set(panel.id)"
          >
            <span aria-hidden="true">{{ panel.icon }}</span>
            <span class="sr-only">{{ panel.title }}</span>
          </a>
        } @empty {
          <p class="empty" title="No panel matches your permissions">∅</p>
        }
      </nav>

      <aside class="side-bar" aria-label="Primary side bar">
        <router-outlet />
      </aside>

      <!-- Drag to resize. Keyboard-operable too: a mouse-only divider is unusable for anyone
           navigating by keyboard, and the workbench is meant to reach WCAG 2.1 AA. -->
      <div
        class="resizer"
        role="separator"
        aria-orientation="vertical"
        [attr.aria-label]="locale.t('workbench.sideBar.resize')"
        tabindex="0"
        [attr.aria-valuenow]="sideBarWidth()"
        [attr.aria-valuemin]="minWidth"
        [attr.aria-valuemax]="maxWidth"
        (pointerdown)="startResize($event)"
        (keydown)="onResizeKey($event)"
      ></div>

      <main class="editor-area">
        <atlas-editor-area />
      </main>

      <footer class="status-bar">
        <span>{{ session.userId() ?? locale.t('auth.signIn') }}</span>
        <span class="sep">·</span>
        <span>{{ locale.t('workbench.statusBar.channel') }} {{ session.channelId() ?? '—' }}</span>
        @if (editors.hasUnsavedChanges()) {
          <span class="sep">·</span>
          <span>{{ locale.t('workbench.statusBar.unsavedChanges') }}</span>
        }
        <span class="spacer"></span>
        <span
          >{{ visiblePanels().length }} {{ locale.t('workbench.statusBar.panelsVisible') }}</span
        >
        @if (session.isAuthenticated()) {
          <span class="sep">·</span>
          <button type="button" class="link" (click)="signOut()">
            {{ locale.t('auth.signOut') }}
          </button>
        }
        <span class="sep">·</span>
        <select
          [value]="locale.locale()"
          (change)="onLocaleChange($event)"
          [disabled]="locale.loading()"
          aria-label="Language"
        >
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </footer>
    </div>
  `,
  styleUrl: './workbench.scss',
})
export class Workbench {
  protected readonly session = inject(SessionStore);
  protected readonly editors = inject(EditorStore);
  protected readonly locale = inject(LocaleService);
  private readonly permissions = inject(PermissionService);
  private readonly auth = inject(AuthService);
  private readonly ws = inject(WebSocketService);
  private readonly router = inject(Router);

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    // Navigate explicitly rather than relying on the guard: the guard only runs on the NEXT
    // navigation, so without this the workbench would sit there rendering a session that is gone.
    await this.router.navigateByUrl('/signin');
  }

  protected readonly allPanels = PANELS;
  protected readonly activePanelId = signal<string | null>(null);
  protected readonly sideBarWidth = signal(240);
  protected readonly minWidth = MIN_SIDE_BAR;
  protected readonly maxWidth = MAX_SIDE_BAR;

  /**
   * Connect/disconnect the websocket when the session becomes authenticated/unauthenticated.
   *
   * The websocket carries live events (asset.created, asset.updated, schedule.updated, etc.)
   * and respects the same permissions as the API — the server re-checks eligibility per message.
   */
  private readonly wsEffect = effect(() => {
    if (this.session.isAuthenticated()) {
      this.ws.connect();
    } else {
      this.ws.disconnect();
    }
  });

  /**
   * The dashboard is the default landing view (studio-frontend.md §3) — an EDITOR TAB, not a
   * side-bar panel: the widgets need the editor area's width, and "default" means it is open
   * when the workspace has nothing, not that it occupies the navigation column. A restored
   * workspace is left exactly as the user left it.
   */
  // Auto-open once per session: an effect re-run must not resurrect the tab the user just closed.
  private dashboardOpened = false;
  private readonly dashboardEffect = effect(() => {
    if (this.session.isAuthenticated() && !this.dashboardOpened && this.editors.isEmpty()) {
      this.dashboardOpened = true;
      this.editors.open({
        type: 'dashboard',
        resourceId: 'dashboard',
        title: this.locale.t('dashboard.title'),
        icon: '▣',
        preserveFocus: false,
      });
    }
  });

  /**
   * Panels the user may see.
   *
   * A `computed` over the policy signal, so a permission revoked mid-session removes the icon
   * immediately rather than at next login.
   */
  protected readonly visiblePanels = computed<readonly PanelDefinition[]>(() => {
    this.session.policy(); // establish the dependency; the check reads it internally
    return PANELS.filter((panel) => this.permissions.can(panel.permission));
  });

  protected startResize(event: PointerEvent): void {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const startX = event.clientX;
    const startWidth = this.sideBarWidth();

    // Pointer capture keeps the drag alive when the cursor outruns the 4px divider — without it
    // a fast drag simply stops.
    target.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent): void => this.setWidth(startWidth + (e.clientX - startX));
    const up = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  protected onResizeKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 50 : 10;
    if (event.key === 'ArrowLeft') this.setWidth(this.sideBarWidth() - step);
    else if (event.key === 'ArrowRight') this.setWidth(this.sideBarWidth() + step);
    else return;
    event.preventDefault();
  }

  private setWidth(width: number): void {
    this.sideBarWidth.set(Math.max(MIN_SIDE_BAR, Math.min(MAX_SIDE_BAR, Math.round(width))));
  }

  protected onLocaleChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    if (select.value === 'en' || select.value === 'ar') {
      this.locale.setLocale(select.value);
    }
  }
}
