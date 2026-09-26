import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { AcceptanceRuleSet, AcceptanceRuleSetInput } from './generated/rim.types.ts';
import { RimOperations as ops } from './generated/rim.operations.ts';

/**
 * RIM's acceptance rule sets, through the gateway (EP-15.3). A set applies to every job, to one
 * source kind, or to one source (a folder watcher, EP-15.2); every job it applies to is held to
 * its rules, and the worst failure decides — `reject` beats `quarantine`. `ingest:admin`.
 *
 * RIM refuses a set with a 422 naming the first thing wrong (`rules[2].bytes must be…`).
 */
@Injectable({ providedIn: 'root' })
export class RulesService {
  private readonly api = inject(ApiClient);

  list() {
    return this.api.call(ops.listAcceptanceRules).as<AcceptanceRuleSet[]>();
  }

  get(id: string) {
    return this.api.call(ops.getAcceptanceRules, { params: { id } }).as<AcceptanceRuleSet>();
  }

  create(input: AcceptanceRuleSetInput) {
    return this.api.call(ops.createAcceptanceRules, { body: input }).as<AcceptanceRuleSet>();
  }

  /** The whole set, as given — RIM replaces it and bumps `version`. */
  replace(id: string, input: AcceptanceRuleSetInput) {
    return this.api
      .call(ops.replaceAcceptanceRules, { params: { id }, body: input })
      .as<AcceptanceRuleSet>();
  }

  /** Gone from validation at once; jobs it already held keep their reason and ruleSetId. */
  delete(id: string) {
    return this.api.call(ops.deleteAcceptanceRules, { params: { id } }).as<void>();
  }
}
