// The declaration has to reach every program that compiles this file (BMS's too), and only a
// reference does that: an `import type` of a non-module .d.ts is TS2306, and a module .d.ts would
// be an augmentation of an untyped module (TS2665). Comments only — erased at runtime.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./bpmn-moddle.d.ts" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BpmnModdle } from 'bpmn-moddle';
import { workflowsDir } from '../paths.ts';

/** The `atlas:` extension namespace engine policy rides in (DSL doc §11.1). */
export const ATLAS_NS = 'http://atlas.example/bpmn';

let descriptor: Record<string, unknown> | undefined;

/** `docs/architecture/workflows/atlas.moddle.json`, read on first use — not at import. */
export function atlasDescriptor(): Record<string, unknown> {
  descriptor ??= JSON.parse(
    readFileSync(join(workflowsDir, 'atlas.moddle.json'), 'utf8'),
  ) as Record<string, unknown>;
  return descriptor;
}

/** A BPMN 2.0 model that knows the `atlas:` extensions. */
export function newModdle(): BpmnModdle {
  return new BpmnModdle({ atlas: atlasDescriptor() });
}

// A BPMN id is an NCName, which cannot start with a digit — and a ULID usually does. Such an id is
// written `wf_<id>`. An id that already starts `wf_` is prefixed too, so the mapping is a
// bijection: reading strips exactly one `wf_`, and only where writing added one.
const PREFIX = 'wf_';
const needsPrefix = (id: string) => /^[0-9]/.test(id) || id.startsWith(PREFIX);

export const toBpmnId = (id: string): string => (needsPrefix(id) ? PREFIX + id : id);
export const fromBpmnId = (id: string): string =>
  id.startsWith(PREFIX) && needsPrefix(id.slice(PREFIX.length)) ? id.slice(PREFIX.length) : id;
