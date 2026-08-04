import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { PermissionService } from '../core/permission.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { PANELS, type PanelDefinition } from './panels.ts';

/**
 * The workbench frame — Activity Bar, Primary Side Bar, Editor Area, Status Bar
 * ([studio-frontend.md §1.1](../../../../../docs/architecture/studio-frontend.md)).
 *
 * SCOPE: this is the static frame (EP-11.1) with permission-driven navigation (EP-11.7). The
 * *interactive* workbench — tabbed and splittable editor groups, drag between groups, resizable
 * and reorderable views, workspace persistence — is **EP-11.3** and is not built here. The editor
 * area is currently a single router outlet.
 */
@Component({
  selector: 'atlas-workbench',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterOutlet],
  template: `
    <div class="workbench">
      <nav class="activity-bar" aria-label="Panels">
        @for (panel of visiblePanels(); track panel.id) {
          <a
            class="activity-item"
            [class.disabled]="!panel.available"
            [routerLink]="panel.available ? panel.route : null"
            [attr.aria-disabled]="!panel.available"
            [title]="panel.available ? panel.title : panel.title + ' — not built yet'"
          >
            <span aria-hidden="true">{{ panel.icon }}</span>
            <span class="sr-only">{{ panel.title }}</span>
          </a>
        } @empty {
          <p class="empty" title="No panel matches your permissions">∅</p>
        }
      </nav>

      <aside class="side-bar" aria-label="Primary side bar">
        <h2>{{ activePanel()?.title ?? 'Studio' }}</h2>
        <p class="muted">Views land here — EP-11.3.</p>
      </aside>

      <main class="editor-area">
        <router-outlet />
      </main>

      <footer class="status-bar">
        <span>{{ session.userId() ?? 'signed out' }}</span>
        <span class="sep">·</span>
        <span>channel {{ session.channelId() ?? '—' }}</span>
        <span class="spacer"></span>
        <span>{{ visiblePanels().length }} of {{ allPanels.length }} panels visible</span>
      </footer>
    </div>
  `,
  styleUrl: './workbench.scss',
})
export class Workbench {
  protected readonly session = inject(SessionStore);
  private readonly permissions = inject(PermissionService);

  protected readonly allPanels = PANELS;
  protected readonly activePanelId = signal<string | null>(null);

  /**
   * Panels the user may see.
   *
   * A `computed` over the policy signal, so a permission revoked mid-session removes the icon
   * immediately rather than at next login.
   */
  protected readonly visiblePanels = computed<readonly PanelDefinition[]>(() => {
    this.session.policy(); // establish the dependency; the check itself reads it internally
    return PANELS.filter((panel) => this.permissions.can(panel.permission));
  });

  protected readonly activePanel = computed(() => {
    const id = this.activePanelId();
    return this.visiblePanels().find((p) => p.id === id) ?? this.visiblePanels()[0];
  });
}
