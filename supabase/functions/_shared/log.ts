/**
 * Structured JSON logging (§15 observability). One line per event, easy to filter in the
 * Supabase logs explorer. Never log secrets, tokens or full phone numbers.
 */

/** Any plain object; interfaces are accepted too (no index signature needed). */
type Fields = object;

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Fields): void {
  let line: string;
  try {
    line = JSON.stringify({ level, event, ...fields, at: new Date().toISOString() });
  } catch {
    line = JSON.stringify({ level, event, at: new Date().toISOString(), unserializable: true });
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function logInfo(event: string, fields: Fields = {}): void {
  emit('info', event, fields);
}

export function logWarn(event: string, fields: Fields = {}): void {
  emit('warn', event, fields);
}

export function logError(event: string, err: unknown, fields: Fields = {}): void {
  emit('error', event, {
    ...fields,
    error: errorMessage(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
