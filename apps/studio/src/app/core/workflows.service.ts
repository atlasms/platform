import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client.ts';
import type { Catalog } from './generated/bms.types.ts';
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
}
