import { AsyncLocalStorage } from 'node:async_hooks';

// Ambient per-request/per-message context so logs, outgoing messages, and errors can thread the
// same correlationId without passing it through every function.
export interface RequestContext {
  correlationId: string;
  actor?: { kind: 'service' | 'user'; id: string };
  /**
   * Trace context (EP-04.7), carried HERE rather than in a second AsyncLocalStorage so a log line
   * and a span can never disagree about which request they belong to. Absent until a tracer starts
   * a span, so a service with tracing switched off is unchanged.
   */
  traceId?: string;
  spanId?: string;
  sampled?: boolean;
}

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}
export const currentContext = (): RequestContext | undefined => als.getStore();
export const correlationId = (): string | undefined => als.getStore()?.correlationId;
