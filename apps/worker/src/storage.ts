import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { abortableFetch } from './abort';

/**
 * Supabase Storage via the service role (§4.2, §6.5): private buckets, signed URLs only.
 * Paths come from @sitelog/shared (audioStoragePath / photoStoragePath / pdfStoragePath /
 * evidencePackStoragePath) and always start with `{org_id}/`.
 */

export type Bucket = 'audio' | 'photos' | 'pdfs' | 'exports' | 'logos';

export const SIGNED_URL_TTL_S = 10 * 60;

export interface Storage {
  upload(bucket: Bucket, path: string, body: Buffer, contentType: string): Promise<void>;
  download(bucket: Bucket, path: string): Promise<Buffer>;
  signedUrl(bucket: Bucket, path: string, expiresInS?: number): Promise<string>;
  remove(bucket: Bucket, paths: string[]): Promise<void>;
  move(bucket: Bucket, from: string, to: string): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly bucket: Bucket,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export function createStorage(url: string, serviceRoleKey: string): Storage {
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for storage');
  }
  const client: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    // A timed-out job's uploads and downloads stop with it (W1-10, src/abort.ts).
    global: { fetch: abortableFetch() },
  });
  return createStorageFromClient(client);
}

export function createStorageFromClient(client: SupabaseClient): Storage {
  return {
    async upload(bucket, path, body, contentType) {
      const { error } = await client.storage
        .from(bucket)
        .upload(path, body, { contentType, upsert: true });
      if (error) throw new StorageError(`upload failed: ${error.message}`, bucket, path);
    },
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data)
        throw new StorageError(`download failed: ${error?.message ?? 'no data'}`, bucket, path);
      return Buffer.from(await data.arrayBuffer());
    },
    async signedUrl(bucket, path, expiresInS = SIGNED_URL_TTL_S) {
      const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresInS);
      if (error || !data)
        throw new StorageError(`signed url failed: ${error?.message ?? 'no data'}`, bucket, path);
      return data.signedUrl;
    },
    async remove(bucket, paths) {
      if (paths.length === 0) return;
      const { error } = await client.storage.from(bucket).remove(paths);
      if (error) throw new StorageError(`remove failed: ${error.message}`, bucket, paths.join(','));
    },
    async move(bucket, from, to) {
      const { error } = await client.storage.from(bucket).move(from, to);
      if (error) throw new StorageError(`move failed: ${error.message}`, bucket, from);
    },
  };
}

/** In-memory storage for tests and WORKER_DRY_RUN. */
export function createMemoryStorage(): Storage & {
  files: Map<string, { body: Buffer; contentType: string }>;
} {
  const files = new Map<string, { body: Buffer; contentType: string }>();
  const key = (b: Bucket, p: string) => `${b}/${p}`;
  return {
    files,
    async upload(bucket, path, body, contentType) {
      files.set(key(bucket, path), { body, contentType });
    },
    async download(bucket, path) {
      const f = files.get(key(bucket, path));
      if (!f) throw new StorageError('not found', bucket, path);
      return f.body;
    },
    async signedUrl(bucket, path) {
      return `memory://${bucket}/${path}?signed=1`;
    },
    async remove(bucket, paths) {
      for (const p of paths) files.delete(key(bucket, p));
    },
    async move(bucket, from, to) {
      const f = files.get(key(bucket, from));
      if (!f) throw new StorageError('not found', bucket, from);
      files.delete(key(bucket, from));
      files.set(key(bucket, to), f);
    },
  };
}

export function mimeExtension(mime: string | null | undefined, fallback: string): string {
  const m = (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  switch (m) {
    case 'audio/ogg':
    case 'audio/opus':
      return 'ogg';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'audio/amr':
      return 'amr';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
    default:
      return fallback;
  }
}
