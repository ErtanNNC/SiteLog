/** @jsxRuntime automatic @jsxImportSource react */
// The automatic JSX runtime per file: the worker runs this package from source under tsx
// (`pnpm dev:worker`), which compiles files outside its tsconfig's `include` with the classic
// runtime (React.createElement, "React is not defined"). The pragma holds under every compiler.
import { Document, Image, Page, Text, View } from '@react-pdf/renderer';
import type { ReactNode } from 'react';
import {
  confirmedBySiteManager,
  formatAudioTimestamp,
  formatDate,
  MEASURE_DIGITS,
  UNIT_LABELS,
  weatherHoursIn,
  type PackSection,
} from '@sitelog/shared';
import {
  Bullets,
  fmtDateTimeIn,
  fmtPhotoTime,
  Footer,
  imageSrc,
  ManpowerTable,
  PhotoGrid,
  RunningHeader,
  Section,
  Table,
  WeatherTable,
  statusLabel,
} from './components';
import { pdfCopy, upper, type PdfCopy } from './copy';
import { registerFonts } from './fonts';
import { pageSize } from './ReportDocument';
import { styles } from './styles';
import type { EvidenceDay, EvidencePackInput, PackExcerpt } from './types';

/** The day blocks a section list prints, in order (F20 "included sections"). */
const DAY_SECTIONS = ['reports', 'transcripts', 'photos', 'weather'] as const;

/** Two-digit section numbers for the included day blocks: 01, 02 … */
const no = (i: number) => String(i + 1).padStart(2, '0');

/**
 * F20 — the EOT evidence pack, in the org's report language (§9.6; EN or TR) and paper (§12), with
 * the org's units for observed weather (§10.11): a cover, the delay summary, and a page per day
 * with that day's report, transcript excerpts (each from one clip: a voice note, or the
 * reporter's lane of a call), photos and observed weather. Only the sections the office ticked
 * print. Every day states how its report was confirmed (spec §19 Q134).
 */
export function EvidencePack({ input }: { input: EvidencePackInput }) {
  registerFonts();
  const copy = pdfCopy(input.language);
  const p = copy.pack;
  const { org, site, days } = input;
  const tz = site.timezone;
  const sections = new Set<PackSection>(input.sections);
  const totalLost = Math.round(days.reduce((a, d) => a + d.lostHours, 0) * 100) / 100;
  const claimReady = days.filter((d) => d.claimReady).length;
  const confirmed = days.filter((d) => confirmedBySiteManager(d.confirmation)).length;
  const size = pageSize(input.settings.paper);
  const short = (d: string) => formatDate(d, 'short', copy.lang);
  const long = (d: string) => formatDate(d, 'long', copy.lang);
  const running = p.running(short(input.periodStart), short(input.periodEnd));
  const perDay = DAY_SECTIONS.some((s) => sections.has(s));
  return (
    <Document
      title={p.docTitle(site.name, input.periodStart, input.periodEnd)}
      author={org.name}
      creator="SiteLog"
      producer="SiteLog"
      language={copy.intl}
    >
      <Page size={size} style={styles.page}>
        <RunningHeader left={`${org.name} · ${site.name}`} right={running} />
        <Footer showWeather footerEnabled copy={copy} />
        <View style={styles.letterhead}>
          <View>
            {org.logo ? (
              <Image style={styles.logo} src={imageSrc(org.logo)} />
            ) : (
              <Text style={styles.orgName}>{org.name}</Text>
            )}
          </View>
          <View style={styles.badgeWrap}>
            <Text style={styles.badge}>{p.badge}</Text>
          </View>
        </View>
        <View style={styles.rule} />
        <Text style={styles.coverTitle}>{site.name}</Text>
        <Text style={styles.coverSub}>
          {p.coverSub(long(input.periodStart), long(input.periodEnd))}
        </Text>
        <View style={styles.metaGrid}>
          {[
            [p.meta.projectNo, site.projectCode],
            [p.meta.address, site.address ?? '—'],
            [p.meta.days, String(days.length)],
            [p.meta.hoursLost, copy.hours(totalLost)],
            [p.meta.claimReady, p.of(claimReady, days.length)],
            [p.meta.confirmed, p.of(confirmed, days.length)],
            [p.meta.generated, fmtDateTimeIn(input.generatedAt, tz, copy)],
          ].map(([k, v]) => (
            <View key={k} style={styles.metaCell}>
              <Text style={styles.eyebrow}>{upper(copy, k!)}</Text>
              <Text style={styles.metaValue}>{v}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.body}>{p.coverBody}</Text>
        <Text style={[styles.footnote, { marginTop: 10 }]}>{p.attribution}</Text>
      </Page>

      {sections.has('summary') ? (
        <Page size={size} style={styles.page}>
          <RunningHeader left={`${org.name} · ${site.name}`} right={running} />
          <Footer showWeather footerEnabled copy={copy} />
          <Section no="01" title={p.summaryTitle} copy={copy}>
            <Table
              copy={copy}
              cols={[
                { key: 'date', label: p.cols.date, width: '12%', mono: true },
                { key: 'report', label: p.cols.report, width: '17%', mono: true },
                { key: 'condition', label: p.cols.condition, width: '15%' },
                { key: 'impact', label: p.cols.impact, width: '24%' },
                { key: 'lost', label: p.cols.lost, width: '9%', align: 'right', mono: true },
                { key: 'evidence', label: p.cols.evidence, width: '9%', mono: true },
                { key: 'confirmed', label: p.cols.confirmed, width: '14%' },
              ]}
              rows={days.map((d) => ({
                date: short(d.date),
                report: `${d.reportNo} v${d.version}`,
                condition:
                  d.data.weather.periods.map((x) => x.condition).join(', ') ||
                  d.data.weather.conditionsText,
                impact: d.fullDay
                  ? p.fullDayLost
                  : d.data.weather.periods
                      .map((x) => x.impact)
                      .filter(Boolean)
                      .join('; ') || '—',
                lost: copy.hours(d.lostHours),
                evidence: evidenceMarks(d, copy),
                confirmed: p.confirmedShort[d.confirmation],
              }))}
              total={{
                date: p.total,
                lost: copy.hours(totalLost),
                evidence: `${claimReady}/${days.length}`,
              }}
            />
            <Text style={styles.footnote}>{p.legend}</Text>
          </Section>
        </Page>
      ) : null}

      {perDay
        ? days.map((d) => (
            <Page key={`${d.date}:${d.reportNo}`} size={size} style={styles.page}>
              <RunningHeader
                left={`${org.name} · ${site.name}`}
                right={`${d.reportNo} · ${long(d.date)}`}
              />
              <Footer showWeather footerEnabled copy={copy} />
              <View style={styles.dayHeader}>
                <Text style={styles.dayTitle}>{long(d.date)}</Text>
                <Text style={styles.tdMono}>
                  {p.dayLine(
                    d.reportNo,
                    d.version,
                    d.signedOff,
                    copy.hours(d.lostHours),
                    d.claimReady,
                  )}
                </Text>
              </View>
              <Text style={[styles.body, { marginBottom: 8 }]}>
                {confirmationLine(d, tz, copy)}
              </Text>
              {daySections(d, sections, tz, copy, input.units)}
            </Page>
          ))
        : null}
    </Document>
  );
}

/** "APW" · "SFH": audio with timestamp, photo, observed weather; "-" for each one missing. */
function evidenceMarks(d: EvidenceDay, copy: PdfCopy): string {
  const l = copy.pack.letters;
  return `${d.audioCount ? l.audio : '-'}${d.photoCount ? l.photo : '-'}${d.observed ? l.weather : '-'}`;
}

/**
 * The day's confirmation sentence (spec §19 Q134): how it was confirmed and when (site time,
 * with the date when it was another day), the sign-off, and for a report nobody confirmed that
 * the office has not signed off, that it is not claim-ready until then.
 */
export function confirmationLine(d: EvidenceDay, tz: string, copy: PdfCopy): string {
  const stamp = (iso: string | null) => (iso ? fmtPhotoTime(iso, tz, d.date, copy) : null);
  const siteManager = confirmedBySiteManager(d.confirmation);
  const at = stamp(siteManager && d.confirmedAt ? d.confirmedAt : d.filedAt);
  const parts = [copy.pack.confirmation(d.confirmation, at, d.typed)];
  if (d.signedOff && d.signedOffByName && d.signedOffAt)
    parts.push(`${copy.signoff.signedOff(d.signedOffByName, stamp(d.signedOffAt)!)}.`);
  else if (!d.signedOff && !siteManager) parts.push(copy.pack.notReadyUntilSignedOff);
  return parts.join(' ');
}

/** "voice note 0:41–0:52", "voice note 2 · 0:05–0:12", "call 2:15–2:22". */
export function excerptLabel(e: PackExcerpt, copy: PdfCopy): string {
  const ts = `${formatAudioTimestamp(e.start)}–${formatAudioTimestamp(e.end)}`;
  return copy.pack.clip(e.clip, e.clipNo, ts);
}

function daySections(
  d: EvidenceDay,
  sections: Set<PackSection>,
  tz: string,
  copy: PdfCopy,
  units: EvidencePackInput['units'],
) {
  const p = copy.pack;
  const blocks: Array<{ title: string; body: ReactNode }> = [];
  if (sections.has('reports')) {
    blocks.push(
      {
        title: p.sections.summary,
        body: <Text>{d.data.summary || copy.noSummary}</Text>,
      },
      { title: p.sections.weather, body: <WeatherTable data={d.data} copy={copy} /> },
      {
        title: p.sections.manpower,
        body: <ManpowerTable data={d.data} companies={[]} copy={copy} />,
      },
      {
        title: p.sections.work,
        body: (
          <Bullets
            copy={copy}
            items={d.data.workPerformed.map(
              (w) =>
                `${w.area ? `${w.area}: ` : ''}${w.activity} (${statusLabel(copy, w.status, w.percentComplete)})`,
            )}
          />
        ),
      },
    );
  }
  if (sections.has('transcripts')) {
    blocks.push({
      title: p.sections.transcripts,
      body:
        d.transcriptExcerpts.length === 0 ? (
          <Text style={styles.muted}>{p.noVoice}</Text>
        ) : (
          d.transcriptExcerpts.map((e, i) => (
            <View key={i} style={styles.excerpt}>
              <Text style={styles.excerptTs}>{excerptLabel(e, copy)}</Text>
              <Text style={styles.excerptText}>
                {copy.lang === 'tr' ? `“${e.text}”` : `"${e.text}"`}
              </Text>
            </View>
          ))
        ),
    });
  }
  if (sections.has('photos')) {
    blocks.push({
      title: p.sections.photos,
      body: <PhotoGrid photos={d.photos} tz={tz} date={d.date} copy={copy} />,
    });
  }
  if (sections.has('weather')) {
    blocks.push({
      title: p.sections.observed,
      body: <ObservedTable d={d} copy={copy} units={units} />,
    });
  }
  return blocks.map((b, i) => (
    <Section key={b.title} no={no(i)} title={b.title} copy={copy}>
      {b.body}
    </Section>
  ));
}

/** Hourly observed weather, 05:00–18:00, in the org's units and the report language's numbers. */
function ObservedTable({
  d,
  copy,
  units,
}: {
  d: EvidenceDay;
  copy: PdfCopy;
  units: EvidencePackInput['units'];
}) {
  const p = copy.pack;
  if (!d.observed) return <Text style={styles.muted}>{p.noObserved}</Text>;
  const unit = UNIT_LABELS[units];
  const digits = MEASURE_DIGITS[units].precipitation;
  const fixed = new Intl.NumberFormat(copy.intl, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
  const n = (v: number | null) => (v === null ? '—' : copy.num(v, 0));
  return (
    <Table
      copy={copy}
      cols={[
        { key: 'time', label: p.observedCols.time, width: '16%', mono: true },
        {
          key: 'precip',
          label: `${p.observedCols.precip} (${unit.precipitation})`,
          width: '21%',
          align: 'right',
          mono: true,
        },
        {
          key: 'temp',
          label: `${p.observedCols.temp} (${unit.temperature})`,
          width: '21%',
          align: 'right',
          mono: true,
        },
        {
          key: 'wind',
          label: `${p.observedCols.wind} (${unit.wind})`,
          width: '21%',
          align: 'right',
          mono: true,
        },
        {
          key: 'gust',
          label: `${p.observedCols.gusts} (${unit.wind})`,
          width: '21%',
          align: 'right',
          mono: true,
        },
      ]}
      rows={weatherHoursIn(d.observed, units)
        .filter((h) => Number(h.time.slice(0, 2)) >= 5 && Number(h.time.slice(0, 2)) <= 18)
        .map((h) => ({
          time: h.time,
          precip: fixed.format(h.precip),
          temp: n(h.temp),
          wind: n(h.wind),
          gust: n(h.gust),
        }))}
    />
  );
}
