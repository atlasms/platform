import { correlationId } from './correlation.ts';

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
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) =>
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        service,
        msg,
        correlationId: correlationId(),
        ...fields,
      }),
    );
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
