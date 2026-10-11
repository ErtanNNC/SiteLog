import type { JobPayloads, JobRow, JobTypeKey } from '@sitelog/shared';
import type { Ctx } from '../context';

export type JobHandler<K extends JobTypeKey> = (
  ctx: Ctx,
  payload: JobPayloads[K],
  job: JobRow,
) => Promise<void>;

export type JobRegistry = { [K in JobTypeKey]: JobHandler<K> };

/** Thrown for failures that retrying cannot fix (bad payload, missing rows). The runner still fails the job normally. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export function rawPayload(job: JobRow): Record<string, unknown> {
  return job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload)
    ? (job.payload as Record<string, unknown>)
    : {};
}
