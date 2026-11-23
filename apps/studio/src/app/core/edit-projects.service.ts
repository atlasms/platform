import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { ApiClient } from './api-client.ts';
import type { EditProject } from './generated/mam.types.ts';
import { MamOperations as ops } from './generated/mam.operations.ts';

/** The timeline a save sends — the project's own shape, clip by clip. */
export type Timeline = EditProject['timeline'];

/**
 * The media editor's projects, on MAM through the gateway (EP-26.2/26.3; media-editor.md §4–5).
 * `asset:read` to list and load; `asset:write` on the source's `core` to start, save and render —
 * MAM enforces both, the UI only decides what to offer.
 */
@Injectable({ providedIn: 'root' })
export class EditProjectsService {
  private readonly api = inject(ApiClient);

  /** The asset's projects, newest first. */
  forAsset(assetId: string) {
    return this.api
      .call(ops.listEditProjects, { params: { id: assetId } })
      .as<{ items: EditProject[] }>()
      .pipe(map((body) => body.items));
  }

  /** A new, empty draft over the asset. */
  create(assetId: string) {
    return this.api.call(ops.createEditProject, { params: { id: assetId } }).as<EditProject>();
  }

  get(id: string) {
    return this.api.call(ops.getEditProject, { params: { id } }).as<EditProject>();
  }

  /** Compare-and-set on the version read: 409 when someone saved since; 422 names each problem. */
  save(id: string, version: number, body: { timeline: Timeline; outputProfile?: string }) {
    return this.api
      .call(ops.updateEditProject, { params: { id }, query: { version }, body })
      .as<EditProject>();
  }

  /**
   * Flatten the timeline: MAM answers `rendering` with the `outputAssetId` the render becomes, and
   * with a `targetAssetId` the render becomes that asset's next version (media-editor.md §5.1).
   */
  render(id: string, body: { outputProfile?: string; targetAssetId?: string }) {
    return this.api.call(ops.renderEditProject, { params: { id }, body }).as<EditProject>();
  }
}
