import type { CountryRow, Json, MemberRole } from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import { supabaseLinkStore } from '../_shared/messaging.ts';
import type { AppClient } from '../_shared/supabase.ts';
import type { InboundReporterRow, SmsWebhookStore } from './store.ts';

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

    async reportersByPhone(phone, country, opts) {
      const { data: reporters } = await admin
        .from('reporters')
        .select(
          'id, org_id, status, contact_pref, activated_at, opted_out_at, created_at, phone_e164, locale',
        )
        .eq('phone_e164', phone)
        .throwOnError();
      if (reporters.length === 0) return [];
      const { data: orgs } = await admin
        .from('orgs')
        .select('id, name, is_demo, country')
        .in('id', [...new Set(reporters.map((r) => r.org_id))])
        .eq('country', country)
        .throwOnError();
      const byId = new Map(orgs.filter((o) => !opts.demoOnly || o.is_demo).map((o) => [o.id, o]));
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
            phone: r.phone_e164,
            locale: r.locale,
            orgName: org.name,
            orgIsDemo: org.is_demo,
          },
        ];
      });
    },

    async insertInbound(row) {
      const { data: inserted } = await admin
        .from('messages')
        .upsert(
          {
            ...row,
            channel: 'sms',
            direction: 'in',
            status: 'received',
            payload: row.payload as Json,
          },
          { onConflict: 'provider_message_id', ignoreDuplicates: true },
        )
        .select('id')
        .throwOnError();
      const id = inserted[0]?.id;
      if (id) return { id, duplicate: false, handled: false };
      const { data: existing } = await admin
        .from('messages')
        .select('id, payload')
        .eq('provider_message_id', row.provider_message_id)
        .single()
        .throwOnError();
      const payload = existing.payload as { handled_at?: string } | null;
      return { id: existing.id, duplicate: true, handled: Boolean(payload?.handled_at) };
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

    async hasPendingUnknown(phone) {
      const { data } = await admin
        .from('unknown_contacts')
        .select('id')
        .eq('phone_e164', phone)
        .eq('channel', 'sms')
        .eq('status', 'pending')
        .limit(1)
        .throwOnError();
      return data.length > 0;
    },

    async insertUnknownContact(row) {
      const { data } = await admin
        .from('unknown_contacts')
        .insert({ ...row, org_id: null, channel: 'sms', status: 'pending' })
        .select('id')
        .single()
        .throwOnError();
      return data.id;
    },

    async messageByProviderId(providerId) {
      const { data } = await admin
        .from('messages')
        .select('id, status, org_id')
        .eq('provider_message_id', providerId)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async updateMessageStatus(id, status, error) {
      await admin.from('messages').update({ status, error }).eq('id', id).throwOnError();
    },

    audit: (entry) => logAudit(admin, entry),

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
