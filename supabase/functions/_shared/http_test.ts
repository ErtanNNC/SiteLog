import { assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import {
  bearerToken,
  corsHeaders,
  formatIssues,
  HttpError,
  isAllowedOrigin,
  parseWith,
  timingSafeEqual,
} from './http.ts';

Deno.test('CORS: only the configured origins are echoed back', () => {
  const allowed = ['https://app.talkolog.com', 'http://localhost:5173'];
  assertEquals(isAllowedOrigin('https://app.talkolog.com', allowed), true);
  assertEquals(isAllowedOrigin('https://evil.example', allowed), false);
  assertEquals(isAllowedOrigin(null, allowed), false);
  const ok = corsHeaders(
    new Request('https://x/', { headers: { origin: 'http://localhost:5173' } }),
    allowed,
  );
  assertEquals(ok['Access-Control-Allow-Origin'], 'http://localhost:5173');
  assertEquals(ok['Vary'], 'Origin');
  assertEquals(
    corsHeaders(
      new Request('https://x/', { headers: { origin: 'https://evil.example' } }),
      allowed,
    ),
    {},
  );
  assertEquals(corsHeaders(new Request('https://x/'), allowed), {});
});

Deno.test('bearerToken', () => {
  assertEquals(
    bearerToken(new Request('https://x/', { headers: { authorization: 'Bearer abc.def' } })),
    'abc.def',
  );
  assertEquals(
    bearerToken(new Request('https://x/', { headers: { authorization: 'bearer   abc ' } })),
    'abc',
  );
  assertEquals(
    bearerToken(new Request('https://x/', { headers: { authorization: 'Basic abc' } })),
    null,
  );
  assertEquals(bearerToken(new Request('https://x/')), null);
});

Deno.test('timingSafeEqual', () => {
  assertEquals(timingSafeEqual('secret', 'secret'), true);
  assertEquals(timingSafeEqual('secret', 'secret2'), false);
  assertEquals(timingSafeEqual('secret', 'Secret'), false);
  assertEquals(timingSafeEqual('', ''), true);
});

Deno.test('parseWith turns Zod issues into a 400 with readable details', () => {
  const schema = z.object({ orgId: z.uuid(), siteIds: z.array(z.uuid()).min(1) });
  assertEquals(
    parseWith(schema, {
      orgId: '0f1b0d5e-2c1d-4a6b-9c3e-1f2a3b4c5d6e',
      siteIds: ['0f1b0d5e-2c1d-4a6b-9c3e-1f2a3b4c5d6f'],
    }).siteIds.length,
    1,
  );
  const err = assertThrows(() => parseWith(schema, { orgId: 'nope', siteIds: [] }), HttpError);
  assertEquals(err.status, 400);
  const details = err.details as string[];
  assertEquals(details.length, 2);
  assertEquals(details[0]?.startsWith('orgId: '), true);
  assertEquals(details[1]?.startsWith('siteIds: '), true);
  const parsed = schema.safeParse({});
  if (!parsed.success) assertEquals(formatIssues(parsed.error).length, 2);
});
