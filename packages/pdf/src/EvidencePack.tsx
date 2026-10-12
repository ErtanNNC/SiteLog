import { Document, Image, Page, Text, View } from '@react-pdf/renderer';
import {
  formatAudioTimestamp,
  formatDateLong,
  formatDateShort,
  formatHours,
} from '@sitelog/shared';
import {
  Bullets,
  fmtDateTime,
  Footer,
  imageSrc,
  ManpowerTable,
  PhotoGrid,
  RunningHeader,
  Section,
  Table,
  WeatherTable,
} from './components';
import { registerFonts } from './fonts';
import { styles } from './styles';
import type { EvidencePackInput } from './types';

/** §F16 — EOT evidence pack: cover, delay summary, each day's report, transcript excerpts, photos, observed weather. */
export function EvidencePack({ input }: { input: EvidencePackInput }) {
  registerFonts();
  const { org, site, days } = input;
  const tz = site.timezone;
  const totalLost = Math.round(days.reduce((a, d) => a + d.lostHours, 0) * 100) / 100;
  const claimReady = days.filter((d) => d.claimReady).length;
  const size = input.settings.paper === 'a4' ? 'A4' : 'LETTER';
  return (
    <Document
      title={`EOT evidence pack — ${site.name} ${input.periodStart}–${input.periodEnd}`}
      author={org.name}
      creator="SiteLog"
      producer="SiteLog"
    >
      <Page size={size} style={styles.page}>
        <RunningHeader
          left={`${org.name} · ${site.name}`}
          right={`Evidence pack · ${formatDateShort(input.periodStart)} – ${formatDateShort(input.periodEnd)}`}
        />
        <Footer showWeather footerEnabled />
        <View style={styles.letterhead}>
          <View>
            {org.logo ? (
              <Image style={styles.logo} src={imageSrc(org.logo)} />
            ) : (
              <Text style={styles.orgName}>{org.name}</Text>
            )}
          </View>
          <View style={styles.badgeWrap}>
            <Text style={styles.badge}>WEATHER DELAY EVIDENCE</Text>
          </View>
        </View>
        <View style={styles.rule} />
        <Text style={styles.coverTitle}>{site.name}</Text>
        <Text style={styles.coverSub}>
          Extension-of-time evidence pack · {formatDateLong(input.periodStart)} to{' '}
          {formatDateLong(input.periodEnd)}
        </Text>
        <View style={styles.metaGrid}>
          {[
            ['Project no.', site.projectCode],
            ['Address', site.address ?? '—'],
            ['Weather-affected days', String(days.length)],
            ['Hours lost', formatHours(totalLost)],
            ['Claim-ready days', `${claimReady} of ${days.length}`],
            ['Generated', fmtDateTime(input.generatedAt, tz)],
          ].map(([k, v]) => (
            <View key={k} style={styles.metaCell}>
              <Text style={styles.eyebrow}>{k}</Text>
              <Text style={styles.metaValue}>{v}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.body}>
          This pack collects the daily site reports, the site manager's voice-note transcript
          excerpts, dated photographs and observed weather data for every day in the period on which
          weather stopped or reassigned work. Each report was confirmed by the site manager on
          WhatsApp{days.some((d) => d.signedOff) ? ' and signed off by the office' : ''}. Audio
          recordings are retained and available on request.
        </Text>
        <Text style={[styles.footnote, { marginTop: 10 }]}>
          Weather data: Open-Meteo (CC BY 4.0), hourly values for the site location. Claim-ready =
          voice evidence + photo + observed weather data.
        </Text>
      </Page>

      <Page size={size} style={styles.page}>
        <RunningHeader
          left={`${org.name} · ${site.name}`}
          right={`Evidence pack · ${formatDateShort(input.periodStart)} – ${formatDateShort(input.periodEnd)}`}
        />
        <Footer showWeather footerEnabled />
        <Section no="01" title="Delay summary by day">
          <Table
            cols={[
              { key: 'date', label: 'Date', width: '17%', mono: true },
              { key: 'report', label: 'Report', width: '17%', mono: true },
              { key: 'condition', label: 'Condition', width: '20%' },
              { key: 'impact', label: 'Impact', width: '26%' },
              { key: 'lost', label: 'Lost', width: '9%', align: 'right', mono: true },
              { key: 'evidence', label: 'Evidence', width: '11%', mono: true },
            ]}
            rows={days.map((d) => ({
              date: formatDateShort(d.date),
              report: `${d.reportNo} v${d.version}`,
              condition:
                d.data.weather.periods.map((p) => p.condition).join(', ') ||
                d.data.weather.conditionsText,
              impact: d.fullDay
                ? 'Full day lost'
                : d.data.weather.periods
                    .map((p) => p.impact)
                    .filter(Boolean)
                    .join('; ') || '—',
              lost: formatHours(d.lostHours),
              evidence: `${d.audioCount ? 'A' : '-'}${d.photoCount ? 'P' : '-'}${d.observed ? 'W' : '-'}`,
            }))}
            total={{
              date: 'Total',
              lost: formatHours(totalLost),
              evidence: `${claimReady}/${days.length}`,
            }}
          />
          <Text style={styles.footnote}>
            Evidence: A = audio with timestamp · P = photo · W = observed weather data.
          </Text>
        </Section>
      </Page>

      {days.map((d) => (
        <Page key={d.date} size={size} style={styles.page}>
          <RunningHeader
            left={`${org.name} · ${site.name}`}
            right={`${d.reportNo} · ${formatDateLong(d.date)}`}
          />
          <Footer showWeather footerEnabled />
          <View style={styles.dayHeader}>
            <Text style={styles.dayTitle}>{formatDateLong(d.date)}</Text>
            <Text style={styles.tdMono}>
              {d.reportNo} v{d.version} · {d.signedOff ? 'signed off' : 'filed'} ·{' '}
              {formatHours(d.lostHours)} lost{d.claimReady ? ' · claim-ready' : ''}
            </Text>
          </View>
          <Section no="01" title="Summary">
            <Text>{d.data.summary || 'No summary.'}</Text>
          </Section>
          <Section no="02" title="Weather & delays">
            <WeatherTable data={d.data} />
          </Section>
          <Section no="03" title="Manpower on site">
            <ManpowerTable data={d.data} companies={[]} />
          </Section>
          <Section no="04" title="Work performed">
            <Bullets
              items={d.data.workPerformed.map(
                (w) =>
                  `${w.area ? `${w.area}: ` : ''}${w.activity} (${w.status.replace('_', ' ')})`,
              )}
            />
          </Section>
          <Section no="05" title="Transcript excerpts">
            {d.transcriptExcerpts.length === 0 ? (
              <Text style={styles.muted}>No voice note for this day.</Text>
            ) : (
              d.transcriptExcerpts.map((e, i) => (
                <View key={i} style={styles.excerpt}>
                  <Text style={styles.excerptTs}>
                    {formatAudioTimestamp(e.start)}–{formatAudioTimestamp(e.end)}
                  </Text>
                  <Text style={styles.excerptText}>"{e.text}"</Text>
                </View>
              ))
            )}
          </Section>
          <Section no="06" title="Photos">
            <PhotoGrid photos={d.photos} tz={tz} />
          </Section>
          <Section no="07" title="Observed weather (hourly)">
            {d.observed ? (
              <Table
                cols={[
                  { key: 'time', label: 'Time', width: '16%', mono: true },
                  { key: 'precip', label: 'Precip (in)', width: '21%', align: 'right', mono: true },
                  { key: 'temp', label: 'Temp (°F)', width: '21%', align: 'right', mono: true },
                  { key: 'wind', label: 'Wind (mph)', width: '21%', align: 'right', mono: true },
                  { key: 'gust', label: 'Gusts (mph)', width: '21%', align: 'right', mono: true },
                ]}
                rows={d.observed.hours
                  .filter(
                    (h) => Number(h.time.slice(0, 2)) >= 5 && Number(h.time.slice(0, 2)) <= 18,
                  )
                  .map((h) => ({
                    time: h.time,
                    precip: h.precipIn.toFixed(2),
                    temp: h.tempF ?? '—',
                    wind: h.windMph ?? '—',
                    gust: h.gustMph ?? '—',
                  }))}
              />
            ) : (
              <Text style={styles.muted}>No observed weather data for this day.</Text>
            )}
          </Section>
        </Page>
      ))}
    </Document>
  );
}
