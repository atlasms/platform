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
import { TransferTray } from './transfer-tray.ts';

const MIN_SIDE_BAR = 160;
const MAX_SIDE_BAR = 640;

/**
 * The workbench frame — Activity Bar, Primary Side Bar, Editor Area, Status Bar
 * ([studio-frontend.md §1.1](../../../../../docs/architecture/studio-frontend.md)).
 *
 * The routed panel renders in the **side bar**, not the editor area: the activity bar switches
 * which panel's views are shown, while the editor area is tabbed and holds whatever the user
 * opened from them. That separation is the whole point of the workbench model.
 *
 * The frame exists only for a session: it is the component of the guarded parent route in
 * app.routes.ts, so a signed-out caller never sees it — the sign-in screen is full-screen, not a
 * side-bar panel.
 */
@Component({
  selector: 'atlas-workbench',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterOutlet, EditorArea, TransferTray],
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
            [title]="panelTitle(panel)"
            (click)="panel.available && activePanelId.set(panel.id)"
          >
            <span aria-hidden="true">{{ panel.icon }}</span>
            <span class="sr-only">{{ locale.t(panel.titleKey) }}</span>
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

      <!-- Bottom corner, over the frame (studio-frontend.md §1.1): uploads outlive the panel that
           started them, so their progress lives here, not in Ingest. -->
      <atlas-transfer-tray />

      <!-- The workbench is only routed with a session (app.routes.ts), so the status bar has a
           user to name; the signals stay optional only because the spec builds the frame bare. -->
      <footer class="status-bar">
        <span>{{ session.userId() ?? '—' }}</span>
        <span class="sep">·</span>
        <span>{{ locale.t('workbench.statusBar.channel') }} {{ session.channelId() ?? '—' }}</span>
        @if (session.isAuthenticated()) {
          <span class="sep">·</span>
          <!-- Live updates, or the polling fallback while the socket is down (NFR-AVAIL-7). -->
          <span class="live" [class.degraded]="ws.degraded()" [title]="ws.lastError() ?? ''">
            {{
              locale.t(ws.degraded() ? 'workbench.statusBar.polling' : 'workbench.statusBar.live')
            }}
          </span>
        }
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
  protected readonly ws = inject(WebSocketService);
  private readonly router = inject(Router);

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    // Navigate explicitly rather than relying on the guard: the guard only runs on the NEXT
    // navigation, so without this the workbench would sit there rendering a session that is gone.
    // Leaving the shell's routes unmounts the whole frame; /signin is full-screen.
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
    return PANELS.filter((panel) => this.permissions.canAny(panel.permission));
  });

  /** The icon's tooltip: the translated name, and for an unbuilt panel, why it does nothing. */
  protected panelTitle(panel: PanelDefinition): string {
    const name = this.locale.t(panel.titleKey);
    return panel.available ? name : `${name} — ${this.locale.t('workbench.panels.notBuilt')}`;
  }

  /**
   * +1 in LTR, −1 in RTL.
   *
   * The workbench is a CSS grid, and grid tracks are laid out along the INLINE axis — so under
   * `dir="rtl"` the activity bar and side bar sit on the right and the divider's "grow" direction
   * is leftwards. Without this, EP-11.6's Arabic mode has a side bar that shrinks when you drag it
   * open, and ArrowRight narrows the panel it is pointing away from.
   */
  private get inlineSign(): 1 | -1 {
    return this.locale.direction() === 'rtl' ? -1 : 1;
  }

  protected startResize(event: PointerEvent): void {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const startX = event.clientX;
    const startWidth = this.sideBarWidth();
    const sign = this.inlineSign;

    // Pointer capture keeps the drag alive when the cursor outruns the 4px divider — without it
    // a fast drag simply stops.
    target.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent): void => this.setWidth(startWidth + sign * (e.clientX - startX));
    const up = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  protected onResizeKey(event: KeyboardEvent): void {
    const step = (event.shiftKey ? 50 : 10) * this.inlineSign;
    // The keys stay PHYSICAL — ArrowRight moves the divider right on screen — because that is what
    // a separator's arrow keys mean to a screen-reader user in either direction. Which side of the
    // divider that grows is what flips.
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
      // `void`: the switch is already reflected by `locale.loading()` on the control, so there is
      // nothing to await here — but an unmarked floating promise reads like a forgotten one.
      void this.locale.setLocale(select.value);
    }
  }
}
