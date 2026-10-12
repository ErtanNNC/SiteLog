import { FileText, Info, Mic } from 'lucide-react';
import { useId, useState } from 'react';
import { formatDuration, formatTimeInTz } from '@sitelog/shared/format.ts';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import type { ChatMessage } from './engine';
import { noteText } from './notes';
import samplePhoto from './sample-photo.svg';

const t = copy.try;

/** Text with WhatsApp ``` blocks (the draft card) rendered as monospace. */
function RichText({ text }: { text: string }) {
  const parts = text.split('```');
  return (
    <>
      {parts.map((part, i) => {
        const body = part.replace(/^\n|\n$/g, '');
        if (!body) return null;
        return i % 2 === 1 ? (
          <pre
            key={i}
            className="my-1 whitespace-pre-wrap break-words rounded-chip bg-concrete px-2 py-1.5 font-mono text-data text-asphalt"
          >
            {body}
          </pre>
        ) : (
          <p key={i} className="whitespace-pre-line">
            {body}
          </p>
        );
      })}
    </>
  );
}

function Transcript({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-2 border-t border-iron/60 pt-2">
      <div className="eyebrow text-dust-light">{t.phone.transcript}</div>
      <p id={id} className={cn('mt-0.5 text-[13px] leading-[19px]', !open && 'line-clamp-4')}>
        {text}
      </p>
      <button
        type="button"
        className="-mb-2 inline-flex min-h-[44px] items-center text-[13px] font-semibold text-chalk underline underline-offset-4"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? t.phone.hideTranscript : t.phone.showTranscript}
      </button>
    </div>
  );
}

export function ChatBubble({
  message: m,
  first,
  timezone,
  liveButtons,
  busy,
  onTap,
  children,
}: {
  message: ChatMessage;
  first: string;
  timezone: string;
  /** The buttons still mean something (the question or draft is open). */
  liveButtons: boolean;
  /** The agent is replying: buttons stay focusable but do nothing until it is done. */
  busy: boolean;
  onTap: (buttonId: string) => void;
  children?: React.ReactNode;
}) {
  const time = formatTimeInTz(m.at, timezone);
  if (m.from === 'system') {
    return (
      <li className="flex justify-center" data-from="system">
        <div className="w-full rounded-card border border-dashed border-iron/50 bg-concrete px-3 py-2 text-[13px] leading-[19px] text-steel">
          <div className="eyebrow mb-0.5 flex items-center gap-1 text-dust">
            <Info className="size-3.5" aria-hidden="true" />
            {t.phone.system}
          </div>
          <p>{m.note ? noteText(m.note) : m.text}</p>
          {children}
        </div>
      </li>
    );
  }
  const mine = m.from === 'reporter';
  const who = mine ? t.phone.fromReporter(first) : t.phone.fromAgent;
  return (
    <li
      className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}
      data-from={m.from}
      data-tag={m.tag}
    >
      <div
        className={cn(
          'max-w-[88%] rounded-bubble px-3 py-2 text-[14px] leading-5',
          mine
            ? 'rounded-tr-chip bg-asphalt text-chalk'
            : 'rounded-tl-chip border border-rebar bg-white text-asphalt',
          m.tag === 'draft' && 'max-w-full',
        )}
      >
        <span className="sr-only">{t.phone.sentAt(who, time)}: </span>
        {m.history ? (
          <div className="eyebrow mb-0.5 text-dust">{t.phone.reminderHistory}</div>
        ) : null}
        {m.kind === 'voice' ? (
          <div className="min-w-[220px]">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-steel">
                <Mic className="size-4" aria-hidden="true" />
              </span>
              <span className="font-semibold">{t.phone.voiceNote}</span>
              <span className="font-mono text-[12px] text-dust-light">
                {formatDuration(m.durationS ?? 0)}
              </span>
              {m.languages?.length ? (
                <span className="ml-auto rounded-chip border border-iron px-1.5 font-mono text-[12px] uppercase text-dust-light">
                  {m.languages.join(' + ')}
                </span>
              ) : null}
            </div>
            <Transcript text={m.text} />
          </div>
        ) : m.kind === 'photo' ? (
          <figure className="m-0">
            <img
              src={samplePhoto}
              alt={t.phone.photoAlt}
              width={240}
              height={180}
              className="h-auto w-[240px] max-w-full rounded-chip"
            />
            {m.caption ? <figcaption className="mt-1 text-[13px]">{m.caption}</figcaption> : null}
          </figure>
        ) : m.kind === 'document' ? (
          <div className="flex items-center gap-2">
            <FileText className="size-6 shrink-0 text-missing" aria-hidden="true" />
            <div className="min-w-0">
              <div className="truncate font-mono text-[12.5px] font-semibold">{m.fileName}</div>
              <div className="text-[12px] text-dust">
                {t.phone.document} · {m.text}
              </div>
            </div>
          </div>
        ) : (
          <RichText text={m.text} />
        )}
        <div
          className={cn(
            'mt-0.5 text-right font-mono text-[12px]',
            mine ? 'text-dust-light' : 'text-dust',
          )}
          aria-hidden="true"
        >
          {time}
        </div>
      </div>
      {m.buttons?.length ? (
        <div
          role="group"
          aria-label={t.phone.buttons}
          data-live-buttons={liveButtons ? 'true' : undefined}
          className={cn(
            'mt-1 flex w-full max-w-[88%] flex-col gap-1',
            m.tag === 'draft' && 'max-w-full',
          )}
        >
          {m.buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={!liveButtons}
              aria-disabled={(liveButtons && busy) || undefined}
              onClick={() => {
                if (!busy) onTap(b.id);
              }}
              className="min-h-[44px] rounded-btn border border-rebar bg-white px-3 text-[14px] font-semibold text-level hover:bg-concrete disabled:cursor-not-allowed disabled:text-dust disabled:opacity-70 aria-disabled:cursor-wait"
            >
              {b.title}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
