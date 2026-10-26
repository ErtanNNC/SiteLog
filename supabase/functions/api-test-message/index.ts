import { LANGUAGES } from '@sitelog/shared';
import { z } from 'zod';
import { logAudit } from '../_shared/audit.ts';
import { requireUser } from '../_shared/auth.ts';
import { loadOrgPack } from '../_shared/countries.ts';
import { json, parseWith, readJson, requireMethod, withHandler } from '../_shared/http.ts';
import { logInfo } from '../_shared/log.ts';
import { smsTransportsFromEnv } from '../_shared/messaging.ts';
import { adminClient } from '../_shared/supabase.ts';
import { sendTestMessage, type TestMessageStore } from './app.ts';

/**
 * api-test-message (P12 Settings → Field channels, _Send me a test message_; §19 Q232, W4-05) —
 * admin of the org. POST { orgId, phone, language, attested: true } → { outcome: 'sent', driver }
 * | { outcome: 'console', reason } | { outcome: 'failed', driver }; 429 `rate_limited` after five
 * an hour per org. The number is never stored (audited masked). The flow is `sendTestMessage`
 * (app.ts). Env: the SMS credentials of `_shared/messaging.ts`.
 */

const BodySchema = z.object({
  orgId: z.uuid(),
  phone: z.string().trim().min(4).max(32),
  language: z.enum(LANGUAGES),
  attested: z.literal(true),
});

Deno.serve(
  withHandler('api-test-message', async (req) => {
    requireMethod(req, 'POST');
    const user = await requireUser(req);
    const body = parseWith(BodySchema, await readJson(req));
    const admin = adminClient();
    const store: TestMessageStore = {
      async memberRole(userId, orgId) {
        const { data } = await admin
          .from('org_members')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .maybeSingle()
          .throwOnError();
        return data?.role ?? null;
      },
      async loadOrg(orgId) {
        const { org, pack } = await loadOrgPack(admin, orgId);
        return { id: org.id, name: org.name, is_demo: org.is_demo, pack };
      },
      async claim(input) {
        const { data } = await admin
          .rpc('settings_test_message_claim', {
            p_org_id: input.orgId,
            p_user_id: input.userId,
            p_phone_masked: input.phoneMasked,
            p_driver: input.driver,
            p_language: input.language,
          })
          .throwOnError();
        const r = data as { allowed?: boolean; retry_at?: string } | null;
        return { allowed: r?.allowed === true, ...(r?.retry_at ? { retryAt: r.retry_at } : {}) };
      },
      async auditFailure(input) {
        await logAudit(admin, {
          orgId: input.orgId,
          actorType: 'user',
          actorId: input.userId,
          action: 'settings.test_message_failed',
          entity: 'org',
          entityId: input.orgId,
          diff: { to: input.phoneMasked, driver: input.driver, detail: input.detail },
        });
      },
    };
    const result = await sendTestMessage(
      { store, transport: smsTransportsFromEnv() },
      user.userId,
      body,
    );
    logInfo('settings.test_message', { orgId: body.orgId, outcome: result.outcome });
    return json(req, result);
  }),
);
