import { Document, Image, Page, Text, View } from '@react-pdf/renderer';
import { formatDateLong, formatDuration, isReporterAuthor } from '@sitelog/shared';
import {
  Bullets,
  imageSrc,
  fmtDateTime,
  fmtTime,
  Footer,
  ManpowerTable,
  PhotoGrid,
  RunningHeader,
  Section,
  WeatherTable,
  WorkTable,
} from './components';
import { registerFonts } from './fonts';
import { INK, styles } from './styles';
import type { ReportPdfInput } from './types';

/** §12 — the two-page daily site report. */
export function ReportDocument({ input }: { input: ReportPdfInput }) {
  registerFonts();
  const { org, site, report, data } = input;
  const tz = site.timezone;
  const badge =
    report.kind === 'weather_day'
      ? 'WEATHER DAY REPORT'
      : report.kind === 'no_work'
        ? 'NO WORK REPORT'
        : 'DAILY SITE REPORT';
  const filedLine = report.signedOffAt
    ? `Signed off ${fmtDateTime(report.signedOffAt, tz)}`
    : report.filedAt
      ? `Filed ${fmtDateTime(report.filedAt, tz)}${report.version > 1 ? ` · edited v${report.version}` : ''}`
      : 'Draft';
  const weatherShort = data.weather.periods.length
    ? data.weather.periods
        .map((p) => `${p.condition}${p.lostHours > 0 ? ` · ${p.lostHours} h lost` : ''}`)
        .join('; ')
    : data.weather.conditionsText || 'Not stated';
  const edits = input.edits.filter((e) => e.version > 1);
  const footnotes: string[] = [];
  if (data.manpower.some((m) => m.source.some((s) => s.type === 'answer')))
    footnotes.push(
      'Confirmed by reply: the value was confirmed by the site manager in a WhatsApp reply.',
    );
  for (const e of edits)
    footnotes.push(
      `v${e.version} · ${e.author === 'office_user' ? 'office edit' : isReporterAuthor(e.author) ? 'edit by reply' : 'update'}${e.changeNote ? `: ${e.changeNote}` : ''} · ${fmtDateTime(e.createdAt, tz)}`,
    );
  const photos = input.photos.slice(0, input.settings.maxPhotos);
  const nextItems = data.nextWorkday.map((n) => n.item);
  const deliveries = data.deliveries.map(
    (d) =>
      `${d.item}${d.quantity ? `, ${d.quantity}` : ''}${d.supplier ? ` (${d.supplier})` : ''}${d.time ? ` · ${d.time}` : ''}`,
  );
  const safety: string[] = [];
  if (data.safety.toolboxTalk) safety.push(`Toolbox talk: ${data.safety.toolboxTalk}`);
  for (const inc of data.safety.incidents)
    safety.push(`${inc.severity.replace('_', ' ')}: ${inc.description}`);
  if (data.safety.noIncidentsStated) safety.push('No incidents reported.');
  if (data.safety.visitors.length) safety.push(`Visitors: ${data.safety.visitors.join(', ')}`);
  const issues = data.issues.map((i) => `${i.description}${i.impact ? ` — ${i.impact}` : ''}`);
  const src = input.sources;
  const office = input.enteredBy != null;
  const sourceParagraph = [
    src.audioCount > 0
      ? `${src.audioCount} voice note${src.audioCount === 1 ? '' : 's'} (${formatDuration(src.totalAudioSeconds)})`
      : null,
    src.textCount > 0 ? `${src.textCount} text message${src.textCount === 1 ? '' : 's'}` : null,
    src.languages.length
      ? `spoken in ${src.languages.join(' and ').toUpperCase()}, report written in English`
      : null,
    office ? `entered in SiteLog by ${input.enteredBy}` : null,
    src.receivedAt && !office ? `received ${fmtDateTime(src.receivedAt, tz)}` : null,
    office && report.filedAt
      ? `filed ${fmtDateTime(report.filedAt, tz)}`
      : report.confirmedAt
        ? `confirmed via WhatsApp ${fmtDateTime(report.confirmedAt, tz)}`
        : report.filedAt
          ? `filed ${fmtDateTime(report.filedAt, tz)} without confirmation`
          : null,
    `${photos.length} photo${photos.length === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const sourceText = office
    ? `${sourceParagraph[0]!.toUpperCase()}${sourceParagraph.slice(1)}.`
    : `${sourceParagraph}. Audio and transcript retained in SiteLog.`;

  return (
    <Document
      title={`${report.reportNo} v${report.version} — ${site.name}`}
      author={org.name}
      subject="Daily site report"
      creator="SiteLog"
      producer="SiteLog"
    >
      <Page size={input.settings.paper === 'a4' ? 'A4' : 'LETTER'} style={styles.page}>
        <RunningHeader
          left={`${org.name} · ${site.name}`}
          right={`${report.reportNo} · ${formatDateLong(data.reportDate)}`}
        />
        <Footer
          showWeather={!!data.weather.observed}
          footerEnabled={input.settings.footerEnabled}
          typed={office}
        />

        <View style={styles.letterhead}>
          <View style={{ maxWidth: '60%' }}>
            {org.logo ? (
              <Image style={styles.logo} src={imageSrc(org.logo)} />
            ) : (
              <Text style={styles.orgName}>{org.name}</Text>
            )}
            {org.logo ? (
              <Text style={[styles.orgLine, { fontWeight: 600, color: INK }]}>{org.name}</Text>
            ) : null}
            {org.address ? <Text style={styles.orgLine}>{org.address}</Text> : null}
            {org.licenseNo ? <Text style={styles.orgLine}>License {org.licenseNo}</Text> : null}
            {org.letterheadLines.map((l, i) => (
              <Text key={i} style={styles.orgLine}>
                {l}
              </Text>
            ))}
          </View>
          <View style={styles.badgeWrap}>
            <Text style={styles.badge}>{badge}</Text>
            <Text style={styles.reportNo}>
              No. {report.reportNo} · v{report.version}
            </Text>
          </View>
        </View>
        <View style={styles.rule} />
        <Text style={styles.h1}>{site.name}</Text>

        <View style={styles.metaGrid}>
          {[
            ['Date', formatDateLong(data.reportDate)],
            ['Project no.', site.projectCode],
            office ? ['Prepared by', input.enteredBy] : ['Site manager', input.reporterName ?? '—'],
            [
              'Working hours',
              data.workingHours
                ? `${data.workingHours.start}–${data.workingHours.end}`
                : (site.workingHours ?? '—'),
            ],
            ['Weather', weatherShort],
            ['Filed / edited', filedLine],
          ].map(([k, v]) => (
            <View key={k} style={styles.metaCell}>
              <Text style={styles.eyebrow}>{k}</Text>
              <Text style={styles.metaValue}>{v}</Text>
            </View>
          ))}
        </View>

        <Section no="01" title="Summary">
          <Text style={styles.body}>{data.summary || 'No summary.'}</Text>
          {report.isLate ? (
            <Text style={[styles.footnote, { marginTop: 3 }]}>
              Filed after the reporting deadline.
            </Text>
          ) : null}
        </Section>

        <Section no="02" title="Weather & delays">
          <WeatherTable data={data} />
        </Section>

        <Section no="03" title="Manpower on site">
          <ManpowerTable data={data} companies={input.companies} />
          {footnotes.map((f, i) => (
            <Text key={i} style={styles.footnote}>
              {f}
            </Text>
          ))}
        </Section>

        <Section no="04" title="Work performed" break>
          <WorkTable data={data} />
        </Section>

        <View style={styles.columns}>
          <View style={styles.column}>
            <Section no="05" title="Deliveries">
              <Bullets items={deliveries} />
            </Section>
          </View>
          <View style={styles.column}>
            <Section no="06" title="Safety">
              <Bullets items={safety} />
            </Section>
          </View>
          <View style={styles.column}>
            <Section no="07" title="Next workday">
              <Bullets items={nextItems} />
            </Section>
          </View>
        </View>
        {issues.length ? (
          <Section no="07b" title="Issues">
            <Bullets items={issues} />
          </Section>
        ) : null}

        <Section no="08" title="Site photos">
          <PhotoGrid photos={photos} tz={tz} date={data.reportDate} />
        </Section>

        <Section no="09" title="Source record">
          <Text style={styles.body}>{sourceText}</Text>
          {report.reviewReasons.length ? (
            <Text style={styles.footnote}>Review flags: {report.reviewReasons.join(', ')}</Text>
          ) : null}
        </Section>

        <View style={styles.signoff} wrap={false}>
          {office ? (
            <View style={styles.signBox}>
              <Text style={styles.eyebrow}>Prepared by</Text>
              <Text>{input.enteredBy}</Text>
              <Text style={styles.muted}>
                {report.filedAt
                  ? `Entered in SiteLog · ${fmtTime(report.filedAt, tz)}`
                  : 'Entered in SiteLog'}
              </Text>
            </View>
          ) : (
            <View style={styles.signBox}>
              <Text style={styles.eyebrow}>Site manager</Text>
              <Text>{input.reporterName ?? '—'}</Text>
              <Text style={styles.muted}>
                {report.confirmedAt
                  ? `Confirmed via WhatsApp · ${fmtTime(report.confirmedAt, tz)}`
                  : 'Not confirmed'}
              </Text>
            </View>
          )}
          <View style={styles.signBox}>
            <Text style={styles.eyebrow}>Project manager</Text>
            {report.signedOffAt ? (
              <>
                <Text>{report.signedOffByName ?? '—'}</Text>
                <Text style={styles.muted}>
                  Signed off in SiteLog · {fmtDateTime(report.signedOffAt, tz)}
                </Text>
              </>
            ) : (
              <>
                <Text> </Text>
                <Text style={styles.muted}>Signature · date</Text>
              </>
            )}
          </View>
        </View>
      </Page>
    </Document>
  );
}
