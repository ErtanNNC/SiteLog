import { z } from 'zod';
import { requireUser } from '../_shared/auth.ts';
import { optionalEnv, requireEnv } from '../_shared/env.ts';
import { json, parseWith, readJson, requireMethod, withHandler } from '../_shared/http.ts';
import { logInfo } from '../_shared/log.ts';
import { edgeNotifier } from '../_shared/messaging.ts';
import { adminClient } from '../_shared/supabase.ts';
import { textDailyLink } from './app.ts';
import { supabaseTextLinkStore } from './store_supabase.ts';

/**
 * api-text-daily-link (F17 "Text today's link", P3; W1-16) — admin|pm|ops of the site's org.
 * POST { siteId, requestId, reporterId? } → today's daily link texted to the site's reporter (or
 * the one Team's row menu names, W4-03) through the
 * Notifier: { sent: true, channel } or { sent: false, reason, detail } (consent, opt-out, a pack
 * with no sender here). The answer never holds the link code. The flow is `textDailyLink` (app.ts).
 * Env: LINK_SIGNING_SECRET, FIELD_APP_URL, DAILY_LINK_TTL_HOURS (default 72) and the SMS
 * credentials of `_shared/messaging.ts`.
 */

const BodySchema = z.object({
  siteId: z.uuid(),
  requestId: z.uuid(),
  reporterId: z.uuid().optional(),
});

Deno.serve(
  withHandler('api-text-daily-link', async (req) => {
    requireMethod(req, 'POST');
    const user = await requireUser(req);
    const body = parseWith(BodySchema, await readJson(req));
    const admin = adminClient();
    const result = await textDailyLink(
      {
        store: supabaseTextLinkStore(admin),
        notifier: edgeNotifier(admin),
        secret: requireEnv('LINK_SIGNING_SECRET'),
        fieldAppUrl: requireEnv('FIELD_APP_URL'),
        ttlHours: Number(optionalEnv('DAILY_LINK_TTL_HOURS') ?? '72'),
        now: () => new Date(),
        newId: () => crypto.randomUUID(),
      },
      user.userId,
      body,
    );
    logInfo('daily_link.texted', {
      siteId: body.siteId,
      reporterId: result.reporterId,
      sent: result.sent,
    });
    return json(req, result);
  }),
);
