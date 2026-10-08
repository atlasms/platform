import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { Category, CreateCategoryInput, UpdateCategoryInput } from './generated/mam.types.ts';
import { MamOperations as ops } from './generated/mam.operations.ts';

/**
 * MAM's category tree, through the gateway (#260; data-model.md §2.6). Read under
 * `taxonomy:read`; written under `taxonomy:admin` over the node's path. A change names the
 * `version` it was read at — a 409 is a reload, never a retry. A path is built from KEYS, which
 * never change; a move re-roots a subtree, and grants scoped by path follow the new position.
 */
@Injectable({ providedIn: 'root' })
export class CategoriesService {
  private readonly api = inject(ApiClient);

  /** The channel's tree, flat, in path order; the live part unless `includeDeprecated`. */
  list(includeDeprecated = false) {
    return this.api
      .call(ops.listCategories, { query: includeDeprecated ? { includeDeprecated } : {} })
      .as<Category[]>();
  }

  get(id: string) {
    return this.api.call(ops.getCategory, { params: { id } }).as<Category>();
  }

  create(input: CreateCategoryInput) {
    return this.api.call(ops.createCategory, { body: input }).as<Category>();
  }

  update(id: string, version: number, input: UpdateCategoryInput) {
    return this.api
      .call(ops.updateCategory, { params: { id }, query: { version }, body: input })
      .as<Category>();
  }

  move(id: string, parentId: string | null, version: number) {
    return this.api
      .call(ops.moveCategory, { params: { id }, body: { parentId, version } })
      .as<Category>();
  }
}
