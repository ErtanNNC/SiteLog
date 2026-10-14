import type { CountryRow, InboundReporterRow, Json, MemberRole } from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import { supabaseLinkStore } from '../_shared/messaging.ts';
import { notifyOrg } from '../_shared/notify.ts';
import type { AppClient } from '../_shared/supabase.ts';
import type { SmsWebhookStore } from './store.ts';

/** sms-webhook's store over supabase-js with the service role. */
export function supabaseSmsStore(admin: AppClient): SmsWebhookStore {
  return {
    async packBySender(to) {
      const { data } = await admin
        .from('countries')
        .select('*')
        .eq('sms_sender_id', to.trim())
        .maybeSingle()
        .throwOnError();
      return (data as CountryRow | null) ?? null;
    },

    async reportersByPhone(phone, country, scope) {
      const { data: reporters } = await admin
        .from('reporters')
        .select(
          'id, org_id, name, status, contact_pref, activated_at, opted_out_at, created_at, phone_e164, locale',
        )
        .eq('phone_e164', phone)
        .throwOnError();
      if (reporters.length === 0) return [];
      let query = admin
        .from('orgs')
        .select('id, name, is_demo, country')
        .in('id', [...new Set(reporters.map((r) => r.org_id))])
        .eq('country', country);
      // A real sender never reaches a demo org; the Demo phone stays inside the caller's org.
      query = 'realOnly' in scope ? query.eq('is_demo', false) : query.eq('id', scope.orgId);
      const { data: orgs } = await query.throwOnError();
      const byId = new Map(orgs.map((o) => [o.id, o]));
      return reporters.flatMap((r): InboundReporterRow[] => {
        const org = byId.get(r.org_id);
        if (!org) return [];
        return [
          {
            id: r.id,
            orgId: r.org_id,
            status: r.status,
            contactPref: r.contact_pref,
            activatedAt: r.activated_at,
            optedOutAt: r.opted_out_at,
            createdAt: r.created_at,
            name: r.name,
            phone: r.phone_e164,
            locale: r.locale,
            orgName: org.name,
            orgIsDemo: org.is_demo,
          },
        ];
      });
    },

    async receiveInbound(row) {
      // One transaction (20261014000008): the row, its audit and its job, or none of them.
      const { data } = await admin
        .rpc('receive_sms_inbound', {
          p_id: row.id,
          p_org_id: row.org_id,
          p_reporter_id: row.reporter_id,
          p_phone_e164: row.phone_e164,
          p_provider: row.provider,
          p_provider_message_id: row.provider_message_id,
          p_body: row.body,
          p_payload: row.payload as unknown as Json,
        })
        .throwOnError();
      return data;
    },

    async markHandled(id, at) {
      const { data } = await admin
        .from('messages')
        .select('payload')
        .eq('id', id)
        .single()
        .throwOnError();
      const payload = { ...((data.payload as Record<string, Json> | null) ?? {}), handled_at: at };
      await admin.from('messages').update({ payload }).eq('id', id).throwOnError();
    },

    async updateReporter(id, patch) {
      await admin.from('reporters').update(patch).eq('id', id).throwOnError();
    },

    async hasPendingUnknown(phone, opts) {
      let query = admin
        .from('unknown_contacts')
        .select('id, message_id')
        .eq('phone_e164', phone)
        .eq('channel', 'sms')
        .eq('status', 'pending');
      // The row this same text created on an earlier attempt does not count (its retry still
      // sends the F13 auto-reply).
      if (opts?.excludeMessageId) query = query.neq('message_id', opts.excludeMessageId);
      const { data } = await query.limit(1).throwOnError();
      return data.length > 0;
    },

    async insertUnknownContact(row) {
      const { data: existing } = await admin
        .from('unknown_contacts')
        .select('id')
        .eq('message_id', row.message_id)
        .limit(1)
        .throwOnError();
      if (existing[0]) return { id: existing[0].id, created: false };
      const { data } = await admin
        .from('unknown_contacts')
        .insert({ ...row, org_id: null, channel: 'sms', status: 'pending' })
        .select('id')
        .single()
        .throwOnError();
      return { id: data.id, created: true };
    },

    async recordPhoneOptOut(phone, country) {
      await admin
        .from('sms_opt_outs')
        .upsert(
          { phone_e164: phone, country, method: 'sms_keyword' },
          { onConflict: 'phone_e164,country', ignoreDuplicates: true },
        )
        .throwOnError();
    },

    async clearPhoneOptOut(phone, country) {
      await admin
        .from('sms_opt_outs')
        .delete()
        .eq('phone_e164', phone)
        .eq('country', country)
        .throwOnError();
    },

    async messageByProviderId(providerId) {
      const { data } = await admin
        .from('messages')
        .select('id, status, org_id, reporter_id, copy_key')
        .eq('provider_message_id', providerId)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async updateMessageStatus(id, status, error) {
      await admin.from('messages').update({ status, error }).eq('id', id).throwOnError();
    },

    async reporterForInvite(id) {
      const { data } = await admin
        .from('reporters')
        .select('id, org_id, name, status')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async setInviteError(id, error) {
      await admin
        .from('reporters')
        .update({ last_invite_error: error })
        .eq('id', id)
        .throwOnError();
    },

    async providerFaultNotifiedSince(orgId, since) {
      const { data } = await admin
        .from('audit_log')
        .select('id')
        .eq('org_id', orgId)
        .eq('action', 'sms.provider_fault')
        .eq('diff->>notified', 'true')
        .gte('created_at', since)
        .limit(1)
        .throwOnError();
      return data.length > 0;
    },

    async notifyOrg(n) {
      await notifyOrg(admin, {
        orgId: n.orgId,
        kind: n.kind,
        title: n.title,
        body: n.body,
        targetPath: n.targetPath,
      });
    },

    audit: (entry) =>
      logAudit(admin, {
        orgId: entry.orgId,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        diff: entry.diff as Json,
      }),

    async reporterContext(reporterId) {
      const { data: reporter } = await admin
        .from('reporters')
        .select('id, org_id, phone_e164, status')
        .eq('id', reporterId)
        .maybeSingle()
        .throwOnError();
      if (!reporter) return null;
      const { data: org } = await admin
        .from('orgs')
        .select('id, is_demo, country')
        .eq('id', reporter.org_id)
        .single()
        .throwOnError();
      const { data: country } = await admin
        .from('countries')
        .select('*')
        .eq('code', org.country)
        .single()
        .throwOnError();
      return { reporter, org, country: country as CountryRow };
    },

    async memberRole(userId, orgId) {
      const { data } = await admin
        .from('org_members')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .maybeSingle()
        .throwOnError();
      return (data?.role as MemberRole | undefined) ?? null;
    },

    links: supabaseLinkStore(admin),
  };
}
