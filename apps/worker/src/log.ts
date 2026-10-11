/** Small structured JSON logger with bound context fields (org_id, report_id, job_id, …). */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  readonly fields: LogFields;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

export function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }
  return { message: String(err) };
}

export function createLogger(base: LogFields = {}, opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = opts.now ?? (() => new Date());
  const min = LEVELS[level];

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[lvl] < min) return;
    const rec: LogFields = { ts: now().toISOString(), level: lvl, msg, ...base, ...(fields ?? {}) };
    if (rec.err !== undefined) rec.err = serializeError(rec.err);
    write(safeStringify(rec));
  };

  return {
    fields: base,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...base, ...fields }, { level, write, now }),
  };
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? Number(val) : val));
  } catch {
    return JSON.stringify({ msg: 'unserializable log record' });
  }
}

/** A logger that records lines (tests). */
export function memoryLogger(level: LogLevel = 'debug'): Logger & { lines: string[] } {
  const lines: string[] = [];
  const log = createLogger({}, { level, write: (l) => lines.push(l) });
  return Object.assign(log, { lines });
}

export const silentLogger: Logger = createLogger({}, { level: 'error', write: () => {} });
