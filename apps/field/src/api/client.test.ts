import { describe, expect, it, vi } from 'vitest';
import { createFieldApi, FIELD_API_URL, FieldApiError } from './client';

const JSON_TYPE = 'application/json; charset=utf-8';

function fakeFetch(status: number, body: string, contentType: string | null = JSON_TYPE) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(body || null, {
        status,
        headers: contentType ? { 'Content-Type': contentType } : {},
      }),
  );
}

/** What the field host answers for /api/* when the build has no /api rule (the app fallback). */
const INDEX_HTML = '<!doctype html><html lang="en"><head><title>SiteLog</title></head></html>';

describe('field-api client stub (D39)', () => {
  it('calls field-api same-origin at /api by default', () => {
    expect(FIELD_API_URL).toBe('/api');
    const api = createFieldApi();
    expect(api.url('resolve')).toBe('/api/resolve');
    expect(api.url('/device/verify')).toBe('/api/device/verify');
    expect(createFieldApi({ baseUrl: '/api/' }).url('today?site=1')).toBe('/api/today?site=1');
  });

  it('sends JSON with the same-origin cookie and returns the JSON body', async () => {
    const fetch = fakeFetch(200, '{"firstName":"Marco"}');
    const api = createFieldApi({ fetch });
    await expect(api.request('resolve', { body: { code: 'K7Q2MX' } })).resolves.toEqual({
      firstName: 'Marco',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/resolve');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: '{"code":"K7Q2MX"}',
      headers: { 'Content-Type': 'application/json' },
    });
    // A +json type (problem details) is JSON too.
    const problem = createFieldApi({
      fetch: fakeFetch(200, '{"ok":true}', 'application/problem+json'),
    });
    await expect(problem.request('resolve')).resolves.toEqual({ ok: true });
  });

  it('GETs without a body, and returns null for an empty answer', async () => {
    const fetch = fakeFetch(204, '', null);
    await expect(createFieldApi({ fetch }).request('history')).resolves.toBeNull();
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('throws FieldApiError with the status and body on a non-2xx answer', async () => {
    const api = createFieldApi({ fetch: fakeFetch(404, '{"error":"not_found"}') });
    const err = await api.request('resolve', { body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldApiError);
    expect(err).toMatchObject({
      status: 404,
      route: 'resolve',
      body: { error: 'not_found' },
      reason: 'status',
    });
    const text = createFieldApi({ fetch: fakeFetch(502, 'Bad gateway', 'text/plain') });
    await expect(text.request('today')).rejects.toMatchObject({ status: 502, body: 'Bad gateway' });
  });

  it('never takes a 2xx answer that is not JSON for a field-api answer', async () => {
    // The host's app fallback (a build without the /api rule) or a captive portal: HTTP 200, HTML.
    const html = createFieldApi({ fetch: fakeFetch(200, INDEX_HTML, 'text/html; charset=utf-8') });
    const err = await html
      .request('resolve', { body: { code: 'K7Q2MX' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldApiError);
    expect(err).toMatchObject({
      status: 200,
      route: 'resolve',
      reason: 'not_json',
      body: INDEX_HTML,
    });
    // JSON-looking text without a JSON content type, and a JSON type with a body that does not parse.
    const untyped = createFieldApi({
      fetch: fakeFetch(200, '{"firstName":"Marco"}', 'text/plain'),
    });
    await expect(untyped.request('resolve')).rejects.toMatchObject({ reason: 'not_json' });
    const broken = createFieldApi({ fetch: fakeFetch(200, '<html>') });
    await expect(broken.request('resolve')).rejects.toMatchObject({
      status: 200,
      reason: 'not_json',
    });
    const typo = createFieldApi({ fetch: fakeFetch(200, '{}', 'application/jsonx') });
    await expect(typo.request('resolve')).rejects.toMatchObject({ reason: 'not_json' });
  });
});
