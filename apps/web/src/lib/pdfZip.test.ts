import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { pdfFileNames, saveBlob, zipFromUrls } from './pdfZip';

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.7 ${text}`);

function fakeFetch(files: Record<string, Uint8Array | number>) {
  return vi.fn(async (url: string | URL | Request) => {
    const body = files[String(url)];
    if (body === undefined) throw new TypeError('network down');
    if (typeof body === 'number') return new Response('nope', { status: body });
    return new Response(body.slice().buffer as ArrayBuffer, { status: 200 });
  }) as unknown as typeof fetch;
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('pdfFileNames', () => {
  it('names files {reportNo}.pdf, replacing unsafe characters and numbering repeats', () => {
    expect(
      pdfFileNames(['RL-2041-0187', 'ES/0377:12', 'RL-2041-0187', 'rl-2041-0187', '']),
    ).toEqual([
      'RL-2041-0187.pdf',
      'ES_0377_12.pdf',
      'RL-2041-0187 (2).pdf',
      'rl-2041-0187 (3).pdf',
      'report.pdf',
    ]);
  });
});

describe('zipFromUrls', () => {
  it('downloads every URL and stores the PDFs uncompressed under their names', async () => {
    const a = pdf('a'.repeat(400));
    const b = pdf('b'.repeat(400));
    const fetchMock = fakeFetch({ 'https://s/a': a, 'https://s/b': b });
    const progress: Array<[number, number]> = [];
    const res = await zipFromUrls(
      [
        { name: 'RL-2041-0187.pdf', url: 'https://s/a' },
        { name: 'ES-0377-0042.pdf', url: 'https://s/b' },
      ],
      { fetch: fetchMock, concurrency: 1, onProgress: (d, t) => progress.push([d, t]) },
    );
    expect(res.added).toEqual(['RL-2041-0187.pdf', 'ES-0377-0042.pdf']);
    expect(res.failed).toEqual([]);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(res.blob!.type).toBe('application/zip');
    const zipped = await bytesOf(res.blob!);
    const files = unzipSync(zipped);
    expect(Object.keys(files)).toEqual(['RL-2041-0187.pdf', 'ES-0377-0042.pdf']);
    const text = (u8: Uint8Array | undefined) => new TextDecoder().decode(u8);
    expect(text(files['RL-2041-0187.pdf'])).toBe(text(a));
    expect(text(files['ES-0377-0042.pdf'])).toBe(text(b));
    // Level 0 (store): highly repetitive input is not shrunk.
    expect(zipped.byteLength).toBeGreaterThan(a.byteLength + b.byteLength);
  });

  it('skips files that fail to download and reports them', async () => {
    const fetchMock = fakeFetch({ 'https://s/ok': pdf('ok'), 'https://s/gone': 404 });
    const res = await zipFromUrls(
      [
        { name: 'ok.pdf', url: 'https://s/ok' },
        { name: 'gone.pdf', url: 'https://s/gone' },
        { name: 'offline.pdf', url: 'https://s/offline' },
      ],
      { fetch: fetchMock },
    );
    expect(res.added).toEqual(['ok.pdf']);
    expect(res.failed).toEqual(['gone.pdf', 'offline.pdf']);
    expect(Object.keys(unzipSync(await bytesOf(res.blob!)))).toEqual(['ok.pdf']);
  });

  it('returns no blob when nothing could be fetched', async () => {
    const res = await zipFromUrls([{ name: 'x.pdf', url: 'https://s/x' }], {
      fetch: fakeFetch({ 'https://s/x': 500 }),
    });
    expect(res).toEqual({ blob: null, added: [], failed: ['x.pdf'] });
  });
});

describe('saveBlob', () => {
  it('downloads through a temporary anchor', () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip');
    saveBlob(new Blob(['x']), 'SiteLog_reports_2026-10-09.zip');
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('SiteLog_reports_2026-10-09.zip');
    expect(anchor.href).toBe('blob:zip');
    expect(document.body.contains(anchor)).toBe(false);
  });
});
