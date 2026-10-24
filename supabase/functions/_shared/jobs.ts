import { JobPayloadSchemas, type Json } from '@sitelog/shared';
import type { z } from 'zod';
import type { AppClient } from './supabase.ts';

/** Typed wrapper over the `enqueue_job(p_type, p_payload, p_run_after, p_dedupe_key)` RPC (§10.1). */

export type JobType = keyof typeof JobPayloadSchemas;
export type JobInput<K extends JobType> = z.input<(typeof JobPayloadSchemas)[K]>;

export interface EnqueueOptions {
  /** Earliest time the worker may pick the job up (default: now). */
  runAfter?: Date | null;
  /**
   * A key names one job for good (GAP D16, 20261015000001): enqueueing a taken key returns that
   * job's id whatever its status (done and dead included) and runs nothing. Use a per-occurrence
   * key (`jobKeys`, packages/shared/src/schemas/jobs.ts) for work that must run again.
   */
  dedupeKey?: string | null;
}

export async function enqueueJob<K extends JobType>(
  admin: AppClient,
  type: K,
  payload: JobInput<K>,
  opts: EnqueueOptions = {},
): Promise<number> {
  const schema: z.ZodType = JobPayloadSchemas[type];
  const parsed = schema.parse(payload); // validates and applies the schema defaults
  const typeName: string = type; // widen the literal so the RPC argument inference stays simple
  const { data } = await admin
    .rpc('enqueue_job', {
      p_type: typeName,
      p_payload: parsed as Json,
      p_run_after: opts.runAfter ? opts.runAfter.toISOString() : null,
      p_dedupe_key: opts.dedupeKey ?? null,
    })
    .throwOnError();
  return data;
}
