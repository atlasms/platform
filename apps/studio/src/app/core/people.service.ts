import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { CreatePersonInput, Person, UpdatePersonInput } from './generated/mam.types.ts';
import { MamOperations as ops } from './generated/mam.operations.ts';

/**
 * MAM's people register, through the gateway (EP-28.5): a name and an optional image reference —
 * nothing else about a person is kept (FR-PPL-2). Writes are a compare-and-set on the version read.
 */
@Injectable({ providedIn: 'root' })
export class PeopleService {
  private readonly api = inject(ApiClient);

  list(includeDeprecated = false) {
    return this.api
      .call(ops.listPeople, { query: includeDeprecated ? { includeDeprecated } : {} })
      .as<Person[]>();
  }

  create(input: CreatePersonInput) {
    return this.api.call(ops.createPerson, { body: input }).as<Person>();
  }

  update(id: string, version: number, input: UpdatePersonInput) {
    return this.api
      .call(ops.updatePerson, { params: { id }, query: { version }, body: input })
      .as<Person>();
  }
}
