import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A job's AbortSignal (W1-10; docs/AUDIT_BACKLOG.md "A job that times out is re-queued while its
 * handler is still running"). The runner gives every job its own signal (`Ctx.signal`) and runs
 * the handler inside `runWithSignal`, so the clients built once at boot (Claude, OpenAI, Supabase
 * Storage, the SMS drivers, WhatsApp, weather) abort the job's HTTP calls through
 * `abortableFetch` without each call site threading the signal. When the job times out the runner
 * aborts the signal: every request in flight rejects with an AbortError, every later one rejects
 * at once, and the handler settles.
 */

const jobSignal = new AsyncLocalStorage<AbortSignal>();

/** Runs `fn` with `signal` as the current job's signal (for `abortableFetch` and `currentSignal`). */
export function runWithSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return jobSignal.run(signal, fn);
}

/** The running job's signal, or undefined outside a job (boot, the timeout sweep, tests). */
export function currentSignal(): AbortSignal | undefined {
  return jobSignal.getStore();
}

/** `signal` combined with the running job's signal (either one aborts the call). */
export function withJobSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const job = currentSignal();
  if (!job) return signal ?? undefined;
  if (!signal || signal === job) return job;
  return AbortSignal.any([signal, job]);
}

/**
 * `fetch` that also aborts when the running job's signal does. The clients built at boot take it
 * as their fetch (index.ts), so a timed-out job's provider and storage calls stop.
 */
export function abortableFetch(base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const signal = withJobSignal(init?.signal);
    return base(input, signal ? { ...init, signal } : init);
  };
}

/**
 * For an SDK that takes no fetch and no signal (Resend): rejects as soon as the job's signal
 * aborts, so the handler settles. The request itself may still complete at the provider.
 */
export function raceJobSignal<T>(p: Promise<T>): Promise<T> {
  const signal = currentSignal();
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

/** A signal that never aborts: the base Ctx's, outside any job. */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal;
