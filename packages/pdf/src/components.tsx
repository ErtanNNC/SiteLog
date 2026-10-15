/** @jsxRuntime automatic @jsxImportSource react */
// The automatic JSX runtime per file: the worker runs this package from source under tsx
// (`pnpm dev:worker`), which compiles files outside its tsconfig's `include` with the classic
// runtime (React.createElement, "React is not defined"). The pragma holds under every compiler.
import { G, Image, Path, Rect, StyleSheet, Svg, Text, View } from '@react-pdf/renderer';
import {
  abbreviateArea,
  colors,
  deriveTotals,
  MEASURE_DIGITS,
  UNIT_LABELS,
  type DailyReportData,
} from '@sitelog/shared';
import type { ComponentProps, ReactNode } from 'react';
import { PDF_COPY, upper, type PdfCopy } from './copy';
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
  copy = PDF_COPY.en,
}: {
  no: string;
  title: string;
  children: ReactNode;
  wrap?: boolean;
  break?: boolean;
  /** The report language: the title prints in its upper case (Turkish i → İ). */
  copy?: PdfCopy;
}) {
  return (
    <View style={styles.section} wrap={wrap} break={brk}>
      <View style={styles.sectionTitle} minPresenceAhead={60}>
        <Text style={styles.sectionNo}>{no}</Text>
        <Text style={styles.sectionName}>{upper(copy, title)}</Text>
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
  copy = PDF_COPY.en,
}: {
  cols: Col[];
  rows: Array<Record<string, ReactNode>>;
  total?: Record<string, ReactNode>;
  /** Header labels print in the language's upper case; an empty table says "Not stated". */
  copy?: PdfCopy;
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
            {upper(copy, c.label)}
          </Text>
        ))}
      </View>
      {rows.length === 0 ? (
        <View style={styles.tr}>
          <Text style={[styles.td, styles.muted]}>{copy.notStated}</Text>
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

export function Bullets({ items, copy = PDF_COPY.en }: { items: string[]; copy?: PdfCopy }) {
  if (items.length === 0) return <Text style={styles.muted}>{copy.noneStated}</Text>;
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

/** YYYY-MM-DD of an instant in `tz`; null when the zone or instant is not valid. */
function localDate(iso: string, tz: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

/**
 * When something happened, as the report prints it: the time (site time zone), or "Oct 12, 14:05"
 * · "12 Eki 14:05" when that is another day than `date` (the report's, YYYY-MM-DD), so a photo,
 * filing or edit from another day never reads as the report's.
 */
export function fmtPhotoTime(
  iso: string,
  tz: string,
  date?: string | null,
  copy: PdfCopy = PDF_COPY.en,
): string {
  const day = date ? localDate(iso, tz) : null;
  if (!day || day === date) return fmtTime(iso, tz);
  return copy.dayTime(day, fmtTime(iso, tz));
}

/** "Oct 9, 2026, 20:10" · "9 Eki 2026 20:10" in the site time zone. */
export function fmtDateTimeIn(iso: string, tz: string, copy: PdfCopy): string {
  const day = localDate(iso, tz);
  return day ? copy.dateTime(day, fmtTime(iso, tz)) : iso;
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

export function WeatherTable({
  data,
  copy = PDF_COPY.en,
}: {
  data: DailyReportData;
  copy?: PdfCopy;
}) {
  const w = copy.weatherTable;
  const rows = data.weather.periods.map((p) => ({
    period: p.fullDay
      ? w.fullDay
      : p.start && p.end
        ? `${p.start}–${p.end}`
        : p.start
          ? w.from(p.start)
          : '—',
    condition: p.condition,
    impact: p.impact ?? (p.lostHours > 0 ? w.workStopped : w.noImpact),
    lost: p.lostHours > 0 ? copy.hours(p.lostHours) : '—',
  }));
  const observed = data.weather.observed;
  // Observed values are in the report's units (imperial: in, °F, mph; metric: mm, °C, km/h).
  const unit = UNIT_LABELS[data.units];
  const digits = MEASURE_DIGITS[data.units].precipitation;
  // Fixed decimals ("0.40 in"), with the language's decimal mark ("10,2 mm").
  const precip = observed
    ? new Intl.NumberFormat(copy.intl, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        useGrouping: false,
      }).format(observed.precip)
    : '';
  return (
    <View>
      <Text style={{ marginBottom: 4 }}>
        {data.weather.conditionsText || w.conditionsNotStated}
        {observed ? (
          <Text style={styles.muted}>
            {/* Text runs split as before v2: a run boundary drops kerning, so this keeps the
                imperial line pixel-identical. */}
            {'  '}
            {w.observed} {precip}
            {` ${unit.precipitation} ${w.precipitation} · `}
            {observed.tempMin}–{observed.tempMax}
            {` ${unit.temperature} · ${w.wind} `}
            {copy.num(observed.wind)}
            {` ${unit.wind}`}
            {observed.gust !== undefined
              ? ` · ${w.gusts} ${copy.num(observed.gust)} ${unit.wind}`
              : ''}
          </Text>
        ) : null}
      </Text>
      <Table
        copy={copy}
        cols={[
          { key: 'period', label: w.period, width: '17%', mono: true },
          { key: 'condition', label: w.condition, width: '20%' },
          { key: 'impact', label: w.impact, width: '48%' },
          { key: 'lost', label: w.lost, width: '15%', align: 'right', mono: true },
        ]}
        rows={rows}
      />
    </View>
  );
}

export function ManpowerTable({
  data,
  companies,
  copy = PDF_COPY.en,
}: {
  data: DailyReportData;
  companies: Array<{ id: string; status: 'confirmed' | 'unconfirmed'; isSelfPerform: boolean }>;
  copy?: PdfCopy;
}) {
  const t = copy.manpowerTable;
  const unconfirmed = new Set(companies.filter((c) => c.status === 'unconfirmed').map((c) => c.id));
  const self = new Set(companies.filter((c) => c.isSelfPerform).map((c) => c.id));
  const totals = deriveTotals(data, { selfPerformCompanyIds: self });
  const rows = data.manpower.map((m) => ({
    company: (
      <Text>
        {m.companyName}
        {m.companyId === null || unconfirmed.has(m.companyId) ? (
          <Text style={styles.chip}> {t.unconfirmed}</Text>
        ) : null}
        {m.source.some((s) => s.type === 'answer') ? (
          <Text style={styles.chip}> {t.confirmed}</Text>
        ) : null}
        {m.source.some((s) => s.type === 'office_edit') ? (
          <Text style={styles.chip}> {t.edited}</Text>
        ) : null}
      </Text>
    ),
    trade: m.trade ?? '—',
    area: m.area ?? '—',
    workers: m.workers === null ? '—' : String(m.workers),
    hours: m.totalHours === null ? '—' : copy.hours(m.totalHours),
  }));
  return (
    <Table
      copy={copy}
      cols={[
        { key: 'company', label: t.company, width: '36%' },
        { key: 'trade', label: t.trade, width: '18%' },
        { key: 'area', label: t.area, width: '22%' },
        { key: 'workers', label: t.workers, width: '11%', align: 'right', mono: true },
        { key: 'hours', label: t.hours, width: '13%', align: 'right', mono: true },
      ]}
      rows={rows}
      total={{
        company: t.total(totals.companies),
        workers: totals.headcountKnown ? String(totals.crewOnSite) : '—',
        hours: totals.hoursKnown ? copy.hours(totals.totalHours) : '—',
      }}
    />
  );
}

export function WorkTable({ data, copy = PDF_COPY.en }: { data: DailyReportData; copy?: PdfCopy }) {
  const t = copy.workTable;
  const rows = data.workPerformed.map((w) => ({
    // Area abbreviations ("L4", "Ext.") are English; a Turkish report prints its areas as stated.
    area: w.area ? (copy.lang === 'en' ? abbreviateArea(w.area) : w.area) : '—',
    activity: `${w.activity}${w.quantity ? ` — ${copy.approx} ${copy.num(w.quantity.value)} ${w.quantity.unit}` : ''}`,
    status: statusLabel(copy, w.status, w.percentComplete),
  }));
  return (
    <Table
      copy={copy}
      cols={[
        { key: 'area', label: t.area, width: '18%', mono: true },
        { key: 'activity', label: t.activity, width: '60%' },
        { key: 'status', label: t.status, width: '22%' },
      ]}
      rows={rows}
    />
  );
}

export function statusLabel(copy: PdfCopy, s: string, pct?: number): string {
  const statuses = copy.workTable.statuses;
  if (s === 'in_progress' && pct !== undefined)
    return `${statuses.in_progress} · ${copy.approx} ${copy.workTable.percent(pct)}`;
  return s in statuses ? statuses[s as keyof typeof statuses] : s;
}

export function PhotoGrid({
  photos,
  tz,
  date,
  copy = PDF_COPY.en,
}: {
  photos: PdfPhoto[];
  tz: string;
  /** The report's date (YYYY-MM-DD): a photo taken another day prints its date too. */
  date?: string | null;
  copy?: PdfCopy;
}) {
  if (photos.length === 0) return <Text style={styles.muted}>{copy.noPhotos}</Text>;
  return (
    <View style={styles.photoGrid}>
      {photos.map((p, i) => (
        <View key={i} style={styles.photoCell} wrap={false}>
          <Image style={styles.photo} src={imageSrc(p)} />
          <Text style={styles.photoCaption}>
            {fmtPhotoTime(p.takenAt, tz, date, copy)}
            {p.caption ? ` · ${p.caption}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The SiteLog mini mark: the kit's 32 px mark (docs/brand/favicon-32.svg, the simplified mark the
 * Report artboards' footer draws), in the token colours.
 */
export function MiniMark({ size = 10 }: { size?: number }) {
  return (
    <Svg viewBox="0 0 64 64" style={{ width: size, height: size, marginRight: 5 }}>
      <Path
        d="M8 0H46L64 18V56A8 8 0 0 1 56 64H8A8 8 0 0 1 0 56V8A8 8 0 0 1 8 0Z"
        fill={colors.signal}
      />
      <G fill={colors.asphalt}>
        <Rect x="14" y="18" width="35" height="5" />
        <Rect x="20" y="18" width="7" height="32" />
        <Rect x="11" y="36" width="7" height="14" />
        <Rect x="31" y="30" width="7" height="20" />
        <Rect x="42" y="38" width="7" height="12" />
        <Rect x="9" y="50" width="44" height="5" />
      </G>
    </Svg>
  );
}

export function Footer({
  showWeather,
  footerEnabled,
  typed = false,
  copy = PDF_COPY.en,
}: {
  showWeather: boolean;
  footerEnabled: boolean;
  /** The report was typed in the panel, not spoken. */
  typed?: boolean;
  copy?: PdfCopy;
}) {
  // No conditional (null) children inside a fixed element: react-pdf drops the whole element.
  const f = copy.footer;
  const credit = typed ? f.typed : f.voice;
  const left = `${footerEnabled ? credit : f.plain}${showWeather ? `   ·   ${f.weather}` : ''}`;
  return (
    <View style={styles.footer} fixed>
      <View style={styles.footerLeft}>
        <MiniMark />
        <Text>{left}</Text>
      </View>
      <Text render={({ pageNumber, totalPages }) => f.page(pageNumber, totalPages ?? pageNumber)} />
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
