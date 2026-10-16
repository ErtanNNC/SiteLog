import { formatTimeInTz } from '@sitelog/shared/format.ts';
import { isReporterAuthor } from '@sitelog/shared/enums.ts';
import type { ReportDetail } from '@/data/types';
import type { CopyKey } from '@/i18n/keys';

/** One phrase of panel copy: its key and values, worded by the page's `t()`. */
export interface Phrase {
  key: CopyKey;
  vars?: Record<string, string | number>;
}

/** Words a phrase list with `t`, joined with " · ". */
export function wordPhrases(
  t: (key: CopyKey, vars?: Record<string, string | number>) => string,
  phrases: readonly Phrase[],
): string {
  return phrases.map((p) => t(p.key, p.vars)).join(' · ');
}

/** A clip's or call's length as a phrase: "48 s", "2 min", "2 min 05 s" (P7). */
export function durationPhrase(seconds: number): Phrase {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return { key: 'report.duration.seconds', vars: { s } };
  if (s === 0) return { key: 'report.duration.minutes', vars: { m } };
  return { key: 'report.duration.minutesSeconds', vars: { m, s: String(s).padStart(2, '0') } };
}

/**
 * P7 provenance line: who reported, by which channel and when, how it was confirmed, every later
 * version and the sign-off. "Reported by Marco Ruiz · voice note via text link at 17:38 ·
 * confirmed on the recorder 17:43 · edited 20:10" / "Reported by Aisha Bello · phone call 18:41
 * (2 min 05 s) · confirmed by voice". A WhatsApp-era report (no channel, D13) keeps its v1.0
 * wording; a report typed in the panel says who entered it.
 *
 * `duration` words a call's length (the page passes `durationPhrase` through `t`).
 */
export function provenancePhrases(
  detail: ReportDetail,
  enteredBy: string | null,
  duration: (seconds: number) => string,
): Phrase[] {
  const r = detail.report;
  const tz = detail.site.timezone;
  const at = (iso: string) => formatTimeInTz(iso, tz);
  const name = detail.reporter?.name ?? '—';
  const out: Phrase[] = [];

  if (enteredBy && r.filedAt) {
    out.push({
      key: 'report.provenance.enteredBy',
      vars: { name: enteredBy, time: at(r.filedAt) },
    });
  } else if (r.channel === null) {
    if (r.receivedAt)
      out.push({ key: 'report.provenance.viaWhatsApp', vars: { name, time: at(r.receivedAt) } });
  } else {
    out.push({ key: 'report.provenance.reportedBy', vars: { name } });
    const call = detail.clips.find((c) => c.kind === 'call');
    if (r.channel === 'voice') {
      const start = call?.receivedAt ?? r.receivedAt;
      // W3-05: a phone call in or out, or Talk now in the recorder (a browser call).
      const how =
        call?.call?.transport === 'web'
          ? 'viaBrowserCall'
          : call?.call?.direction === 'outbound'
            ? 'viaCallOut'
            : 'viaCall';
      if (start && call && call.durationS > 0)
        out.push({
          key: `report.provenance.${how}`,
          vars: { time: at(start), duration: duration(call.durationS) },
        });
      else if (start)
        out.push({ key: `report.provenance.${how}NoLength`, vars: { time: at(start) } });
      // §9.4 rule 9: the call switched to the simple recording.
      if (call?.call?.outcome === 'fallback_recording')
        out.push({ key: 'report.provenance.fallbackRecording' });
    } else if (r.channel === 'sms') {
      if (r.receivedAt)
        out.push({ key: 'report.provenance.viaText', vars: { time: at(r.receivedAt) } });
    } else if (r.receivedAt) {
      out.push({ key: 'report.provenance.viaLink', vars: { time: at(r.receivedAt) } });
    }
  }

  // Typed in the panel: there is no confirmation by the site manager to report.
  if (!enteredBy) {
    if (r.confirmedAt) {
      const time = at(r.confirmedAt);
      const via = r.confirmedVia ?? (r.channel === null ? null : r.channel);
      if (via === 'web') out.push({ key: 'report.provenance.confirmedOnRecorder', vars: { time } });
      else if (via === 'voice') out.push({ key: 'report.provenance.confirmedByVoice' });
      else if (via === 'sms')
        out.push({ key: 'report.provenance.confirmedByText', vars: { time } });
      else out.push({ key: 'report.provenance.confirmed', vars: { time } });
    } else if (r.filedAt) {
      out.push({ key: 'report.provenance.filedWithoutConfirmation' });
    }
  }

  for (const v of detail.versions) {
    if (v.version === 1) continue;
    const time = at(v.createdAt);
    if (isReporterAuthor(v.author)) {
      const via = v.via ?? null;
      if (via === 'voice') out.push({ key: 'report.provenance.editedOnCall', vars: { time } });
      else if (via === null && r.channel === null)
        out.push({ key: 'report.provenance.editedByReply', vars: { time } });
      else out.push({ key: 'report.provenance.edited', vars: { time } });
    } else if (v.author === 'office_user') {
      out.push({ key: 'report.provenance.editedBy', vars: { name: v.authorName, time } });
    }
  }
  if (r.status === 'signed_off' && r.signedOffAt)
    out.push({
      key: 'report.provenance.signedOff',
      vars: { name: r.signedOffByName ?? '—', time: at(r.signedOffAt) },
    });
  return out;
}
