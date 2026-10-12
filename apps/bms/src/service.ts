// Workflow definitions (EP-22.2): author a draft, validate it, publish it as an immutable version.
//
// The design is bms-workflow-dsl-and-designer.md §6–§8. A draft is work in progress and is SAVED
// whatever it holds — the designer saves as the author works; publish is the gate, and it refuses
// anything `validateDefinition` (@atlas/contracts/workflow: the schema, the graph rules, the
// restricted FEEL subset) or the sub-flow check below calls an error. Every write is
// compare-and-set on the workflow's `revision`, and commits its `audit.recorded` (with the
// field-level delta) through the outbox in the same transaction (AGENTS.md §5.4, §5.6).
//
// Running instances are EP-22.3's, on Temporal (ADR-0010); they pin a published version, which is
// why a published version is never written again.

import { delta, isUlid, ulid, type EventPayloads } from '@atlas/contracts';
import {
  validateDefinition,
  type SubFlowConfig,
  type ValidationIssue,
  type ValidationResult,
  type WorkflowDefinition,
} from '@atlas/contracts/workflow';
import { canEnforce, type EffectivePolicy } from '@atlas/policy';
import { Conflict, Forbidden, NotFound, Unavailable, ValidationError } from '@atlas/service-kit';
import { isTerminal, type HistoryEntry, type Instance } from './instance.ts';
import { outboxRecord } from './record.ts';
import type { InstanceRunner } from './runner.ts';
import { instanceAudit } from './runtime.ts';
import type { WorkflowStore } from './store.ts';
import { definitionOf, type DraftInput, type Workflow, type WorkflowVersion } from './workflow.ts';

export interface Caller {
  userId: string;
  channelId: string;
  policy: EffectivePolicy;
  correlationId?: string;
}

/** What `GET /workflows/{id}` answers (bms.yaml `Workflow`). */
export interface WorkflowView extends Workflow {
  draft?: WorkflowDefinition;
  versions: { version: number; publishedAt: string; publishedBy: string }[];
}

export interface PublishResult {
  workflowId: string;
  version: number;
  publishedAt: string;
  revision: number;
  warnings?: ValidationIssue[];
}

export interface StartInstanceInput {
  workflowId: string;
  version?: number;
  vars?: Record<string, unknown>;
  assetId?: string;
}

export interface BmsServiceOptions {
  store: WorkflowStore;
  /** Starts and signals instances — Temporal in production (ADR-0010). Omitted: none can start. */
  runner?: InstanceRunner;
  /** Why the runtime refused — the log's business; the caller gets a 503. */
  onRunnerError?: (err: unknown, context: { instanceId: string; action: string }) => void;
  now?: () => Date;
  /** Trace context captured into the event where it is created (EP-13.3). */
  traceHeaders?: () => Record<string, string> | undefined;
}

// `revision` IS the audit record's revision; `updatedAt` changes on every write.
const NOT_IN_DELTA: ReadonlySet<string> = new Set(['revision', 'updatedAt']);

export class BmsService {
  private readonly store: WorkflowStore;
  private readonly runner: InstanceRunner | undefined;
  private readonly onRunnerError: NonNullable<BmsServiceOptions['onRunnerError']>;
  private readonly now: () => Date;
  private readonly traceHeaders: () => Record<string, string> | undefined;

  constructor(options: BmsServiceOptions) {
    this.store = options.store;
    this.runner = options.runner;
    this.onRunnerError = options.onRunnerError ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.traceHeaders = options.traceHeaders ?? (() => undefined);
  }

  // --- reads ---------------------------------------------------------------------------------------------

  async list(
    caller: Caller,
    options: { after?: string; limit?: number } = {},
  ): Promise<{ items: Workflow[]; nextCursor?: string }> {
    this.authorizeRead(caller);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const items = await this.store.list(caller.channelId, {
      ...(options.after !== undefined ? { after: options.after } : {}),
      limit,
    });
    const last = items[items.length - 1];
    return { items, ...(items.length === limit && last ? { nextCursor: last.id } : {}) };
  }

  async get(caller: Caller, id: string): Promise<WorkflowView> {
    this.authorizeRead(caller);
    const workflow = await this.header(caller, id);
    const draft =
      workflow.draftVersion !== undefined
        ? await this.store.version(id, workflow.draftVersion)
        : undefined;
    const published = await this.store.published(id);
    return {
      ...workflow,
      ...(draft ? { draft: draft.definition } : {}),
      versions: published.map((v) => ({
        version: v.version,
        publishedAt: v.publishedAt ?? v.createdAt,
        publishedBy: v.publishedBy ?? v.createdBy,
      })),
    };
  }

  async version(caller: Caller, id: string, version: number): Promise<WorkflowDefinition> {
    this.authorizeRead(caller);
    await this.header(caller, id);
    const v = await this.store.version(id, version);
    if (!v) throw new NotFound(`workflow ${id} version ${version}`);
    return v.definition;
  }

  // --- authoring -----------------------------------------------------------------------------------------

  async create(caller: Caller, input: DraftInput): Promise<WorkflowView> {
    this.authorizeAdmin(caller);
    const at = this.now().toISOString();
    const workflow: Workflow = {
      id: ulid(),
      channelId: caller.channelId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      revision: 1,
      latestVersion: 0,
      draftVersion: 1,
      createdBy: caller.userId,
      createdAt: at,
      updatedAt: at,
    };
    const draft = this.draftRow(caller, workflow, 1, input, at);
    await this.store.transaction(async (tx) => {
      if (!(await tx.put(workflow))) throw new Conflict(`workflow ${workflow.id} already exists`);
      await tx.putVersion(draft);
      await tx.enqueue(
        this.audit(caller, workflow, 'workflow.created', undefined, snapshot(workflow, draft)),
      );
    });
    return { ...workflow, draft: draft.definition, versions: [] };
  }

  /**
   * Save the draft — the whole graph, as the designer holds it. With no open draft (the last one
   * was published) this opens one at the next version. Compare-and-set on `revision`.
   */
  async saveDraft(
    caller: Caller,
    id: string,
    revision: number,
    input: DraftInput,
  ): Promise<WorkflowView> {
    this.authorizeAdmin(caller);
    const before = await this.header(caller, id);
    if (before.revision !== revision) throw this.stale(id);
    const priorDraft =
      before.draftVersion !== undefined
        ? await this.store.version(id, before.draftVersion)
        : undefined;
    const version = before.draftVersion ?? before.latestVersion + 1;
    const at = this.now().toISOString();
    const after: Workflow = {
      ...withHeaderFields(before, input),
      revision: revision + 1,
      draftVersion: version,
      updatedAt: at,
    };
    const draft = this.draftRow(caller, after, version, input, at, priorDraft);
    await this.store.transaction(async (tx) => {
      if (!(await tx.put(after, revision))) throw this.stale(id);
      if (!(await tx.putVersion(draft)))
        throw new Conflict(`workflow ${id} version ${version} is already published`);
      await tx.enqueue(
        this.audit(
          caller,
          after,
          'workflow.draft-saved',
          snapshot(before, priorDraft),
          snapshot(after, draft),
        ),
      );
    });
    return this.get(caller, id);
  }

  /**
   * Validate without saving — the body's graph, or with none the stored draft. The same rules
   * publish applies, so the designer's live feedback and the gate never disagree.
   */
  async validate(caller: Caller, id: string, input?: DraftInput): Promise<ValidationResult> {
    this.authorizeAdmin(caller);
    const workflow = await this.header(caller, id);
    if (input !== undefined) {
      const version = workflow.draftVersion ?? workflow.latestVersion + 1;
      return this.check(caller, definitionOf(workflow, version, input));
    }
    if (workflow.draftVersion === undefined)
      throw new Conflict(`workflow ${id} has no draft — send the graph to validate`);
    const draft = await this.store.version(id, workflow.draftVersion);
    if (!draft) throw new Conflict(`workflow ${id} draft ${workflow.draftVersion} is missing`);
    return this.check(caller, draft.definition);
  }

  /**
   * Publish the draft as an immutable version. Never publishes an invalid graph: the issues go back
   * in the 422's `details.issues`. Compare-and-set on `revision`, so what is published is exactly
   * the draft the author last saw.
   */
  async publish(caller: Caller, id: string, revision: number): Promise<PublishResult> {
    this.authorizeAdmin(caller);
    const before = await this.header(caller, id);
    if (before.revision !== revision) throw this.stale(id);
    if (before.draftVersion === undefined)
      throw new Conflict(`workflow ${id} has no draft to publish`);
    const draft = await this.store.version(id, before.draftVersion);
    if (!draft) throw new Conflict(`workflow ${id} draft ${before.draftVersion} is missing`);

    const result = await this.check(caller, draft.definition);
    if (!result.valid) {
      throw new ValidationError(`workflow ${id} draft ${draft.version} does not validate`, {
        issues: result.issues,
      });
    }

    const at = this.now().toISOString();
    const definition: WorkflowDefinition = {
      ...draft.definition,
      status: 'published',
      metadata: {
        ...(draft.definition.metadata ?? {}),
        publishedBy: caller.userId,
        publishedAt: at,
      },
    };
    const published: WorkflowVersion = {
      ...draft,
      status: 'published',
      definition,
      publishedBy: caller.userId,
      publishedAt: at,
    };
    const { draftVersion: _closed, ...rest } = before;
    const after: Workflow = {
      ...rest,
      revision: revision + 1,
      latestVersion: draft.version,
      updatedAt: at,
    };
    await this.store.transaction(async (tx) => {
      if (!(await tx.put(after, revision))) throw this.stale(id);
      if (!(await tx.putVersion(published)))
        throw new Conflict(`workflow ${id} version ${draft.version} is already published`);
      await tx.enqueue(
        this.audit(
          caller,
          after,
          'workflow.published',
          { latestVersion: before.latestVersion, draftVersion: before.draftVersion },
          { latestVersion: after.latestVersion, publishedVersion: draft.version },
        ),
      );
    });
    const warnings = result.issues.filter((i) => i.severity === 'warning');
    return {
      workflowId: id,
      version: draft.version,
      publishedAt: at,
      revision: after.revision,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // --- instances (EP-22.3) ----------------------------------------------------------------------------

  /**
   * Start an instance of a PUBLISHED version, pinned to it for its whole life. The mirror row and
   * its audit commit first; then the runtime is asked. If the runtime is away the row records that
   * it never ran — `failed`, with why — and the caller gets a 503, so a start that did not happen
   * is never a `running` row nobody runs.
   */
  async startInstance(caller: Caller, input: StartInstanceInput): Promise<Instance> {
    this.authorizeAct(caller);
    const header = await this.header(caller, input.workflowId);
    const version = input.version ?? header.latestVersion;
    const published = version > 0 ? await this.store.version(header.id, version) : undefined;
    if (!published || published.status !== 'published') {
      throw new Conflict(
        input.version === undefined
          ? `workflow ${header.id} has never been published`
          : `workflow ${header.id} has no published version ${version}`,
      );
    }
    if (!this.runner) throw new Unavailable('the workflow runtime is not configured');

    const instance: Instance = {
      id: ulid(),
      channelId: caller.channelId,
      workflowId: header.id,
      version: published.version,
      ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
      state: 'running',
      currentSteps: [],
      startedAt: this.now().toISOString(),
      startedBy: caller.userId,
    };
    await this.store.transaction(async (tx) => {
      await tx.insertInstance(instance);
      await tx.enqueue(
        instanceAudit(instance, 1, 'workflow-instance.started', undefined, {
          kind: 'user',
          id: caller.userId,
        }),
      );
    });
    try {
      await this.runner.start({
        definition: published.definition,
        start: {
          instanceId: instance.id,
          ...(input.vars !== undefined ? { vars: input.vars } : {}),
          ...(input.assetId !== undefined ? { incoming: { assetId: input.assetId } } : {}),
        },
      });
    } catch (err) {
      this.onRunnerError(err, { instanceId: instance.id, action: 'start' });
      const failed: Instance = {
        ...instance,
        state: 'failed',
        endedAt: this.now().toISOString(),
        error: 'the workflow runtime could not be reached; the instance never started',
      };
      await this.store.transaction(async (tx) => {
        await tx.putInstance(failed);
        await tx.enqueue(instanceAudit(failed, 2, 'workflow-instance.failed', instance));
      });
      throw new Unavailable('the workflow runtime could not be reached; nothing was started');
    }
    return instance;
  }

  async listInstances(
    caller: Caller,
    options: { workflowId?: string; after?: string; limit?: number } = {},
  ): Promise<{ items: Instance[]; nextCursor?: string }> {
    this.authorizeInstanceRead(caller);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const items = await this.store.instances(caller.channelId, {
      ...(options.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
      ...(options.after !== undefined ? { after: options.after } : {}),
      limit,
    });
    const last = items[items.length - 1];
    return { items, ...(items.length === limit && last ? { nextCursor: last.id } : {}) };
  }

  async getInstance(
    caller: Caller,
    id: string,
  ): Promise<Instance & { history: Omit<HistoryEntry, 'instanceId' | 'channelId'>[] }> {
    this.authorizeInstanceRead(caller);
    const instance = await this.instanceOf(caller, id);
    const history = (await this.store.history(id)).map(
      ({ instanceId: _i, channelId: _c, ...entry }) => entry,
    );
    return { ...instance, history };
  }

  /** Deliver a step's completion or event. A signal for a step not yet waiting is kept. */
  async signalInstance(
    caller: Caller,
    id: string,
    stepId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.authorizeAct(caller);
    const instance = await this.instanceOf(caller, id);
    if (isTerminal(instance.state))
      throw new Conflict(`instance ${id} has ended (${instance.state})`);
    if (!this.runner) throw new Unavailable('the workflow runtime is not configured');
    try {
      await this.runner.signal(id, stepId, payload);
    } catch (err) {
      this.onRunnerError(err, { instanceId: id, action: 'signal' });
      throw new Unavailable('the workflow runtime could not be reached');
    }
  }

  private async instanceOf(caller: Caller, id: string): Promise<Instance> {
    if (!isUlid(id)) throw new NotFound(`instance ${id}`);
    const instance = await this.store.instance(id);
    if (!instance || instance.channelId !== caller.channelId) throw new NotFound(`instance ${id}`);
    return instance;
  }

  /** Starting or moving an instance: `workflow:act` (the Editor's). */
  private authorizeAct(caller: Caller): void {
    const decision = canEnforce(caller.policy, 'workflow:act', { channelId: caller.channelId });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? 'workflow:act required');
  }

  /** Reading an instance: whoever may act in workflows, read them or administer them. */
  private authorizeInstanceRead(caller: Caller): void {
    const context = { channelId: caller.channelId };
    for (const p of ['workflow:read', 'workflow:act', 'workflow:admin'])
      if (canEnforce(caller.policy, p, context).allowed) return;
    throw new Forbidden('workflow:read, workflow:act or workflow:admin required');
  }

  // --- internals -----------------------------------------------------------------------------------------

  /** The pure rules, then what only the store knows: a sub-flow names a PUBLISHED workflow here. */
  private async check(caller: Caller, def: WorkflowDefinition): Promise<ValidationResult> {
    const result = validateDefinition(def);
    if (!result.valid && result.issues.some((i) => i.code === 'SCHEMA')) return result;
    const issues = [...result.issues];
    for (const step of def.steps) {
      if (step.kind !== 'sub-flow') continue;
      const cfg = step.config as SubFlowConfig;
      const target = await this.store.get(cfg.workflowId);
      // Another channel's workflow is "not a workflow" — the same answer a direct read gives.
      if (!target || target.channelId !== caller.channelId) {
        issues.push({
          severity: 'error',
          code: 'SUBFLOW_UNKNOWN',
          message: `sub-flow "${step.id}" names workflow ${cfg.workflowId}, which does not exist`,
          stepId: step.id,
        });
      } else if (target.latestVersion === 0) {
        issues.push({
          severity: 'error',
          code: 'SUBFLOW_UNPUBLISHED',
          message: `sub-flow "${step.id}" names workflow "${target.name}", which has never been published`,
          stepId: step.id,
        });
      } else if (typeof cfg.version === 'number' && cfg.version > target.latestVersion) {
        issues.push({
          severity: 'error',
          code: 'SUBFLOW_UNPUBLISHED',
          message: `sub-flow "${step.id}" pins version ${cfg.version} of "${target.name}", whose latest is ${target.latestVersion}`,
          stepId: step.id,
        });
      }
    }
    return { valid: !issues.some((i) => i.severity === 'error'), issues };
  }

  private async header(caller: Caller, id: string): Promise<Workflow> {
    const workflow = await this.store.get(id);
    // Another channel's workflow is "not found", not "forbidden": a 403 would confirm it exists.
    if (!workflow || workflow.channelId !== caller.channelId) throw new NotFound(`workflow ${id}`);
    return workflow;
  }

  private draftRow(
    caller: Caller,
    workflow: Workflow,
    version: number,
    input: DraftInput,
    at: string,
    prior?: WorkflowVersion,
  ): WorkflowVersion {
    const definition = definitionOf(workflow, version, input);
    const createdBy = prior?.createdBy ?? caller.userId;
    const createdAt = prior?.createdAt ?? at;
    return {
      workflowId: workflow.id,
      channelId: workflow.channelId,
      version,
      status: 'draft',
      definition: { ...definition, metadata: { createdBy, createdAt } },
      createdBy,
      createdAt,
    };
  }

  private stale(id: string): Conflict {
    return new Conflict(`workflow ${id} changed under this edit; reload it and try again`);
  }

  /** Reading a definition: `workflow:read`, or `workflow:admin` — who authors a flow may read it. */
  private authorizeRead(caller: Caller): void {
    const context = { channelId: caller.channelId };
    if (canEnforce(caller.policy, 'workflow:read', context).allowed) return;
    const admin = canEnforce(caller.policy, 'workflow:admin', context);
    if (!admin.allowed) throw new Forbidden(admin.reason ?? 'workflow:read required');
  }

  private authorizeAdmin(caller: Caller): void {
    const decision = canEnforce(caller.policy, 'workflow:admin', { channelId: caller.channelId });
    if (!decision.allowed) throw new Forbidden(decision.reason ?? 'workflow:admin required');
  }

  private audit(
    caller: Caller,
    workflow: Workflow,
    action: string,
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown>,
  ): ReturnType<typeof outboxRecord> {
    const headers = this.traceHeaders();
    return outboxRecord(
      'audit.recorded',
      workflow.channelId,
      {
        entityType: 'workflow',
        entityId: workflow.id,
        revision: workflow.revision,
        action,
        origin: { service: 'bms' },
        delta: delta(before, after, NOT_IN_DELTA),
      } satisfies EventPayloads['audit.recorded'],
      {
        actor: { kind: 'user', id: caller.userId },
        ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
        ...(headers !== undefined ? { headers } : {}),
      },
    );
  }
}

/** The header fields a draft's input carries — the header shows what the author is working on. */
function withHeaderFields(w: Workflow, input: DraftInput): Workflow {
  const { description: _d, scope: _s, ...rest } = w;
  return {
    ...rest,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  };
}

/** What a write's audit delta compares: the header, and the graph of the version it touched. */
function snapshot(w: Workflow, v?: WorkflowVersion): Record<string, unknown> {
  return {
    ...w,
    ...(v
      ? {
          vars: v.definition.vars,
          steps: v.definition.steps,
          transitions: v.definition.transitions,
        }
      : {}),
  };
}
