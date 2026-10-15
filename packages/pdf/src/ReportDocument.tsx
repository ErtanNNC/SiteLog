import { Document, Image, Page, Text, View } from '@react-pdf/renderer';
import { UNIT_LABELS } from '@sitelog/shared';
import {
  Bullets,
  imageSrc,
  fmtPhotoTime,
  Footer,
  ManpowerTable,
  PhotoGrid,
  RunningHeader,
  Section,
  WeatherTable,
  WorkTable,
} from './components';
import { pdfCopy, upper, type PdfCopy, type SourceChannel } from './copy';
import { registerFonts } from './fonts';
import { INK, styles } from './styles';
import type { ReportPdfInput } from './types';

/** react-pdf page size for `org_settings.pdf_paper` (§12: Letter or A4, preset from the pack). */
export function pageSize(paper: ReportPdfInput['settings']['paper']): 'A4' | 'LETTER' {
  return paper === 'a4' ? 'A4' : 'LETTER';
}

/**
 * The letterhead's second line (§12: "address/license/tax line"): the parts the org has, joined.
 */
export function letterheadLine(org: ReportPdfInput['org'], copy: PdfCopy): string | null {
  const parts = [
    org.address,
    org.licenseNo ? copy.license(org.licenseNo) : null,
    org.taxNo ? copy.taxNo(org.taxNo) : null,
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : null;
}

/** How the report reached SiteLog: typed in the panel, a v1.2 channel, or v1.0 WhatsApp (null). */
export function sourceChannel(input: ReportPdfInput): SourceChannel {
  if (input.enteredBy != null) return 'office';
  return input.report.channel ?? 'whatsapp_legacy';
}

/** The manpower footnotes and version notes (§12 page 1, "03 … + footnote for answers/edits"). */
export function manpowerFootnotes(input: ReportPdfInput, copy: PdfCopy): string[] {
  const { data, report } = input;
  const tz = input.site.timezone;
  const stamp = (iso: string) => fmtPhotoTime(iso, tz, data.reportDate, copy);
  const out: string[] = [];
  for (const m of data.manpower) {
    const answer = m.source.find((s) => s.type === 'answer');
    if (!answer) continue;
    const a = input.answers?.[answer.questionId];
    out.push(
      copy.answerNote(m.companyName, a?.field ?? null, a?.answeredAt ? stamp(a.answeredAt) : null),
    );
  }
  for (const e of input.edits)
    if (e.version > 1 && e.version <= report.version)
      out.push(copy.editNote(e.version, e.author, e.changeNote, stamp(e.createdAt)));
  return out;
}

/** §12 — the two-page daily site report, in the report language (EN or TR, D34). */
export function ReportDocument({ input }: { input: ReportPdfInput }) {
  registerFonts();
  const { org, site, report, data } = input;
  const copy = pdfCopy(data.reportLanguage);
  const tz = site.timezone;
  const stamp = (iso: string) => fmtPhotoTime(iso, tz, data.reportDate, copy);
  const badge = copy.badge[report.kind] ?? copy.badge.daily;
  const current = input.edits.find((e) => e.version === report.version);
  const filedLine = report.filedAt
    ? copy.filed(
        stamp(report.filedAt),
        report.version > 1 && current ? stamp(current.createdAt) : null,
      )
    : copy.draft;
  const observed = data.weather.observed;
  const weatherShort = [
    data.weather.periods.length
      ? data.weather.periods
          .map((p) => `${p.condition}${p.lostHours > 0 ? ` · ${copy.lost(p.lostHours)}` : ''}`)
          .join('; ')
      : data.weather.conditionsText || copy.notStated,
    observed
      ? `${observed.tempMin}–${observed.tempMax} ${UNIT_LABELS[data.units].temperature}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const footnotes = manpowerFootnotes(input, copy);
  const photos = input.photos.slice(0, input.settings.maxPhotos);
  const nextItems = data.nextWorkday.map((n) => n.item);
  const deliveries = data.deliveries.map(
    (d) =>
      `${d.item}${d.quantity ? `, ${d.quantity}` : ''}${d.supplier ? ` (${d.supplier})` : ''}${d.time ? ` · ${d.time}` : ''}`,
  );
  const safety: string[] = [];
  if (data.safety.toolboxTalk) safety.push(copy.safety.toolboxTalk(data.safety.toolboxTalk));
  for (const inc of data.safety.incidents)
    safety.push(`${copy.safety.severity[inc.severity] ?? inc.severity}: ${inc.description}`);
  if (data.safety.noIncidentsStated) safety.push(copy.safety.noIncidents);
  if (data.safety.visitors.length)
    safety.push(copy.safety.visitors(data.safety.visitors.join(', ')));
  const issues = data.issues.map((i) => `${i.description}${i.impact ? ` — ${i.impact}` : ''}`);
  const src = input.sources;
  const channel = sourceChannel(input);
  const office = channel === 'office';
  const via: SourceChannel = report.confirmedVia ?? (office ? 'office' : channel);
  const sourceText = copy.sourceRecord(
    {
      channel,
      audioCount: src.audioCount,
      audioSeconds: src.totalAudioSeconds,
      languages: src.languages,
      textCount: src.textCount,
      photoCount: data.photos.length || photos.length,
      receivedAt: src.receivedAt ? stamp(src.receivedAt) : null,
      enteredBy: office ? (input.enteredBy ?? null) : null,
      filedAt: report.filedAt ? stamp(report.filedAt) : null,
    },
    {
      via,
      confirmedAt: report.confirmedAt ? stamp(report.confirmedAt) : null,
      filedAt: report.filedAt ? stamp(report.filedAt) : null,
    },
  );
  const orgLine = letterheadLine(org, copy);
  const so = copy.signoff;

  return (
    <Document
      title={`${report.reportNo} v${report.version} — ${site.name}`}
      author={org.name}
      subject={copy.title}
      creator="SiteLog"
      producer="SiteLog"
    >
      <Page size={pageSize(input.settings.paper)} style={styles.page}>
        <RunningHeader
          left={`${org.name} · ${site.name}`}
          right={`${report.reportNo} · ${copy.dateMedium(data.reportDate)}`}
        />
        <Footer
          showWeather={!!data.weather.observed}
          footerEnabled={input.settings.footerEnabled}
          typed={office}
          copy={copy}
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
            {orgLine ? <Text style={styles.orgLine}>{orgLine}</Text> : null}
            {org.letterheadLines.map((l, i) => (
              <Text key={i} style={styles.orgLine}>
                {l}
              </Text>
            ))}
          </View>
          <View style={styles.badgeWrap}>
            <Text style={styles.badge}>{badge}</Text>
            <Text style={styles.reportNo}>{copy.reportNo(report.reportNo, report.version)}</Text>
          </View>
        </View>
        <View style={styles.rule} />
        <Text style={styles.h1}>{site.name}</Text>

        <View style={styles.metaGrid}>
          {[
            [copy.meta.date, copy.dateFull(data.reportDate)],
            [copy.meta.projectNo, site.projectCode],
            office
              ? [copy.meta.preparedBy, input.enteredBy ?? '—']
              : [copy.meta.siteManager, input.reporterName ?? '—'],
            [
              copy.meta.workingHours,
              data.workingHours
                ? `${data.workingHours.start} – ${data.workingHours.end}`
                : (site.workingHours ?? '—'),
            ],
            [copy.meta.weather, weatherShort],
            [copy.meta.filed, filedLine],
          ].map(([k, v]) => (
            <View key={k} style={styles.metaCell}>
              <Text style={styles.eyebrow}>{upper(copy, k!)}</Text>
              <Text style={styles.metaValue}>{v}</Text>
            </View>
          ))}
        </View>

        <Section no="01" title={copy.sections.summary} copy={copy}>
          <Text style={styles.body}>{data.summary || copy.noSummary}</Text>
          {report.isLate ? (
            <Text style={[styles.footnote, { marginTop: 3 }]}>{copy.late}</Text>
          ) : null}
        </Section>

        <Section no="02" title={copy.sections.weather} copy={copy}>
          <WeatherTable data={data} copy={copy} />
        </Section>

        <Section no="03" title={copy.sections.manpower} copy={copy}>
          <ManpowerTable data={data} companies={input.companies} copy={copy} />
          {footnotes.map((f, i) => (
            <Text key={i} style={styles.footnote}>
              {f}
            </Text>
          ))}
        </Section>

        <Section no="04" title={copy.sections.work} break copy={copy}>
          <WorkTable data={data} copy={copy} />
        </Section>

        <View style={styles.columns}>
          <View style={styles.column}>
            <Section no="05" title={copy.sections.deliveries} copy={copy}>
              <Bullets items={deliveries} copy={copy} />
            </Section>
          </View>
          <View style={styles.column}>
            <Section no="06" title={copy.sections.safety} copy={copy}>
              <Bullets items={safety} copy={copy} />
            </Section>
          </View>
          <View style={styles.column}>
            <Section no="07" title={copy.sections.next} copy={copy}>
              <Bullets items={nextItems} copy={copy} />
            </Section>
          </View>
        </View>
        {issues.length ? (
          <Section no="07b" title={copy.sections.issues} copy={copy}>
            <Bullets items={issues} copy={copy} />
          </Section>
        ) : null}

        <Section no="08" title={copy.sections.photos} copy={copy}>
          <PhotoGrid photos={photos} tz={tz} date={data.reportDate} copy={copy} />
        </Section>

        <Section no="09" title={copy.sections.source} copy={copy}>
          <Text style={styles.body}>{sourceText}</Text>
          {report.reviewReasons.length ? (
            <Text style={styles.footnote}>{copy.reviewFlags(report.reviewReasons.join(', '))}</Text>
          ) : null}
        </Section>

        <View style={styles.signoff} wrap={false}>
          <View style={styles.signBox}>
            <View style={styles.signLine}>
              <Text style={styles.signLineText}>
                {office
                  ? so.entered(report.filedAt ? stamp(report.filedAt) : null)
                  : report.confirmedAt
                    ? so.confirmed(via, stamp(report.confirmedAt))
                    : so.notConfirmed}
              </Text>
            </View>
            <Text style={styles.signCaption}>
              <Text style={styles.signRole}>{office ? so.preparedBy : so.siteManager}</Text>
              {` · ${(office ? input.enteredBy : input.reporterName) ?? '—'}`}
            </Text>
          </View>
          <View style={styles.signBox}>
            <View style={styles.signLine}>
              <Text style={styles.signLineText}>
                {report.signedOffAt
                  ? so.signedOff(report.signedOffByName ?? '—', stamp(report.signedOffAt))
                  : ' '}
              </Text>
            </View>
            <Text style={styles.signCaption}>
              <Text style={styles.signRole}>{so.projectManager}</Text>
              {report.signedOffAt ? '' : ` · ${so.signatureAndDate}`}
            </Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
