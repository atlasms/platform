import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BpmnModdle } from 'bpmn-moddle';
import { workflowsDir } from '../paths.ts';

export const atlasDescriptor = JSON.parse(readFileSync(join(workflowsDir, 'atlas.moddle.json'), 'utf8'));

export function newModdle() {
  return new (BpmnModdle as any)({ atlas: atlasDescriptor });
}

export const ATLAS_NS = 'http://atlas.example/bpmn';
export const ID_PREFIX = 'wf_'; // BPMN ids must be NCNames (no leading digit)

export const toBpmnId = (ulid: string) => (/^[0-9]/.test(ulid) ? ID_PREFIX + ulid : ulid);
export const fromBpmnId = (id: string) => (id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id);
