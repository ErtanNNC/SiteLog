import { z } from 'zod';
import { daysBetween, isOwnEvidencePackPath, PACK_SECTIONS } from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import { requireOrgRole, requireUser, type AuthedUser } from '../_shared/auth.ts';
import {
  HttpError,
  json,
  parseWith,
  readJson,
  requireMethod,
  withHandler,
} from '../_shared/http.ts';
import { enqueueJob } from '../_shared/jobs.ts';
import { logInfo, logWarn } from '../_shared/log.ts';
import { adminClient, type AppClient } from '../_shared/supabase.ts';

/**
 * api-evidence-pack (§F16 step 2–3, §P9) — admin|pm|ops.
 * POST { orgId, siteId, periodStart, periodEnd, sections[] } → evidence_packs row + build job
 * GET  ?id=<uuid>                                             → pack + 7-day signed download URL when ready
 */

/** F20's sections (packages/shared, the worker's pack honours them). */
export { PACK_SECTIONS };
const MAX_PERIOD_DAYS = 366;
const SIGNED_URL_SECONDS = 7 * 24 * 3600;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const CreateSchema = z
  .object({
    orgId: z.uuid(),
    siteId: z.uuid(),
    periodStart: isoDate,
    periodEnd: isoDate,
    sections: z
      .array(z.enum(PACK_SECTIONS))
      .min(1)
      .default([...PACK_SECTIONS]),
  })
  .refine((b) => b.periodEnd >= b.periodStart, {
    message: 'periodEnd must be on or after periodStart',
    path: ['periodEnd'],
  })
  .refine((b) => daysBetween(b.periodStart, b.periodEnd) <= MAX_PERIOD_DAYS, {
    message: `period must be at most ${MAX_PERIOD_DAYS} days`,
    path: ['periodEnd'],
  });

const GetSchema = z.object({ id: z.uuid() });

Deno.serve(
  withHandler('api-evidence-pack', async (req) => {
    requireMethod(req, 'GET', 'POST');
    const user = await requireUser(req);
    const admin = adminClient();
    if (req.method === 'GET') {
      const { id } = parseWith(GetSchema, Object.fromEntries(new URL(req.url).searchParams));
      return json(req, await getPack(admin, user, id));
    }
    const body = parseWith(CreateSchema, await readJson(req));
    return json(req, await createPack(admin, user, body), { status: 201 });
  }),
);

async function createPack(admin: AppClient, user: AuthedUser, body: z.output<typeof CreateSchema>) {
  await requireOrgRole(admin, user.userId, body.orgId, ['admin', 'pm', 'ops']);
  const { data: site } = await admin
    .from('sites')
    .select('id, org_id')
    .eq('id', body.siteId)
    .eq('org_id', body.orgId)
    .maybeSingle()
    .throwOnError();
  if (!site) throw new HttpError(404, 'Site not found in this organisation');

  const { data: pack } = await admin
    .from('evidence_packs')
    .insert({
      org_id: body.orgId,
      site_id: body.siteId,
      period_start: body.periodStart,
      period_end: body.periodEnd,
      sections: [...new Set(body.sections)],
      status: 'queued',
      created_by: user.userId,
    })
    .select('*')
    .single()
    .throwOnError();

  const jobId = await enqueueJob(
    admin,
    'build_evidence_pack',
    { packId: pack.id },
    { dedupeKey: `pack:${pack.id}` },
  );
  await logAudit(admin, {
    orgId: body.orgId,
    actorType: 'user',
    actorId: user.userId,
    action: 'evidence_pack.requested',
    entity: 'evidence_pack',
    entityId: pack.id,
    diff: {
      siteId: body.siteId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      sections: pack.sections,
    },
  });
  logInfo('evidence_pack.requested', { orgId: body.orgId, packId: pack.id, jobId });
  return { pack, jobId };
}

async function getPack(admin: AppClient, user: AuthedUser, id: string) {
  const { data: pack } = await admin
    .from('evidence_packs')
    .select('*')
    .eq('id', id)
    .maybeSingle()
    .throwOnError();
  if (!pack) throw new HttpError(404, 'Evidence pack not found');
  await requireOrgRole(admin, user.userId, pack.org_id, ['admin', 'pm', 'ops']);

  let downloadUrl: string | null = null;
  let downloadExpiresAt: string | null = null;
  // Only a path under the pack's own org and site: a row from before 20261014000001 may name
  // another org's PDF.
  const ownPath = isOwnEvidencePackPath(pack);
  if (pack.pdf_path && !ownPath)
    logWarn('evidence_pack.foreign_path', { packId: pack.id, orgId: pack.org_id });
  if (pack.status === 'ready' && pack.pdf_path && ownPath) {
    const { data, error } = await admin.storage
      .from('exports')
      .createSignedUrl(pack.pdf_path, SIGNED_URL_SECONDS);
    if (error) throw new HttpError(500, 'Could not sign the download URL', error.message);
    downloadUrl = data.signedUrl;
    downloadExpiresAt = new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString();
  }
  return { pack, downloadUrl, downloadExpiresAt };
}
