import type { JobHandler } from './types';

/**
 * §10.1 `transcribe_upload(upload_id)`: a voice note of the web recorder. field-api enqueues it
 * when an upload completes (W1-07, `field_complete_upload()`); the handler (Deepgram, transcript,
 * peaks, then `extract_report`) is W1-11. Until then the job fails and is retried with the
 * normal backoff, so a voice note uploaded before W1-11 is transcribed once the handler exists
 * (or goes dead after the last retry and can be retried from /ops).
 */
export const transcribeUploadJob: JobHandler<'transcribe_upload'> = async (_ctx, payload) => {
  throw new Error(
    `transcribe_upload ${payload.uploadId}: the handler is built in W1-11 (Deepgram transcription)`,
  );
};
