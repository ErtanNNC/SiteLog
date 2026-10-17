import { M8_TARGET_SHARE, outboundCallShare } from '@sitelog/shared/voice-outbound.ts';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import type { OpsOutboundCalls } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';

/**
 * /ops (W3-17, M8, spec §16.2 "≥ 85 % of call reporters' reports done by an outbound call without
 * office help"): per organisation and ISO week, the site-days SiteLog called a reporter about and
 * the share filed by the reporter's yes on such a call (`ops_outbound_call_share`). The weekly
 * digest carries the same numbers per org. Below the target is said in words, never by colour
 * alone. Speaks the panel's language (EN, TR).
 */
export function OutboundCalls({ rows }: { rows: OpsOutboundCalls[] }) {
  const { t } = useCopy();
  const columns: Column<OpsOutboundCalls>[] = [
    {
      key: 'org',
      header: t('ops.outboundCalls.columns.org'),
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <span>{r.orgName}</span>
          {r.isDemo ? (
            <span className="inline-flex h-6 items-center rounded-chip border border-rebar px-1.5 font-mono text-[12px] text-dust">
              {t('ops.outboundCalls.demo')}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'week',
      header: t('ops.outboundCalls.columns.week'),
      cell: (r) => <span className="whitespace-nowrap font-mono text-[13px]">{r.weekStart}</span>,
    },
    {
      key: 'called',
      header: t('ops.outboundCalls.columns.called'),
      numeric: true,
      cell: (r) => r.callDays,
    },
    {
      key: 'filed',
      header: t('ops.outboundCalls.columns.filed'),
      numeric: true,
      cell: (r) => r.filedByCall,
    },
    {
      key: 'share',
      header: t('ops.outboundCalls.columns.share'),
      numeric: true,
      cell: (r) => {
        const share = outboundCallShare({ call_days: r.callDays, filed_by_call: r.filedByCall });
        if (share === null) return '—';
        const below = share < M8_TARGET_SHARE;
        return (
          <span className="flex flex-col items-end">
            <span className={cn('font-semibold', below && 'text-missing')}>
              {t('ops.outboundCalls.share', { pct: Math.round(share * 100) })}
            </span>
            {below ? (
              <span className="text-caption text-dust">{t('ops.outboundCalls.belowTarget')}</span>
            ) : null}
          </span>
        );
      },
    },
  ];
  return (
    <Card className="mb-6">
      <CardHeader>
        <div>
          <CardTitle>{t('ops.outboundCalls.title')}</CardTitle>
          <p className="mt-1 text-[15px] text-dust">{t('ops.outboundCalls.hint')}</p>
        </div>
        <span className="font-mono text-[13px] text-dust">{rows.length}</span>
      </CardHeader>
      <CardContent className="px-0 pb-2 pt-3">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.orgId}:${r.weekStart}`}
          aria-label={t('ops.outboundCalls.title')}
          empty={{ title: t('ops.outboundCalls.empty') }}
          className={rows.length === 0 ? 'mx-5 mb-3' : undefined}
        />
      </CardContent>
    </Card>
  );
}
