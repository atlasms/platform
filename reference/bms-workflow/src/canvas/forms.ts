// Property-form descriptors derived from the config JSON-Schema $def for each kind. The canvas
// renders the property panel from these (design §12.3) — so a new step kind needs only a schema
// $def + interpreter handler + BPMN mapping, never new canvas code.
import { rawSchema } from '../schema.ts';
import type { StepKind } from '../types.ts';

export interface FormField {
  name: string;
  type: string;        // json-schema type or 'enum'
  required: boolean;
  enum?: string[];
  feel?: boolean;      // hint: render a FEEL editor
  description?: string;
}

const CONFIG_DEF: Record<StepKind, string> = {
  start: 'StartConfig', end: 'EndConfig', command: 'CommandConfig', 'human-task': 'HumanTaskConfig',
  'wait-event': 'WaitEventConfig', timer: 'TimerConfig', branch: 'BranchConfig', parallel: 'ParallelConfig', 'sub-flow': 'SubFlowConfig',
};

/** Field descriptors for a kind's config, sliced from workflow-definition.schema.json $defs. */
export function formFor(kind: StepKind): FormField[] {
  const defName = CONFIG_DEF[kind];
  const def: any = (rawSchema.$defs as any)[defName];
  if (!def?.properties) return [];
  const required: string[] = def.required ?? [];
  return Object.entries<any>(def.properties).map(([name, spec]) => {
    const isFeel = spec?.$ref?.endsWith('/Feel') || spec?.description?.includes('FEEL');
    const type = spec.enum ? 'enum' : spec.type ?? (spec.$ref ? refName(spec.$ref) : 'object');
    return clean({ name, type, required: required.includes(name), enum: spec.enum, feel: isFeel || undefined, description: spec.description });
  });
}

function refName(ref: string): string {
  const m = /#\/\$defs\/(\w+)/.exec(ref);
  return m ? m[1] : 'object';
}
function clean<T>(o: any): T {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
