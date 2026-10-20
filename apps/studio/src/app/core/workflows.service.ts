import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { Catalog, Workflow, WorkflowPage } from './generated/bms.types.ts';
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
