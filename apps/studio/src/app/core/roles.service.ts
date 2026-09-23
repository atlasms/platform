import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { Role, RoleHolders, RoleInput } from './generated/iam.types.ts';
import { IamOperations as ops } from './generated/iam.operations.ts';

/**
 * IAM's roles, through the gateway (the Admin panel's Roles view, over EP-10.4). A role is a
 * named bundle of rules; editing it edits it for every holder, directly or through a group.
 * The platform-wide starter roles are listed with the channel's and are not this channel's to
 * edit — IAM says so with a 403. `user:admin` for everything here.
 */
@Injectable({ providedIn: 'root' })
export class RolesService {
  private readonly api = inject(ApiClient);

  list() {
    return this.api.call(ops.listRoles).as<Role[]>();
  }

  get(id: string) {
    return this.api.call(ops.getRole, { params: { id } }).as<Role>();
  }

  create(input: RoleInput) {
    return this.api.call(ops.createRole, { body: input }).as<Role>();
  }

  update(id: string, patch: RoleInput) {
    return this.api.call(ops.updateRole, { params: { id }, body: patch }).as<Role>();
  }

  /**
   * Who the role reaches — the groups that carry it, and every user, by any path.
   *
   * A direct holder's row carries the id of the grant itself, so revoking one is a single call
   * and never a read of that user's whole assignment list first.
   */
  holders(id: string) {
    return this.api.call(ops.listRoleHolders, { params: { id } }).as<RoleHolders>();
  }

  /** 409 while an assignment or a group still carries it. */
  delete(id: string) {
    return this.api.call(ops.deleteRole, { params: { id } }).as<void>();
  }
}
