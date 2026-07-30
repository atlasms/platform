// Contract: docs/architecture/schemas/policy-rule.schema.json
// Semantics: docs/architecture/authorization-model.md §5 (normative)
//
// This file must stay free of Node built-ins and runtime dependencies — Studio imports it.

/** A permission is `resource:action`; either half may be the wildcard `*`. */
export type Permission = string;

/**
 * Predicates the resource context must satisfy.
 * **An omitted predicate means "any"** — it does not mean "none".
 */
export interface Scope {
  /** Channels this grant applies to. */
  channelIds?: string[];
  /**
   * Category-subtree scoping. Each entry is matched as a **prefix** of the resource's
   * materialized category path, so one grant covers a whole department/program branch.
   */
  categoryPaths?: string[];
  /** Resource lifecycle states this grant applies to, e.g. ["ready"]. */
  states?: string[];
  /** When true, only resources whose owner is the subject. */
  ownedOnly?: boolean;
}

/** The atomic grant. */
export interface Rule {
  id: string;
  description?: string;
  /** Base model is additive; `deny` is the optional extension (authorization-model.md §7). */
  effect?: 'allow' | 'deny';
  permissions: Permission[];
  scope?: Scope;
  /** Narrows a write-type permission to these field groups. **Omitted = all groups.** */
  fieldGroups?: string[];
}

/** A named, reusable bundle of rules. */
export interface Role {
  id: string;
  name?: string;
  rules: Rule[];
}

/** The flattened union of everything reachable from the subject, compiled once per permVersion. */
export interface EffectivePolicy {
  subjectId: string;
  /** Bumped on any grant/membership change; clients cache the compiled policy against it. */
  permVersion: number;
  rules: Rule[];
}

/**
 * What is being acted on. **Every field is optional**: omitting the context asks the broad
 * question *"could this subject do this at all?"* — see `can`.
 */
export interface ResourceContext {
  type?: string;
  channelId?: string;
  /** Materialized path, e.g. "/sports/football/highlights/". */
  categoryPath?: string;
  ownerId?: string;
  state?: string;
  /** Ask about one field group specifically, e.g. "rights". */
  fieldGroup?: string;
}

export interface Decision {
  allowed: boolean;
  /**
   * Union of field groups granted by the matching rules.
   * **`undefined` when allowed means ALL groups** — some matching rule declared no
   * `fieldGroups`, which grants everything. It is never an empty array when allowed.
   */
  fieldGroups?: string[];
  /** Why, for logging and for the audited-denial requirement (FR-AUD-1). */
  reason?: string;
}

/** Input to `compile` — the raw assignments IAM holds for a subject. */
export interface CompileInput {
  subjectId: string;
  permVersion: number;
  /** Rules assigned directly to the user. */
  rules?: Rule[];
  /** Roles assigned directly to the user. */
  roles?: Role[];
  /** Groups the user belongs to, with their own rules and roles. */
  groups?: Array<{ id: string; rules?: Rule[]; roles?: Role[] }>;
}
