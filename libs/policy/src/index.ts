export { can, canEnforce, unionFieldGroups } from './can.ts';
export type { CanOptions } from './can.ts';
export { compile } from './compile.ts';
export {
  permissionMatches,
  pathCovers,
  scopeMatches,
  fieldGroupMatches,
  ruleMatches,
} from './match.ts';
export type {
  Permission,
  Scope,
  Rule,
  Role,
  EffectivePolicy,
  ResourceContext,
  Decision,
  CompileInput,
} from './types.ts';
