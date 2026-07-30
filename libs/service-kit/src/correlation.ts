import { AsyncLocalStorage } from 'node:async_hooks';

// Ambient per-request/per-message context so logs, outgoing messages, and errors can thread the
// same correlationId without passing it through every function.
export interface RequestContext {
  correlationId: string;
  actor?: { kind: 'service' | 'user'; id: string };
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}
export const currentContext = (): RequestContext | undefined => als.getStore();
export const correlationId = (): string | undefined => als.getStore()?.correlationId;
