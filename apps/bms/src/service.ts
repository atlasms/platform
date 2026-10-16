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

import { createHash } from 'node:crypto';
import { delta, isUlid, ulid, type EventPayloads } from '@atlas/contracts';
import {
  validateDefinition,
  WORKFLOW_COMMANDS,
  type CommandConfig,
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
import {
  definitionOf,
  type DraftInput,
  type Workflow,
  type WorkflowState,
  type WorkflowVersion,
} from './workflow.ts';

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
  state: WorkflowState;
  version: number;
  publishedAt: string;
  revision: number;
  warnings?: ValidationIssue[];
}

/** One active workflow in the catalog (bms.yaml `CatalogEntry`). */
export interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  scope?: Workflow['scope'];
  revision: number;
  version: number;
  definition: WorkflowDefinition;
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
    options: { state?: WorkflowState; after?: string; limit?: number } = {},
  ): Promise<{ items: Workflow[]; nextCursor?: string }> {
    this.authorizeRead(caller);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const items = await this.store.list(caller.channelId, {
      ...(options.state !== undefined ? { state: options.state } : {}),
      ...(options.after !== undefined ? { after: options.after } : {}),
      limit,
    });
    const last = items[items.length - 1];
    return { items, ...(items.length === limit && last ? { nextCursor: last.id } : {}) };
  }

  /**
   * Every ACTIVE workflow of the channel with the definition a new instance runs — the copy every
   * authenticated user's client loads at sign-in (EP-22.11). No workflow permission: an active
   * workflow is visible to everyone in its channel (decided 2026-10-13); drafts, inactive and
   * archived workflows stay behind `workflow:read`/`:admin`. The ETag is a hash of each entry's id
   * and revision — every change to an entry bumps its revision — so an unchanged catalog is a 304.
   */
  async catalog(
    caller: Pick<Caller, 'channelId'>,
  ): Promise<{ etag: string; items: CatalogEntry[] }> {
    const headers: Workflow[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.store.list(caller.channelId, {
        state: 'active',
        ...(after !== undefined ? { after } : {}),
        limit: 200,
      });
      headers.push(...page);
      if (page.length < 200) break;
      after = page[page.length - 1]?.id;
    }
    const items: CatalogEntry[] = [];
    for (const w of headers) {
      const version = await this.store.version(w.id, w.latestVersion);
      if (!version || version.status !== 'published') continue;
      items.push({
        id: w.id,
        name: w.name,
        ...(w.description !== undefined ? { description: w.description } : {}),
        ...(w.scope !== undefined ? { scope: w.scope } : {}),
        revision: w.revision,
        version: version.version,
        definition: version.definition,
      });
    }
    const etag = `"${createHash('sha256')
      .update(items.map((i) => `${i.id}:${i.revision}`).join(','))
      .digest('base64url')
      .slice(0, 27)}"`;
    return { etag, items };
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
      state: 'draft',
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
    if (before.state === 'archived') throw new Conflict(`workflow ${id} is archived`);
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
    if (before.state === 'archived') throw new Conflict(`workflow ${id} is archived`);
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
    this.vouch(caller, draft.definition);

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
    // A first publish makes the workflow active; a later one leaves its state alone — publishing a
    // new version of an inactive workflow does not quietly reactivate it.
    const after: Workflow = {
      ...rest,
      state: before.state === 'draft' ? 'active' : before.state,
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
          {
            latestVersion: before.latestVersion,
            draftVersion: before.draftVersion,
            state: before.state,
          },
          {
            latestVersion: after.latestVersion,
            publishedVersion: draft.version,
            state: after.state,
          },
        ),
      );
      await tx.enqueue(this.changed(caller, after, 'published'));
    });
    const warnings = result.issues.filter((i) => i.severity === 'warning');
    return {
      workflowId: id,
      state: after.state,
      version: draft.version,
      publishedAt: at,
      revision: after.revision,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // --- the lifecycle (EP-22.11) ------------------------------------------------------------------------

  /**
   * inactive → active: back in the catalog, able to start instances. Activating makes a definition
   * runnable again, so the activator vouches for its commands as a publisher does.
   */
  async activate(caller: Caller, id: string, revision: number): Promise<WorkflowView> {
    const current = await this.header(caller, id);
    const latest =
      current.latestVersion > 0 ? await this.store.version(id, current.latestVersion) : undefined;
    if (latest) this.vouch(caller, latest.definition);
    return this.transition(caller, id, revision, 'activated', (w) => {
      if (w.state !== 'inactive')
        throw new Conflict(
          w.state === 'draft'
            ? `workflow ${id} is a draft — publishing it makes it active`
            : `workflow ${id} is ${w.state}, not inactive`,
        );
      return 'active';
    });
  }

  /** active → inactive: out of the catalog, no new instances. Refused while instances run. */
  async deactivate(caller: Caller, id: string, revision: number): Promise<WorkflowView> {
    return this.transition(caller, id, revision, 'deactivated', (w) => {
      if (w.state !== 'active') throw new Conflict(`workflow ${id} is ${w.state}, not active`);
      return 'inactive';
    });
  }

  /** Any state but archived → archived, for good. Refused while instances run. */
  async archive(caller: Caller, id: string, revision: number): Promise<WorkflowView> {
    return this.transition(caller, id, revision, 'archived', (w) => {
      if (w.state === 'archived') throw new Conflict(`workflow ${id} is already archived`);
      return 'archived';
    });
  }

  /**
   * One state change, compare-and-set on `revision`, under the header's row lock. Deactivating and
   * archiving count the workflow's live instances INSIDE that lock — and a start takes the same
   * lock to check the state — so "no instance is running" holds at the moment of the change, not
   * merely a moment before it (decided 2026-10-13).
   */
  private async transition(
    caller: Caller,
    id: string,
    revision: number,
    change: 'activated' | 'deactivated' | 'archived',
    next: (w: Workflow) => WorkflowState,
  ): Promise<WorkflowView> {
    this.authorizeAdmin(caller);
    await this.header(caller, id); // 404 for another channel's id, before any lock
    await this.store.transaction(async (tx) => {
      const before = await tx.workflowForUpdate(id);
      if (!before || before.channelId !== caller.channelId) throw new NotFound(`workflow ${id}`);
      if (before.revision !== revision) throw this.stale(id);
      const state = next(before);
      if (change !== 'activated') {
        const running = await tx.liveInstances(id);
        if (running > 0)
          throw new Conflict(
            `workflow ${id} has ${running} instance${running === 1 ? '' : 's'} still running — it cannot be ${change} until ${running === 1 ? 'it ends' : 'they end'}`,
            { running },
          );
      }
      const after: Workflow = {
        ...before,
        state,
        revision: revision + 1,
        updatedAt: this.now().toISOString(),
      };
      if (!(await tx.put(after, revision))) throw this.stale(id);
      await tx.enqueue(
        this.audit(caller, after, `workflow.${change}`, { state: before.state }, { state }),
      );
      await tx.enqueue(this.changed(caller, after, change));
    });
    return this.get(caller, id);
  }

  /** `workflow.changed` — what every client's catalog copy refreshes on (EP-22.11). */
  private changed(
    caller: Caller,
    w: Workflow,
    change: 'published' | 'activated' | 'deactivated' | 'archived',
  ): ReturnType<typeof outboxRecord> {
    const headers = this.traceHeaders();
    return outboxRecord(
      'workflow.changed',
      w.channelId,
      {
        workflowId: w.id,
        change,
        state: w.state,
        latestVersion: w.latestVersion,
        revision: w.revision,
        name: w.name,
      } satisfies EventPayloads['workflow.changed'],
      {
        actor: { kind: 'user', id: caller.userId },
        ...(caller.correlationId !== undefined ? { correlationId: caller.correlationId } : {}),
        ...(headers !== undefined ? { headers } : {}),
      },
    );
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
    if (header.state !== 'active')
      throw new Conflict(
        `workflow ${header.id} is ${header.state} — only an active workflow starts`,
      );
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
      // Under the header's lock, the same one deactivate and archive take: either this start sees
      // the workflow still active and they then see this instance running, or they won.
      const locked = await tx.workflowForUpdate(header.id);
      if (locked?.state !== 'active')
        throw new Conflict(
          `workflow ${header.id} is ${locked?.state ?? 'gone'} — only an active workflow starts`,
        );
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
      // Uncorrelated: a person's signal completes whatever the step is waiting for.
      await this.runner.signal(id, { stepId, payload });
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
  /**
   * A command step carries its PUBLISHER's authority (decided 2026-10-16). BMS issues a command as
   * itself and the target trusts its issuer — MTS's broker path checks nobody — so without this, a
   * person allowed only to START a workflow could make MTS rewrite any asset's renditions, which
   * over HTTP takes `asset:write` on `files`. Whoever makes a definition runnable (publish,
   * activate) must hold every command's `requires`, channel-wide and strictly: an instance may run
   * on any asset of the channel, so a grant narrowed to a category does not vouch for it.
   */
  private vouch(caller: Caller, definition: WorkflowDefinition): void {
    for (const step of definition.steps) {
      if (step.kind !== 'command') continue;
      const event = (step.config as CommandConfig).request.event;
      const requires = WORKFLOW_COMMANDS[event]?.requires;
      if (!requires) continue; // an unknown command is the validator's to refuse
      const decision = canEnforce(caller.policy, requires.permission, {
        ...requires.resource,
        channelId: caller.channelId,
      });
      if (!decision.allowed)
        throw new Forbidden(
          `step "${step.id}" issues ${event}, which needs ${requires.permission}` +
            `${requires.resource.fieldGroup !== undefined ? ` on ${requires.resource.fieldGroup}` : ''}` +
            ` across the channel: whoever publishes or activates the workflow vouches for it`,
        );
    }
  }

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
      } else if (target.state === 'inactive' || target.state === 'archived') {
        issues.push({
          severity: 'error',
          code: 'SUBFLOW_INACTIVE',
          message: `sub-flow "${step.id}" names workflow "${target.name}", which is ${target.state}`,
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
