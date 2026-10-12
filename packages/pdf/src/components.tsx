import { Image, StyleSheet, Text, View } from '@react-pdf/renderer';
import { abbreviateArea, deriveTotals, formatHours, type DailyReportData } from '@sitelog/shared';
import type { ComponentProps, ReactNode } from 'react';
import { styles } from './styles';
import type { PdfImage, PdfPhoto } from './types';

type ImageSrc = Extract<ComponentProps<typeof Image>, { src: unknown }>['src'];
type BufferLike = { isBuffer(v: unknown): boolean; from(v: Uint8Array): Uint8Array };

/** react-pdf wants a Buffer for raw bytes in Node and takes a Blob or URL in the browser. */
export function imageSrc(img: PdfImage): ImageSrc {
  if ('url' in img) return img.url;
  const NodeBuffer = (globalThis as { Buffer?: BufferLike }).Buffer;
  if (NodeBuffer) {
    const data = NodeBuffer.isBuffer(img.data) ? img.data : NodeBuffer.from(img.data);
    return { data, format: img.format } as ImageSrc;
  }
  return new Blob([img.data as Uint8Array<ArrayBuffer>], {
    type: img.format === 'png' ? 'image/png' : 'image/jpeg',
  });
}

/** Building blocks shared by ReportDocument and EvidencePack. */

export function Section({
  no,
  title,
  children,
  wrap = true,
  break: brk,
}: {
  no: string;
  title: string;
  children: ReactNode;
  wrap?: boolean;
  break?: boolean;
}) {
  return (
    <View style={styles.section} wrap={wrap} break={brk}>
      <View style={styles.sectionTitle} minPresenceAhead={60}>
        <Text style={styles.sectionNo}>{no}</Text>
        <Text style={styles.sectionName}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

export interface Col {
  key: string;
  label: string;
  width: string;
  align?: 'left' | 'right';
  mono?: boolean;
}

export function Table({
  cols,
  rows,
  total,
}: {
  cols: Col[];
  rows: Array<Record<string, ReactNode>>;
  total?: Record<string, ReactNode>;
}) {
  const cell = (c: Col, v: ReactNode) => (
    <View
      key={c.key}
      style={[
        styles.td,
        StyleSheet.create({ w: { width: c.width } }).w,
        ...(c.align === 'right' ? [styles.tdRight] : []),
      ]}
    >
      <Text style={c.mono ? styles.tdMono : undefined}>{v ?? ''}</Text>
    </View>
  );
  return (
    <View style={styles.table}>
      <View style={styles.tr} fixed>
        {cols.map((c) => (
          <Text
            key={c.key}
            style={[
              styles.th,
              { width: c.width },
              ...(c.align === 'right' ? [styles.tdRight] : []),
            ]}
          >
            {c.label}
          </Text>
        ))}
      </View>
      {rows.length === 0 ? (
        <View style={styles.tr}>
          <Text style={[styles.td, styles.muted]}>Not stated</Text>
        </View>
      ) : (
        rows.map((r, i) => (
          <View key={i} style={styles.tr} wrap={false}>
            {cols.map((c) => cell(c, r[c.key]))}
          </View>
        ))
      )}
      {total ? (
        <View style={[styles.tr, styles.totalRow]} wrap={false}>
          {cols.map((c) => cell(c, total[c.key]))}
        </View>
      ) : null}
    </View>
  );
}

export function Bullets({ items }: { items: string[] }) {
  if (items.length === 0) return <Text style={styles.muted}>None stated</Text>;
  return (
    <View>
      {items.map((it, i) => (
        <View key={i} style={styles.bullet}>
          <Text style={styles.bulletDot}>-</Text>
          <Text style={{ flex: 1 }}>{it}</Text>
        </View>
      ))}
    </View>
  );
}

export function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

export function fmtDateTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function WeatherTable({ data }: { data: DailyReportData }) {
  const rows = data.weather.periods.map((p) => ({
    period: p.fullDay
      ? 'Full day'
      : p.start && p.end
        ? `${p.start}–${p.end}`
        : p.start
          ? `from ${p.start}`
          : '—',
    condition: p.condition,
    impact: p.impact ?? (p.lostHours > 0 ? 'Work stopped' : 'No impact'),
    lost: p.lostHours > 0 ? formatHours(p.lostHours) : '—',
  }));
  const observed = data.weather.observed;
  return (
    <View>
      <Text style={{ marginBottom: 4 }}>
        {data.weather.conditionsText || 'Conditions not stated.'}
        {observed ? (
          <Text style={styles.muted}>
            {'  '}Observed: {observed.precipIn.toFixed(2)} in precipitation · {observed.tempMinF}–
            {observed.tempMaxF} °F · wind {observed.windMph} mph
            {observed.gustMph !== undefined ? ` · gusts ${observed.gustMph} mph` : ''}
          </Text>
        ) : null}
      </Text>
      <Table
        cols={[
          { key: 'period', label: 'Period', width: '17%', mono: true },
          { key: 'condition', label: 'Condition', width: '20%' },
          { key: 'impact', label: 'Impact on work', width: '48%' },
          { key: 'lost', label: 'Lost time', width: '15%', align: 'right', mono: true },
        ]}
        rows={rows}
      />
    </View>
  );
}

export function ManpowerTable({
  data,
  companies,
}: {
  data: DailyReportData;
  companies: Array<{ id: string; status: 'confirmed' | 'unconfirmed'; isSelfPerform: boolean }>;
}) {
  const unconfirmed = new Set(companies.filter((c) => c.status === 'unconfirmed').map((c) => c.id));
  const self = new Set(companies.filter((c) => c.isSelfPerform).map((c) => c.id));
  const totals = deriveTotals(data, { selfPerformCompanyIds: self });
  const rows = data.manpower.map((m) => ({
    company: (
      <Text>
        {m.companyName}
        {m.companyId === null || unconfirmed.has(m.companyId) ? (
          <Text style={styles.chip}> UNCONFIRMED</Text>
        ) : null}
        {m.source.some((s) => s.type === 'reply') ? (
          <Text style={styles.chip}> CONFIRMED BY REPLY</Text>
        ) : null}
        {m.source.some((s) => s.type === 'office_edit') ? (
          <Text style={styles.chip}> EDITED</Text>
        ) : null}
      </Text>
    ),
    trade: m.trade ?? '—',
    area: m.area ?? '—',
    workers: m.workers === null ? '—' : String(m.workers),
    hours: m.totalHours === null ? '—' : formatHours(m.totalHours),
  }));
  return (
    <Table
      cols={[
        { key: 'company', label: 'Company', width: '36%' },
        { key: 'trade', label: 'Trade', width: '18%' },
        { key: 'area', label: 'Area', width: '22%' },
        { key: 'workers', label: 'Workers', width: '11%', align: 'right', mono: true },
        { key: 'hours', label: 'Hours', width: '13%', align: 'right', mono: true },
      ]}
      rows={rows}
      total={{
        company: `Total · ${totals.companies} compan${totals.companies === 1 ? 'y' : 'ies'}`,
        workers: totals.headcountKnown ? String(totals.crewOnSite) : '—',
        hours: totals.hoursKnown ? formatHours(totals.totalHours) : '—',
      }}
    />
  );
}

export function WorkTable({ data }: { data: DailyReportData }) {
  const rows = data.workPerformed.map((w) => ({
    area: w.area ? abbreviateArea(w.area) : '—',
    activity: `${w.activity}${w.quantity ? ` — approx. ${w.quantity.value} ${w.quantity.unit}` : ''}`,
    status: statusLabel(w.status, w.percentComplete),
  }));
  return (
    <Table
      cols={[
        { key: 'area', label: 'Area', width: '18%', mono: true },
        { key: 'activity', label: 'Activity', width: '60%' },
        { key: 'status', label: 'Status', width: '22%' },
      ]}
      rows={rows}
    />
  );
}

function statusLabel(s: string, pct?: number): string {
  switch (s) {
    case 'complete':
      return 'Complete';
    case 'in_progress':
      return pct !== undefined ? `In progress · approx. ${pct}%` : 'In progress';
    case 'started':
      return 'Started';
    case 'stopped':
      return 'Stopped';
    case 'planned':
      return 'Planned';
    default:
      return s;
  }
}

export function PhotoGrid({ photos, tz }: { photos: PdfPhoto[]; tz: string }) {
  if (photos.length === 0) return <Text style={styles.muted}>No photos attached.</Text>;
  return (
    <View style={styles.photoGrid}>
      {photos.map((p, i) => (
        <View key={i} style={styles.photoCell} wrap={false}>
          <Image style={styles.photo} src={imageSrc(p)} />
          <Text style={styles.photoCaption}>
            {fmtTime(p.takenAt, tz)}
            {p.caption ? ` · ${p.caption}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function Footer({
  showWeather,
  footerEnabled,
}: {
  showWeather: boolean;
  footerEnabled: boolean;
}) {
  // No conditional (null) children inside a fixed element: react-pdf drops the whole element.
  const left = `${footerEnabled ? 'Generated by SiteLog from a WhatsApp voice report' : 'SiteLog'}${showWeather ? '   ·   Weather data: Open-Meteo' : ''}`;
  return (
    <View style={styles.footer} fixed>
      <View style={styles.footerLeft}>
        <View style={styles.mark} />
        <Text>{left}</Text>
      </View>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

export function RunningHeader({ left, right }: { left: string; right: string }) {
  return (
    <View
      style={styles.runningHeader}
      fixed
      render={({ pageNumber }) =>
        pageNumber > 1 ? <HeaderInner left={left} right={right} /> : null
      }
    />
  );
}

function HeaderInner({ left, right }: { left: string; right: string }) {
  return (
    <>
      <Text>{left}</Text>
      <Text>{right}</Text>
    </>
  );
}
