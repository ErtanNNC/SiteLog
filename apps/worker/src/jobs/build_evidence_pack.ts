import { evidencePackStoragePath } from '@sitelog/shared';
import { buildEvidencePackInput, renderEvidencePackPdf } from '../pdf/render';
import { PermanentJobError, type JobHandler } from './types';

/** §F16 step 2 — EOT evidence pack PDF → exports bucket → email + panel notification. */
export const buildEvidencePack: JobHandler<'build_evidence_pack'> = async (ctx, payload) => {
  const pack = await ctx.db.getEvidencePack(payload.packId);
  if (!pack) throw new PermanentJobError(`pack ${payload.packId} not found`);
  if (pack.status === 'ready') return;
  if (!pack.site_id) throw new PermanentJobError(`pack ${pack.id} has no site`);
  await ctx.db.updateEvidencePack(pack.id, { status: 'building', error: null });
  try {
    const site = await ctx.db.siteContext(pack.site_id);
    if (!site) throw new PermanentJobError(`site ${pack.site_id} not found`);
    const input = await buildEvidencePackInput(ctx, pack, site);
    const buffer = await renderEvidencePackPdf(input);
    const path = evidencePackStoragePath(pack.org_id, pack.site_id, pack.period_start, pack.period_end);
    await ctx.storage.upload('exports', path, buffer, 'application/pdf');
    await ctx.db.updateEvidencePack(pack.id, { status: 'ready', pdf_path: path, ready_at: ctx.now().toISOString() });
    await ctx.db.logAudit({ org_id: pack.org_id, actor_type: 'agent', action: 'evidence_pack.ready', entity: 'evidence_pack', entity_id: pack.id, diff: { path, bytes: buffer.length, days: input.days.length } });
    await ctx.db.notifyOrg(pack.org_id, 'pack_ready', `EOT evidence pack ready: ${site.site.name}`, `${pack.period_start} – ${pack.period_end}`, '/weather', pack.created_by);
    await ctx.db.enqueueJob('send_email', { kind: 'evidence_pack_ready', packId: pack.id }, { dedupeKey: `email:pack:${pack.id}` });
    ctx.metrics.add({ pdfBytes: buffer.length, packDays: input.days.length });
  } catch (err) {
    await ctx.db.updateEvidencePack(pack.id, { status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    throw err;
  }
};
