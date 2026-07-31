export { defineSettings, mergeRegistries, type DescriptorInput } from './define.ts';
export {
  validateSetting,
  validateWrite,
  validateAll,
  levelPermitted,
  validateRegistryEntry,
} from './validate.ts';
export { resolveSetting, resolveAll, valuesOf, type ScopeContext } from './resolve.ts';
export {
  SnapshotClient,
  type ReferenceSnapshot,
  type SnapshotClientOptions,
} from './snapshot.ts';
export { SCOPE_LEVELS } from './types.ts';
export type {
  ScopeLevel,
  Origin,
  SettingType,
  SettingValue,
  SettingOption,
  SettingDescriptor,
  SettingsRegistry,
  SettingRow,
  Resolved,
  ValidationProblem,
  ValidationResult,
  RegistryEntry,
} from './types.ts';
