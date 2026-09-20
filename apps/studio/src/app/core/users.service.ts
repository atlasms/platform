import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type {
  Assignment,
  AssignmentInput,
  CreateUser,
  Role,
  UpdateUser,
  User,
  UserPage,
} from './generated/iam.types.ts';
import { IamOperations as ops } from './generated/iam.operations.ts';

/**
 * IAM's administration surface, through the gateway (EP-20.7 over EP-10.4/10.6).
 *
 * Every call needs `user:admin` in the user's channel — IAM enforces it; Studio only decides
 * what to show. Types and operations come from `generated/`, projected from
 * `docs/architecture/openapi/iam.yaml`.
 */
export interface UserListOptions {
  /** The last id already seen — keyset, like every list here. */
  after?: string;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class UsersService {
  private readonly api = inject(ApiClient);

  /** The users the caller may administer, one page by id. */
  list(options: UserListOptions = {}) {
    return this.api.call(ops.listUsers, { query: { ...options } }).as<UserPage>();
  }

  get(id: string) {
    return this.api.call(ops.getUser, { params: { id } }).as<User>();
  }

  /** Emits `user.created`; a taken username is a 409. */
  create(input: CreateUser) {
    return this.api.call(ops.createUser, { body: input }).as<User>();
  }

  /**
   * Profile, state or password. Disabling revokes every session and bumps `permVersion`;
   * `active` on a locked account is the unlock. Emits `user.updated`.
   */
  update(id: string, patch: UpdateUser) {
    return this.api.call(ops.updateUser, { params: { id }, body: patch }).as<User>();
  }

  /** The user's direct grants — roles by id and inline rules. Groups are not here (EP-10.6). */
  assignments(id: string) {
    return this.api.call(ops.listAssignments, { params: { id } }).as<Assignment[]>();
  }

  /** Grant a role or a rule; emits `permissions.changed`, which reaches the gateway at once. */
  grant(id: string, input: AssignmentInput) {
    return this.api.call(ops.createAssignment, { params: { id }, body: input }).as<Assignment>();
  }

  revoke(id: string, assignmentId: string) {
    return this.api.call(ops.deleteAssignment, { params: { id, assignmentId } }).as<void>();
  }

  /** The roles a grant can name: the channel's own and the platform-wide starter roles. */
  roles() {
    return this.api.call(ops.listRoles).as<Role[]>();
  }
}
