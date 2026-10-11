import { Bot, FileText, HardHat, Mic, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatAudioTimestamp, formatDuration, formatTimeInTz } from '@sitelog/shared/format.ts';
import { TranscriptExcerpt } from '@/components/sitelog/TranscriptExcerpt';
import { VoicePlayer, useVoicePlayer } from '@/components/sitelog/VoicePlayer';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { copy } from '@/copy/en';
import type {
  ActivityEntry,
  MessageItem,
  ReportDetail,
  TranscriptExcerpt as TranscriptExcerptItem,
} from '@/data/types';
import { formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface SourcePanelProps {
  detail: ReportDetail;
  /** Message id to reveal + highlight in the timeline (from a "reply 17:41" SourceLink). */
  openMessageId: string | null;
  onOpenHistory?: () => void;
}

function languagesLabel(detail: ReportDetail): string | null {
  const codes = detail.data.languageDetected.length
    ? detail.data.languageDetected
    : (detail.transcript?.language?.split('+') ?? []);
  if (!codes.length) return null;
  return copy.player.languages(codes.map((c) => c.toUpperCase()).join(' + '), 'EN');
}

/** One excerpt per transcript segment: facts mapped from the same quote are joined (max 6). */
function mergedExcerpts(detail: ReportDetail): TranscriptExcerptItem[] {
  const bySegment = new Map<number, TranscriptExcerptItem>();
  for (const e of detail.excerpts) {
    const cur = bySegment.get(e.start);
    if (cur) cur.mapped = `${cur.mapped} · ${e.mapped}`;
    else bySegment.set(e.start, { ...e });
  }
  return [...bySegment.values()].slice(0, 6);
}

/** Aside: Source (voice note player, transcript excerpts, full transcript drawer) + Activity timeline. */
export function SourcePanel({ detail, openMessageId }: SourcePanelProps) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [messagesToggle, setMessagesToggle] = useState(false);
  // A "reply 17:41" source link reveals the messages until the person hides them again.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  const showMessages = messagesToggle || (openMessageId !== null && hiddenFor !== openMessageId);
  const setShowMessages = (on: boolean) => {
    setMessagesToggle(on);
    setHiddenFor(on ? null : openMessageId);
  };
  const tz = detail.site.timezone;
  const player = useVoicePlayer();

  return (
    <div className="space-y-4">
      <Card data-testid="source-panel">
        <CardHeader>
          <CardTitle>{copy.report.aside.source}</CardTitle>
          <span className="eyebrow text-dust">{copy.report.aside.voiceNote}</span>
        </CardHeader>
        <CardContent className="pt-3">
          {detail.audio ? (
            <>
              <VoicePlayer
                peaks={detail.audio.peaks}
                durationS={detail.audio.durationS}
                url={detail.audio.url}
                languages={null}
              />
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-dust">
                <span>{formatTimeInTz(detail.audio.receivedAt, tz)}</span>
                <span className="font-mono">{formatDuration(detail.audio.durationS)}</span>
                {!detail.audio.url ? <span>{copy.player.demoAudio}</span> : null}
                <span className="font-mono">{languagesLabel(detail)}</span>
              </div>
            </>
          ) : (
            <p className="text-caption text-dust">{copy.player.noAudio}</p>
          )}

          {detail.excerpts.length ? (
            <div className="mt-4 space-y-2" aria-label={copy.report.aside.excerpts}>
              <div className="eyebrow text-dust">{copy.report.aside.excerpts}</div>
              {mergedExcerpts(detail).map((e) => (
                <TranscriptExcerpt
                  key={e.start}
                  start={e.start}
                  end={e.end}
                  quote={e.quote}
                  mapped={e.mapped}
                />
              ))}
            </div>
          ) : null}

          {detail.transcript ? (
            <Button
              variant="ghost"
              size="dense"
              className="mt-4 w-full"
              onClick={() => setTranscriptOpen(true)}
            >
              <FileText aria-hidden="true" />
              {copy.report.aside.fullTranscript}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card data-testid="activity-panel">
        <CardHeader>
          <CardTitle>{copy.report.aside.activity}</CardTitle>
          {detail.messages.length ? (
            <Button variant="link" size="sm" onClick={() => setShowMessages(!showMessages)}>
              {showMessages ? copy.report.activity.hideMessages : copy.report.activity.showMessages}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="pt-3">
          <Timeline
            detail={detail}
            showMessages={showMessages}
            highlightMessageId={openMessageId}
          />
        </CardContent>
      </Card>

      <Dialog open={transcriptOpen} onOpenChange={setTranscriptOpen}>
        <DialogContent side="right" className="overflow-y-auto scrollbar-thin">
          <DialogHeader>
            <DialogTitle>{copy.report.transcript.title}</DialogTitle>
            <DialogDescription>
              {detail.transcript?.language
                ? copy.report.transcript.language(detail.transcript.language.toUpperCase())
                : null}
              {detail.transcript
                ? ` · ${copy.report.transcript.segments(detail.transcript.segments.length)}`
                : null}
            </DialogDescription>
          </DialogHeader>
          {detail.transcript ? (
            <ol className="mt-4 space-y-3" aria-label={copy.report.transcript.title}>
              {detail.transcript.segments.map((s) => {
                const active =
                  !!player &&
                  ((player.highlight !== null &&
                    player.highlight >= s.start &&
                    player.highlight < s.end) ||
                    (player.currentTime > 0 &&
                      player.currentTime >= s.start &&
                      player.currentTime < s.end));
                return (
                  <li
                    key={s.start}
                    className={cn(
                      'grid grid-cols-[52px_minmax(0,1fr)] gap-2 rounded-chip px-2 py-1',
                      active && 'bg-signal-tint/50',
                    )}
                  >
                    <button
                      type="button"
                      className="text-left font-mono text-[12px] font-medium text-level hover:underline"
                      onClick={() => player?.seek(s.start)}
                      aria-label={copy.source.seekTo(formatAudioTimestamp(s.start))}
                    >
                      {formatAudioTimestamp(s.start)}
                    </button>
                    <p className="text-[15px] leading-[22px]">{s.text}</p>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="mt-4 text-caption text-dust">{copy.report.transcript.none}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type TimelineItem =
  | { kind: 'audit'; at: string; entry: ActivityEntry }
  | { kind: 'message'; at: string; message: MessageItem };

function Timeline({
  detail,
  showMessages,
  highlightMessageId,
}: {
  detail: ReportDetail;
  showMessages: boolean;
  highlightMessageId: string | null;
}) {
  const tz = detail.site.timezone;
  const items: TimelineItem[] = [
    ...detail.activity.map((entry) => ({ kind: 'audit' as const, at: entry.at, entry })),
    ...(showMessages
      ? detail.messages.map((message) => ({ kind: 'message' as const, at: message.at, message }))
      : []),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === 'message' ? -1 : 1));
  const highlighted = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    highlighted.current?.scrollIntoView({ block: 'nearest' });
  }, [highlightMessageId, showMessages]);

  if (!items.length) return <p className="text-caption text-dust">{copy.report.activity.empty}</p>;
  return (
    <ol
      className="relative space-y-3 border-l border-rebar pl-4"
      aria-label={copy.report.aside.activity}
    >
      {items.map((it) => {
        if (it.kind === 'audit') {
          const e = it.entry;
          const Icon =
            e.actorType === 'agent' ? Bot : e.actorType === 'reporter' ? HardHat : UserRound;
          return (
            <li key={e.id} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[22px] top-1 flex size-3 items-center justify-center rounded-full border border-rebar bg-chalk"
              />
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[15px] font-medium">{e.label}</span>
                <span className="shrink-0 font-mono text-[12px] text-dust">
                  {formatWhen(e.at, tz, detail.report.date)}
                </span>
              </div>
              <div className="flex items-center gap-1 text-caption text-dust">
                <Icon className="size-3.5" aria-hidden="true" />
                {e.actorName}
                {e.detail ? <span> · {e.detail}</span> : null}
              </div>
            </li>
          );
        }
        const m = it.message;
        const isHighlight = m.id === highlightMessageId;
        const body =
          m.type === 'audio'
            ? copy.report.activity.voiceNote(formatDuration(detail.audio?.durationS ?? 0))
            : m.type === 'image'
              ? `${copy.report.activity.photo}${m.body ? ` · ${m.body}` : ''}`
              : m.type === 'document'
                ? copy.report.activity.document(m.body ?? '')
                : (m.body ?? '');
        return (
          <li
            key={m.id}
            ref={isHighlight ? highlighted : undefined}
            className="relative"
            data-message-id={m.id}
          >
            <span
              aria-hidden="true"
              className={cn(
                'absolute -left-[22px] top-1.5 size-3 rounded-full',
                m.direction === 'in' ? 'bg-signal' : 'bg-iron',
              )}
            />
            <div
              className={cn(
                'rounded-bubble border px-3 py-2 text-caption',
                m.direction === 'in'
                  ? 'rounded-tl-chip border-signal-tint bg-signal-tint/40'
                  : 'rounded-tr-chip border-rebar bg-concrete/60',
                isHighlight && 'border-signal',
              )}
            >
              <div className="flex items-center justify-between gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
                <span className="inline-flex items-center gap-1">
                  {m.type === 'audio' ? <Mic className="size-3" aria-hidden="true" /> : null}
                  {m.direction === 'in' ? copy.report.activity.in : copy.report.activity.out}
                </span>
                <span>{formatWhen(m.at, tz, detail.report.date)}</span>
              </div>
              <p className="mt-0.5 whitespace-pre-line text-[14px] leading-5 text-asphalt">
                {body}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
