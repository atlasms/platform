import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { Group, GroupInput, GroupWithMembers } from './generated/iam.types.ts';
import { IamOperations as ops } from './generated/iam.operations.ts';

/**
 * IAM's groups, through the gateway (the Admin panel's Groups view, over EP-10.6). A group is a
 * named set of members that carries rules and roles; a change to its grants reaches every
 * member (`permissions.changed`). `user:admin` in the group's channel for everything here.
 */
@Injectable({ providedIn: 'root' })
export class GroupsService {
  private readonly api = inject(ApiClient);

  list() {
    return this.api.call(ops.listGroups).as<Group[]>();
  }

  get(id: string) {
    return this.api.call(ops.getGroup, { params: { id } }).as<GroupWithMembers>();
  }

  create(input: GroupInput) {
    return this.api.call(ops.createGroup, { body: input }).as<Group>();
  }

  update(id: string, patch: GroupInput) {
    return this.api.call(ops.updateGroup, { params: { id }, body: patch }).as<Group>();
  }

  /** Every member is removed first, each a `group.membership.changed`. */
  delete(id: string) {
    return this.api.call(ops.deleteGroup, { params: { id } }).as<void>();
  }

  addMember(id: string, userId: string) {
    return this.api.call(ops.addGroupMember, { params: { id }, body: { userId } }).as<void>();
  }

  removeMember(id: string, userId: string) {
    return this.api.call(ops.removeGroupMember, { params: { id }, query: { userId } }).as<void>();
  }
}
