import { currentContext } from './correlation.ts';

// Minimal structured (JSON) logger that auto-threads the ambient correlationId. Swap for pino in
// production; keep the same call shape.
type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  service: string,
  sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    const ctx = currentContext();
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        service,
        msg,
        correlationId: ctx?.correlationId,
        // The trace ids, when a tracer has started a span. This is what lets a log line link to a
        // TRACE: Grafana extracts `traceId` from the line and jumps to it, so "this error" becomes
        // "the whole request that produced this error" in one click (EP-12.3). Omitted entirely
        // when absent, so a service with tracing switched off emits exactly what it did before.
        ...(ctx?.traceId !== undefined ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}),
        ...fields,
      }),
    );
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
