import {
  Bot,
  FileText,
  HardHat,
  Link2,
  MessageSquareText,
  Mic,
  Phone,
  PhoneMissed,
  UserRound,
} from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { formatAudioTimestamp, formatTimeInTz } from '@sitelog/shared/format.ts';
import {
  MediaPlayer,
  useClipActive,
  useMediaPlayer,
  useSpeakerFilter,
} from '@/components/sitelog/MediaPlayer';
import { TranscriptExcerpt } from '@/components/sitelog/TranscriptExcerpt';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { officeEntryAuthor } from '@/data/pdfInput';
import type {
  ActivityEntry,
  MediaClip,
  ReportDetail,
  TranscriptExcerpt as TranscriptExcerptItem,
  TranscriptSegment,
} from '@/data/types';
import type { CopyKey } from '@/i18n/keys';
import { useLooseCopy, type LooseT } from '@/i18n/useLooseCopy';
import { callExcerptLines, showsSpeaker } from '@/lib/callLanes';
import { formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';
import { durationPhrase } from './provenance';

export interface SourcePanelProps {
  detail: ReportDetail;
  /** An answer's question id (or a v1 reply's message id) to reveal and highlight in Activity. */
  focusAnchor: string | null;
}

/** "ES + EN → EN" (P7): the clip's languages (the report's, for an untranscribed note) → report. */
function languagesLine(detail: ReportDetail, clip: MediaClip, t: LooseT): string | null {
  const codes = clip.languages.length
    ? clip.languages
    : clip.kind === 'voice_note'
      ? detail.data.languageDetected
      : [];
  if (!codes.length) return null;
  return t('player.languages', {
    from: codes.map((c) => c.toUpperCase()).join(' + '),
    to: detail.report.language.toUpperCase(),
  });
}

/** One excerpt per transcript segment: facts mapped from the same quote are joined (max 6). */
function mergedExcerpts(excerpts: readonly TranscriptExcerptItem[]): TranscriptExcerptItem[] {
  const bySegment = new Map<number, TranscriptExcerptItem>();
  for (const e of excerpts) {
    const cur = bySegment.get(e.start);
    if (cur) cur.mapped = `${cur.mapped} · ${e.mapped}`;
    else bySegment.set(e.start, { ...e });
  }
  return [...bySegment.values()].slice(0, 6);
}

/** Aside: Source (a player per clip, transcript excerpts, full transcript drawer) + Activity. */
export function SourcePanel({ detail, focusAnchor }: SourcePanelProps) {
  const { tx: t } = useLooseCopy();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const tz = detail.site.timezone;
  const enteredBy = officeEntryAuthor(detail);
  const clips = detail.clips;
  const calls = clips.filter((c) => c.kind === 'call').length;
  const eyebrow = enteredBy
    ? t('report.aside.typed')
    : clips.length > 1
      ? calls
        ? t('report.aside.recordings', { count: clips.length })
        : t('report.aside.voiceNotes', { count: clips.length })
      : clips[0]?.kind === 'call'
        ? t('report.aside.call')
        : t('report.aside.voiceNote');
  const transcribed = clips.filter((c) => c.transcript);

  return (
    <div className="space-y-4">
      <Card data-testid="source-panel">
        <CardHeader>
          <CardTitle>{t('report.aside.source')}</CardTitle>
          <span className="eyebrow text-dust">{eyebrow}</span>
        </CardHeader>
        <CardContent className="space-y-5 pt-3">
          {clips.length ? (
            clips.map((clip) => (
              <ClipBlock
                key={clip.id}
                detail={detail}
                clip={clip}
                labelled={clips.length > 1}
                t={t}
              />
            ))
          ) : enteredBy ? (
            <p className="text-caption text-dust">
              {t('report.aside.typedBy', { name: enteredBy })}
            </p>
          ) : (
            <p className="text-caption text-dust">{t('report.aside.noRecording')}</p>
          )}

          {transcribed.length ? (
            <Button
              variant="ghost"
              size="dense"
              className="w-full"
              onClick={() => setTranscriptOpen(true)}
            >
              <FileText aria-hidden="true" />
              {t('report.aside.fullTranscript')}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card data-testid="activity-panel">
        <CardHeader>
          <CardTitle>{t('report.aside.activity')}</CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          <Timeline detail={detail} focusAnchor={focusAnchor} t={t} />
        </CardContent>
      </Card>

      <Dialog open={transcriptOpen} onOpenChange={setTranscriptOpen}>
        <DialogContent side="right" className="overflow-y-auto scrollbar-thin">
          <DialogHeader>
            <DialogTitle>{t('report.transcript.title')}</DialogTitle>
            <DialogDescription>
              {transcribed
                .map((c) =>
                  [
                    c.transcript?.language
                      ? t('report.transcript.language', {
                          language: c.transcript.language.toUpperCase(),
                        })
                      : null,
                    t('report.transcript.segments', {
                      count: c.transcript?.segments.length ?? 0,
                    }),
                  ]
                    .filter(Boolean)
                    .join(' · '),
                )
                .join(' / ')}
            </DialogDescription>
          </DialogHeader>
          {transcribed.length ? (
            <div className="mt-4 space-y-6">
              {transcribed.map((clip) => (
                <section key={clip.id} aria-label={clipLabel(clip, tz, t)}>
                  {transcribed.length > 1 ? (
                    <h3 className="eyebrow mb-2 text-dust">{clipLabel(clip, tz, t)}</h3>
                  ) : null}
                  <TranscriptRows clip={clip} t={t} />
                </section>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-caption text-dust">{t('report.transcript.none')}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function clipLabel(clip: MediaClip, tz: string, t: LooseT): string {
  return t(clip.kind === 'call' ? 'report.aside.clipCall' : 'report.aside.clipVoiceNote', {
    time: formatTimeInTz(clip.receivedAt, tz),
  });
}

function ClipBlock({
  detail,
  clip,
  labelled,
  t,
}: {
  detail: ReportDetail;
  clip: MediaClip;
  labelled: boolean;
  t: LooseT;
}) {
  const tz = detail.site.timezone;
  const languages = languagesLine(detail, clip, t);
  const d = durationPhrase(clip.durationS);
  const filter = useSpeakerFilter(clip.kind === 'call' ? clip.id : null);
  // A call's excerpts carry the assistant's line before each quote (§11.3, muted); the speaker
  // filter hides the other speaker's lines (W3-05).
  const lines =
    clip.kind === 'call'
      ? callExcerptLines(mergedExcerpts(clip.excerpts), clip.transcript?.segments ?? [])
      : mergedExcerpts(clip.excerpts);
  const excerpts = lines.filter((e) => showsSpeaker(filter, e.speaker));
  return (
    <div data-testid="source-clip" data-clip={clip.id}>
      {labelled ? (
        <div className="eyebrow mb-1 flex items-center gap-1.5 text-dust">
          {clip.kind === 'call' ? (
            <Phone className="size-3.5" aria-hidden="true" />
          ) : (
            <Mic className="size-3.5" aria-hidden="true" />
          )}
          {clipLabel(clip, tz, t)}
        </div>
      ) : null}
      <MediaPlayer
        clipId={clip.id}
        kind={clip.kind}
        peaks={clip.peaks}
        agentPeaks={clip.agentPeaks ?? null}
        durationS={clip.durationS}
        url={clip.url}
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-dust">
        <span>{formatTimeInTz(clip.receivedAt, tz)}</span>
        <span className="font-mono">{t(d.key, d.vars)}</span>
        {languages ? (
          <span className="font-mono" data-testid="languages-line">
            {languages}
          </span>
        ) : null}
        {!clip.url ? (
          <span>{t('player.demoAudio')}</span>
        ) : clip.synthetic ? (
          <span data-testid="demo-tones">{t('player.demoTones')}</span>
        ) : null}
      </div>
      {lines.length && !excerpts.length ? (
        <p className="mt-3 text-caption text-dust" data-testid="excerpts-filtered">
          {t('report.aside.noExcerptsForSpeaker')}
        </p>
      ) : null}
      {excerpts.length ? (
        <div className="mt-3 space-y-2">
          <div className="eyebrow text-dust">{t('report.aside.excerpts')}</div>
          {excerpts.map((e) => (
            <TranscriptExcerpt
              key={e.start}
              clipId={clip.id}
              kind={clip.kind}
              start={e.start}
              end={e.end}
              quote={e.quote}
              mapped={e.mapped || null}
              speaker={e.speaker}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A clip's transcript lines in the drawer; a call's follow its speaker filter (W3-05). */
function TranscriptRows({ clip, t }: { clip: MediaClip; t: LooseT }) {
  const filter = useSpeakerFilter(clip.kind === 'call' ? clip.id : null);
  return (
    <ol className="space-y-3" aria-label={t('report.transcript.title')}>
      {clip
        .transcript!.segments.filter((s) => clip.kind !== 'call' || showsSpeaker(filter, s.speaker))
        .map((s) => (
          <TranscriptRow key={s.start} clip={clip} segment={s} t={t} />
        ))}
    </ol>
  );
}

function TranscriptRow({
  clip,
  segment: s,
  t,
}: {
  clip: MediaClip;
  segment: TranscriptSegment;
  t: LooseT;
}) {
  const player = useMediaPlayer();
  const active = useClipActive(clip.id, s.start, s.end);
  const ts = formatAudioTimestamp(s.start);
  return (
    <li
      className={cn(
        'grid grid-cols-[52px_minmax(0,1fr)] gap-2 rounded-chip px-2 py-1',
        active && 'bg-signal-tint/50',
      )}
    >
      <button
        type="button"
        className="text-left font-mono text-[12px] font-medium text-level hover:underline"
        onClick={() => player?.seek(s.start, clip.id)}
        aria-label={`${ts} · ${t(
          clip.kind === 'call' ? 'source.links.playCall' : 'source.links.playVoiceNote',
          { ts },
        )}`}
      >
        {ts}
      </button>
      <p
        className={cn(
          'text-[15px] leading-[22px]',
          s.speaker === 'agent' ? 'text-dust' : 'text-asphalt',
        )}
      >
        {s.speaker ? (
          <span className="mr-1 font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
            {t(s.speaker === 'agent' ? 'report.transcript.agent' : 'report.transcript.reporter')}
          </span>
        ) : null}
        {s.text}
      </p>
    </li>
  );
}

const KIND_ICON: Partial<Record<ActivityEntry['kind'], ComponentType<{ className?: string }>>> = {
  link_opened: Link2,
  clip_received: Mic,
  text_sent: MessageSquareText,
  text_received: MessageSquareText,
  call_in: Phone,
  call_out: Phone,
  call_missed: PhoneMissed,
  whatsapp_in: MessageSquareText,
  whatsapp_out: MessageSquareText,
};

/** The words of one Activity entry, in the panel's language. */
function activityLabel(e: ActivityEntry, t: LooseT): string {
  const p = e.params;
  const duration = (seconds: unknown) => {
    const d = durationPhrase(Number(seconds ?? 0));
    return t(d.key, d.vars);
  };
  switch (e.kind) {
    case 'clip_received': {
      const photos = Number(p.photos ?? 0);
      return photos > 0
        ? t('report.activity.events.clip_received_photos', { count: photos })
        : t('report.activity.events.clip_received', { duration: duration(p.seconds) });
    }
    case 'photos_received':
      return t('report.activity.events.photos_received', { count: Number(p.photos ?? 1) });
    case 'confirmed': {
      const via = String(p.channel ?? '');
      return via === 'web' || via === 'voice' || via === 'sms'
        ? t(`report.activity.events.confirmed_${via}` as CopyKey)
        : t('report.activity.events.confirmed');
    }
    case 'filed':
    case 'version':
      return t(`report.activity.events.${e.kind}`, { version: Number(p.version ?? 1) });
    case 'text_sent': {
      const key = String(p.message ?? '');
      const message = t(`report.activity.messages.${key || 'other'}` as CopyKey);
      const status = p.status ? t(`report.activity.status.${String(p.status)}` as CopyKey) : '';
      const label = t('report.activity.events.text_sent', {
        message: message.startsWith('report.') ? t('report.activity.messages.other') : message,
      });
      return status && !status.startsWith('report.') ? `${label} · ${status}` : label;
    }
    case 'call_in':
    case 'call_out': {
      // Talk now in the recorder is a browser call (W3-05); the outcome follows (§6.3).
      const kind = p.transport === 'web' ? 'call_web' : e.kind;
      const label = t(`report.activity.events.${kind}` as CopyKey, {
        duration: duration(p.seconds),
      });
      const outcome = p.outcome
        ? t(`report.activity.callOutcomes.${String(p.outcome)}` as CopyKey)
        : '';
      return outcome && !outcome.startsWith('report.') ? `${label} · ${outcome}` : label;
    }
    case 'call_missed': {
      const outcome = p.outcome
        ? t(`report.activity.callOutcomes.${String(p.outcome)}` as CopyKey)
        : '';
      const label = t('report.activity.events.call_missed');
      return outcome && !outcome.startsWith('report.') && p.outcome !== 'not_reached'
        ? `${label} · ${outcome}`
        : label;
    }
    case 'whatsapp_in':
    case 'whatsapp_out':
      return t(`report.activity.events.${e.kind}`, {
        type: t(`report.activity.whatsappTypes.${String(p.type ?? 'unsupported')}` as CopyKey),
      });
    case 'other':
      return t('report.activity.events.other', { action: String(p.action ?? '') });
    default:
      return t(`report.activity.events.${e.kind}` as CopyKey);
  }
}

function actorLabel(e: ActivityEntry, t: LooseT): string {
  if (e.actorName) return e.actorName;
  if (e.actorType === 'user') return t('report.activity.office');
  if (e.actorType === 'system') return t('report.activity.system');
  return t('report.activity.agent');
}

function Timeline({
  detail,
  focusAnchor,
  t,
}: {
  detail: ReportDetail;
  focusAnchor: string | null;
  t: LooseT;
}) {
  const { language } = useLooseCopy();
  const tz = detail.site.timezone;
  const focused = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'nearest' });
  }, [focusAnchor]);

  // §19 Q93: a spoken answer's clip plays under its "Question answered" entry.
  const answerClip = (e: ActivityEntry) =>
    e.kind === 'question_answered' && e.anchor
      ? detail.answerClips.find((c) => c.questionId === e.anchor)
      : undefined;
  if (!detail.activity.length)
    return <p className="text-caption text-dust">{t('report.activity.empty')}</p>;
  return (
    <ol
      className="relative space-y-3 border-l border-rebar pl-4"
      aria-label={t('report.aside.activity')}
      data-testid="activity"
    >
      {detail.activity.map((e) => {
        const Icon =
          KIND_ICON[e.kind] ??
          (e.actorType === 'reporter' ? HardHat : e.actorType === 'user' ? UserRound : Bot);
        const isFocus = focusAnchor !== null && e.anchor === focusAnchor;
        return (
          <li
            key={e.id}
            ref={isFocus ? focused : undefined}
            className={cn('relative rounded-chip', isFocus && 'bg-signal-tint/50 px-2 py-1')}
            data-kind={e.kind}
            data-focus={isFocus || undefined}
          >
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-1.5 size-3 rounded-full border border-rebar bg-chalk',
                isFocus ? '-left-[30px]' : '-left-[22px]',
              )}
            />
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 text-[15px] font-medium">{activityLabel(e, t)}</span>
              <span className="shrink-0 font-mono text-[12px] text-dust">
                {formatWhen(e.at, tz, detail.report.date, language)}
              </span>
            </div>
            <div className="flex min-w-0 items-start gap-1 text-caption text-dust">
              <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">
                {actorLabel(e, t)}
                {e.detail ? <span> · {e.detail}</span> : null}
              </span>
            </div>
            {answerClip(e) ? <AnswerClip clip={answerClip(e)!} t={t} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A spoken answer's clip (W2-09, §19 Q93): its player and what it said. */
function AnswerClip({ clip, t }: { clip: MediaClip; t: LooseT }) {
  const said = clip.transcript?.text.trim();
  return (
    <div className="mt-2" data-testid="answer-clip" data-clip={clip.id}>
      <div className="eyebrow mb-1 flex items-center gap-1.5 text-dust">
        <Mic className="size-3.5" aria-hidden="true" />
        {t('player.answerClip')}
      </div>
      <MediaPlayer clipId={clip.id} peaks={clip.peaks} durationS={clip.durationS} url={clip.url} />
      {said ? <p className="mt-1 text-caption text-asphalt">“{said}”</p> : null}
      {!clip.url ? <p className="mt-1 text-caption text-dust">{t('player.demoAudio')}</p> : null}
    </div>
  );
}
