/**
 * Client-side PDF zip export (§P3 "Today's PDFs", §P6 "Export PDFs (.zip)"): fetch the signed
 * URLs with a small concurrency limit and store them uncompressed (PDFs are already compressed).
 */
import { zipSync, type Zippable } from 'fflate';
import { pdfFileName } from '@sitelog/shared/report/numbering.ts';

export interface ZipSource {
  /** File name inside the zip, e.g. `RL-2041-0187_2026-10-09_v2.pdf`. */
  name: string;
  url: string;
}

export interface ZipOptions {
  fetch?: typeof fetch;
  /** Parallel downloads (default 4). */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ZipResult {
  /** `null` when no file could be fetched. */
  blob: Blob | null;
  /** Names stored in the zip, in input order. */
  added: string[];
  /** Names whose download failed. */
  failed: string[];
}

const UNSAFE = '\\/:*?"<>|';

/**
 * The §12 name `{report_no}_{YYYY-MM-DD}_v{version}.pdf` per report (D33, `pdfFileName`); unsafe
 * characters in the report number become `_`, repeats get ` (2)`, ` (3)`…
 */
export function pdfFileNames(
  files: ReadonlyArray<{ reportNo: string; date: string; version: number }>,
): string[] {
  const used = new Set<string>();
  return files.map((f) => {
    const no =
      [...f.reportNo.trim()].map((ch) => (ch < ' ' || UNSAFE.includes(ch) ? '_' : ch)).join('') ||
      'report';
    const base = pdfFileName(no, f.date, f.version).replace(/\.pdf$/, '');
    let name = `${base}.pdf`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).pdf`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Downloads every source and zips the ones that arrived (store only, level 0). */
export async function zipFromUrls(
  sources: readonly ZipSource[],
  opts: ZipOptions = {},
): Promise<ZipResult> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const total = sources.length;
  const data: Array<Uint8Array | null> = sources.map(() => null);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < total) {
      const i = next++;
      try {
        const res = await doFetch(sources[i]!.url, { signal: opts.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data[i] = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        data[i] = null;
      }
      done += 1;
      opts.onProgress?.(done, total);
    }
  };
  const lanes = Math.min(Math.max(1, opts.concurrency ?? 4), total);
  await Promise.all(Array.from({ length: lanes }, worker));

  const files: Zippable = {};
  const added: string[] = [];
  const failed: string[] = [];
  sources.forEach((s, i) => {
    const bytes = data[i];
    if (bytes) {
      files[s.name] = [bytes, { level: 0 }];
      added.push(s.name);
    } else {
      failed.push(s.name);
    }
  });
  if (!added.length) return { blob: null, added, failed };
  const zipped = zipSync(files, { level: 0 });
  return {
    blob: new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
    added,
    failed,
  };
}

/** Triggers a browser download of `blob` as `fileName`. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
