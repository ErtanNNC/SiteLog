import { z } from 'zod';
import { isoWeekRange } from '@sitelog/shared';
import { requireOrgRole, requireUser } from '../_shared/auth.ts';
import { corsHeaders, HttpError, parseWith, requireMethod, withHandler } from '../_shared/http.ts';
import { logInfo } from '../_shared/log.ts';
import { adminClient, fetchAll } from '../_shared/supabase.ts';
import { buildPayrollRows, payrollCsv, payrollFileName } from './csv.ts';

/**
 * api-export-payroll (§F15 step 5, Appendix B) — any member role.
 * GET ?org=<uuid>&week=2026-W41&site=<uuid|all> → text/csv attachment `payroll_<week>.csv`
 * Rows come from `current_manpower` (current version of filed/signed-off reports only) for the
 * whole ISO week (Mon–Sun); unconfirmed companies follow org_settings.include_unconfirmed_in_payroll
 * and the column order follows org_settings.payroll_columns (Settings → Payroll export, §P12).
 */

const QuerySchema = z.object({
  org: z.uuid(),
  week: z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, 'week must look like 2026-W41'),
  site: z.union([z.literal('all'), z.uuid()]).default('all'),
});

Deno.serve(
  withHandler('api-export-payroll', async (req) => {
    requireMethod(req, 'GET');
    const user = await requireUser(req);
    const params = parseWith(QuerySchema, Object.fromEntries(new URL(req.url).searchParams));
    const admin = adminClient();
    await requireOrgRole(admin, user.userId, params.org);

    const range = isoWeekRange(params.week);
    const [settings, sites, companies] = await Promise.all([
      admin
        .from('org_settings')
        .select('include_unconfirmed_in_payroll, payroll_columns')
        .eq('org_id', params.org)
        .maybeSingle()
        .throwOnError(),
      admin.from('sites').select('id, name, project_code').eq('org_id', params.org).throwOnError(),
      admin
        .from('companies')
        .select('id, name, trade, status')
        .eq('org_id', params.org)
        .throwOnError(),
    ]);
    if (params.site !== 'all' && !sites.data.some((s) => s.id === params.site)) {
      throw new HttpError(404, 'Site not found in this organisation');
    }

    const entries = await fetchAll((from, to) => {
      let query = admin
        .from('current_manpower')
        .select(
          'date, site_id, company_id, company_name, company_name_heard, trade, workers, hours, report_no, version',
        )
        .eq('org_id', params.org)
        .gte('date', range.start)
        .lte('date', range.sunday);
      if (params.site !== 'all') query = query.eq('site_id', params.site);
      return query.order('date').order('report_no').order('id').range(from, to).throwOnError();
    });

    const rows = buildPayrollRows(entries, sites.data, companies.data, {
      includeUnconfirmed: settings.data?.include_unconfirmed_in_payroll ?? true,
    });
    logInfo('payroll.exported', {
      orgId: params.org,
      week: params.week,
      site: params.site,
      rows: rows.length,
    });

    return new Response(payrollCsv(rows, settings.data?.payroll_columns), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${payrollFileName(params.week)}"`,
        'Cache-Control': 'no-store',
        ...corsHeaders(req),
      },
    });
  }),
);
