// The wire shapes of starting and signalling an instance (bms.yaml `StartInstance`, `Signal`).
import { isUlid } from '@atlas/contracts';
import { ValidationError } from '@atlas/service-kit';
import type { StartInstanceInput } from './service.ts';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseStartInstance(body: unknown): StartInstanceInput {
  if (!isObject(body)) throw new ValidationError('body must be an object');
  const { workflowId, version, vars, assetId } = body;
  if (typeof workflowId !== 'string' || !isUlid(workflowId))
    throw new ValidationError('workflowId must be a workflow id');
  if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1))
    throw new ValidationError('version must be a positive integer');
  if (vars !== undefined && !isObject(vars)) throw new ValidationError('vars must be an object');
  if (assetId !== undefined && (typeof assetId !== 'string' || !isUlid(assetId)))
    throw new ValidationError('assetId must be an asset id');
  return {
    workflowId,
    ...(version !== undefined ? { version: version as number } : {}),
    ...(vars !== undefined ? { vars } : {}),
    ...(assetId !== undefined ? { assetId } : {}),
  };
}

export function parseSignal(body: unknown): { stepId: string; payload: Record<string, unknown> } {
  if (!isObject(body)) throw new ValidationError('body must be an object');
  const { stepId, payload } = body;
  if (typeof stepId !== 'string' || stepId.length === 0 || stepId.length > 200)
    throw new ValidationError('stepId must name a step');
  if (payload !== undefined && !isObject(payload))
    throw new ValidationError('payload must be an object');
  return { stepId, payload: payload ?? {} };
}
