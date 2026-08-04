import { Directive, effect, inject, input, TemplateRef, ViewContainerRef } from '@angular/core';
import type { ResourceContext } from '@atlas/policy';
import { PermissionService } from './permission.service.ts';

/**
 * Render content only if the user holds a permission.
 *
 * ```html
 * <button *atlasIfCan="'asset:write'">New asset</button>
 *
 * <button *atlasIfCan="'asset:write'; resource: { categoryPath: asset.categoryPath }">Edit</button>
 *
 * <!-- irreversible: require the full context to be satisfied -->
 * <button *atlasIfCan="'asset:delete'; resource: ctx; strict: true">Delete</button>
 *
 * <div *atlasIfCan="'schedule:read'; else: noAccess">…</div>
 * <ng-template #noAccess>You do not have access to scheduling.</ng-template>
 * ```
 *
 * Re-evaluates whenever the policy changes, so a permission revoked mid-session removes the
 * control without a reload — matching the WebSocket `permissions.changed` handling on the server
 * side.
 *
 * **This hides UI; it does not protect anything.** The owning service re-checks every request.
 */
@Directive({ selector: '[atlasIfCan]' })
export class IfCanDirective {
  private readonly template = inject(TemplateRef<unknown>);
  private readonly container = inject(ViewContainerRef);
  private readonly permissions = inject(PermissionService);

  readonly permission = input.required<string>({ alias: 'atlasIfCan' });
  readonly resource = input<ResourceContext | undefined>(undefined, {
    alias: 'atlasIfCanResource',
  });
  readonly strict = input(false, { alias: 'atlasIfCanStrict' });
  readonly fallback = input<TemplateRef<unknown> | null>(null, { alias: 'atlasIfCanElse' });

  constructor() {
    effect(() => {
      const permission = this.permission();
      const resource = this.resource();
      const allowed =
        this.strict() && resource !== undefined
          ? this.permissions.canStrict(permission, resource)
          : this.permissions.can(permission, resource);

      this.container.clear();
      if (allowed) {
        this.container.createEmbeddedView(this.template);
        return;
      }
      const fallback = this.fallback();
      if (fallback) this.container.createEmbeddedView(fallback);
    });
  }
}
