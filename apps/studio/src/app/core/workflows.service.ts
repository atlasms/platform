import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type {
  Catalog,
  DraftInput,
  InstancePage,
  PaletteEntry,
  PublishResult,
  ValidationResult,
  Workflow,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowPage,
} from './generated/bms.types.ts';
import { BmsOperations as ops } from './generated/bms.operations.ts';

/**
 * BMS's workflows, through the gateway. The catalog (EP-22.11) is every ACTIVE workflow of the
 * channel with its published definition — readable by every signed-in user, no workflow permission.
 * It carries an ETag with `Cache-Control: no-cache`, so the browser revalidates on its own and an
 * unchanged catalog costs a 304.
 */
@Injectable({ providedIn: 'root' })
export class WorkflowsService {
  private readonly api = inject(ApiClient);

  catalog() {
    return this.api.call(ops.getWorkflowCatalog).as<Catalog>();
  }

  /** The channel's workflows, newest first (`workflow:read` or `:admin`). */
  list(options: { after?: string; limit?: number } = {}) {
    return this.api.call(ops.listWorkflows, { query: { ...options } }).as<WorkflowPage>();
  }

  /** A workflow: its header, its open draft and its published versions. */
  get(id: string) {
    return this.api.call(ops.getWorkflow, { params: { id } }).as<Workflow>();
  }

  /** One version's definition — what the designer shows when no draft is open. */
  version(id: string, version: number) {
    return this.api
      .call(ops.getWorkflowVersion, { params: { id, version: String(version) } })
      .as<WorkflowDefinition>();
  }

  /** A new workflow; its draft is version 1 (`workflow:admin`). */
  create(input: DraftInput) {
    return this.api.call(ops.createWorkflow, { body: input }).as<Workflow>();
  }

  /** The whole graph as the designer holds it — a compare-and-set on the revision read (409). */
  saveDraft(id: string, revision: number, input: DraftInput) {
    return this.api
      .call(ops.saveDraft, { params: { id }, query: { revision }, body: input })
      .as<Workflow>();
  }

  /** The graph judged by the rules publish applies, without saving it. */
  validate(id: string, input: DraftInput) {
    return this.api
      .call(ops.validateWorkflow, { params: { id }, body: input })
      .as<ValidationResult>();
  }

  /**
   * The draft published as an immutable version — over the revision read (409), judged by the same
   * rules as /validate (422 with `details.issues`), refused (403) when the caller does not hold
   * what its command steps will do (`requires`).
   */
  publish(id: string, revision: number) {
    return this.api
      .call(ops.publishWorkflow, { params: { id }, query: { revision } })
      .as<PublishResult>();
  }

  /** A lifecycle move (EP-22.11) — deactivating and archiving are refused while instances run. */
  transition(id: string, action: 'activate' | 'deactivate' | 'archive', revision: number) {
    const op =
      action === 'activate'
        ? ops.activateWorkflow
        : action === 'deactivate'
          ? ops.deactivateWorkflow
          : ops.archiveWorkflow;
    return this.api.call(op, { params: { id }, query: { revision } }).as<Workflow>();
  }

  /** A workflow's instances, newest first (`workflow:read`, `:act` or `:admin`). */
  instances(workflowId: string, limit = 20) {
    return this.api.call(ops.listInstances, { query: { workflowId, limit } }).as<InstancePage>();
  }

  /** One instance with its step history (FR-BMS-6) — what the overlay paints. */
  instance(id: string) {
    return this.api.call(ops.getInstance, { params: { id } }).as<WorkflowInstance>();
  }

  /** The step kinds a designer offers (`workflow:admin`, EP-23.1). */
  palette() {
    return this.api.call(ops.getPalette).as<PaletteEntry[]>();
  }

  /**
   * A BPMN 2.0 file becomes a NEW workflow's draft (EP-23.8; `workflow:admin`). BMS converts it —
   * the browser sends the file as it is, and a construct outside the subset comes back as a 422
   * whose `details.unsupported` names each one.
   */
  importBpmn(xml: string) {
    return this.api
      .call(ops.importWorkflow, { body: xml, headers: { 'content-type': 'application/xml' } })
      .as<Workflow>();
  }

  /** A version as BPMN 2.0 with its layout — the open draft, else the latest published. */
  exportBpmn(id: string, version?: number) {
    return this.api.call(ops.exportWorkflow, { params: { id }, query: { version } }).asText();
  }
}
