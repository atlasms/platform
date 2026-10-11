// `@atlas/contracts/workflow` — the BMS workflow DSL: its types, the validator a definition must
// pass to be published, and the restricted FEEL subset (bms-workflow-dsl-and-designer.md §3, §6).
// A subpath so that FEEL's parser is loaded by the services that read workflows, not by every
// consumer of the envelope.
export * from './types.ts';
export { validateDefinition } from './validate.ts';
export { feelProblem, referencedVars, FEEL_ROOTS, FEEL_FUNCTIONS } from './feel.ts';
