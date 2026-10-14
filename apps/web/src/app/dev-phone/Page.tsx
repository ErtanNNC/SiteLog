import { ArrowLeft, Mail, MessageSquare, Send, Smartphone } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { formatDateInTz, formatPhone, formatTimeInTz } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import {
  useDemoPhone,
  useDemoPhoneEmails,
  useDemoPhoneLive,
  useDemoPhoneReply,
  useDemoPhoneThread,
} from '@/data/hooks';
import type { DemoPhoneEmail, DemoPhoneMessage, DemoPhoneReporter } from '@/data/types';
import { useCopy, type CopyT } from '@/i18n/useCopy';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';

/**
 * `/dev/phone` · Demo phone (§11.1, admins; W1-08): the texts of the `console` SMS driver, one
 * thread per reporter, live (realtime on `messages`), and an Email tab for the console email
 * provider. Links open the field app in a new tab (a 390 × 844 frame works only locally, D42). A
 * reply typed here goes through sms-webhook's handler as the reporter, only on a demo org whose
 * country pack has two-way SMS (spec §19 Q35). Demo orgs only, or every org on staging
 * (`VITE_DEMO_PHONE_ALL_ORGS`), where a real org's texts show their link codes masked.
 */
export default function DevPhonePage() {
  const { t } = useCopy();
  const { currentOrg, isDemo } = useAuth();
  const allowed = isDemo || env.demoPhoneAllOrgs || currentOrg?.demoOrg === true;
  useDemoPhoneLive(allowed);
  return (
    <>
      <PageHeader title={t('nav.devPhone')} subtitle={t('devPhone.subtitle')} />
      {allowed ? (
        <DemoPhone timezone={currentOrg?.timezone ?? 'UTC'} />
      ) : (
        <EmptyState
          icon={Smartphone}
          title={t('devPhone.notDemoTitle')}
          body={t('devPhone.notDemoBody')}
        />
      )}
    </>
  );
}

function DemoPhone({ timezone }: { timezone: string }) {
  const { t } = useCopy();
  const [tab, setTab] = useState<'texts' | 'email'>('texts');
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as 'texts' | 'email')}>
      <TabsList aria-label={t('devPhone.tabsLabel')}>
        <TabsTrigger value="texts" className="min-h-11 sm:min-h-9">
          <MessageSquare className="size-4" aria-hidden="true" />
          {t('devPhone.tabTexts')}
        </TabsTrigger>
        <TabsTrigger value="email" className="min-h-11 sm:min-h-9">
          <Mail className="size-4" aria-hidden="true" />
          {t('devPhone.tabEmail')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="texts">
        <Texts timezone={timezone} />
      </TabsContent>
      <TabsContent value="email">
        <Emails timezone={timezone} enabled={tab === 'email'} />
      </TabsContent>
    </Tabs>
  );
}

function when(at: string, timezone: string): string {
  return `${formatDateInTz(at, timezone)} ${formatTimeInTz(at, timezone)}`;
}

function Texts({ timezone }: { timezone: string }) {
  const { t } = useCopy();
  const phone = useDemoPhone();
  const [selected, setSelected] = useState<string | null>(null);

  if (phone.isPending) return <PageSkeleton />;
  if (phone.isError)
    return (
      <ErrorState
        thing={t('devPhone.thing')}
        error={phone.error}
        onRetry={() => void phone.refetch()}
      />
    );
  const data = phone.data;
  if (data.reporters.length === 0)
    return (
      <EmptyState
        icon={Smartphone}
        title={t('devPhone.emptyTitle')}
        body={t('devPhone.emptyBody')}
      />
    );
  const reporter = data.reporters.find((r) => r.id === selected) ?? null;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(240px,320px)_1fr]">
      <nav
        aria-label={t('devPhone.reportersLabel')}
        className={cn(reporter ? 'hidden md:block' : 'block')}
      >
        <ul className="flex flex-col gap-2">
          {data.reporters.map((r) => (
            <li key={r.id}>
              <ReporterButton
                reporter={r}
                current={r.id === selected}
                timezone={timezone}
                onSelect={() => setSelected(r.id)}
              />
            </li>
          ))}
        </ul>
      </nav>
      <section className={cn('min-w-0', reporter ? 'block' : 'hidden md:block')}>
        {reporter ? (
          <Thread
            reporter={reporter}
            timezone={timezone}
            canReply={data.orgIsDemo && data.pack.twoWaySms}
            oneWayNote={
              !data.orgIsDemo
                ? t('devPhone.maskedNote')
                : data.pack.twoWaySms
                  ? null
                  : t('devPhone.oneWay', { code: data.pack.code })
            }
            onBack={() => setSelected(null)}
          />
        ) : (
          <div className="rounded-card border border-dashed border-rebar bg-chalk p-6 text-[15px] text-dust">
            {t('devPhone.pickReporter')}
          </div>
        )}
      </section>
    </div>
  );
}

function ReporterButton({
  reporter,
  current,
  timezone,
  onSelect,
}: {
  reporter: DemoPhoneReporter;
  current: boolean;
  timezone: string;
  onSelect: () => void;
}) {
  const { t } = useCopy();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={current ? 'true' : undefined}
      className={cn(
        'flex min-h-14 w-full flex-col gap-1 rounded-card border px-4 py-3 text-left transition-colors',
        current
          ? 'border-asphalt bg-asphalt text-chalk'
          : 'border-rebar bg-chalk text-asphalt hover:bg-concrete',
      )}
    >
      <span className="flex w-full items-baseline justify-between gap-2">
        <span className="truncate font-semibold">{reporter.name}</span>
        <span className={cn('font-mono text-[12px]', current ? 'text-rebar' : 'text-dust')}>
          {t('devPhone.textsCount', { count: reporter.count })}
        </span>
      </span>
      <span className={cn('font-mono text-[12px]', current ? 'text-rebar' : 'text-dust')}>
        {formatPhone(reporter.phone)}
        {reporter.lastAt ? ` · ${when(reporter.lastAt, timezone)}` : ''}
      </span>
      <span className={cn('line-clamp-2 text-caption', current ? 'text-rebar' : 'text-dust')}>
        {reporter.lastBody ?? t('devPhone.noTexts')}
      </span>
    </button>
  );
}

function Thread({
  reporter,
  timezone,
  canReply,
  oneWayNote,
  onBack,
}: {
  reporter: DemoPhoneReporter;
  timezone: string;
  canReply: boolean;
  oneWayNote: string | null;
  onBack: () => void;
}) {
  const { t } = useCopy();
  const thread = useDemoPhoneThread(reporter.id);
  return (
    <div className="flex flex-col rounded-card border border-rebar bg-chalk">
      <header className="flex items-center gap-3 border-b border-rebar px-4 py-3">
        <Button
          variant="subtle"
          size="icon"
          className="md:hidden"
          onClick={onBack}
          aria-label={t('devPhone.back')}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate font-h2 text-h2">{reporter.name}</h2>
          <p className="font-mono text-[12px] text-dust">{formatPhone(reporter.phone)}</p>
        </div>
      </header>
      <div className="max-h-[60vh] min-h-48 overflow-y-auto px-4 py-4">
        {thread.isPending ? (
          <PageSkeleton />
        ) : thread.isError ? (
          <ErrorState
            thing={t('devPhone.threadThing')}
            error={thread.error}
            onRetry={() => void thread.refetch()}
          />
        ) : thread.data.length === 0 ? (
          <p className="text-[15px] text-dust">
            {t('devPhone.threadEmpty', { name: reporter.name })}
          </p>
        ) : (
          <ol
            aria-label={t('devPhone.threadLabel', { name: reporter.name })}
            aria-live="polite"
            aria-relevant="additions"
            className="flex flex-col gap-3"
          >
            {thread.data.map((m) => (
              <Bubble key={m.id} message={m} reporterName={reporter.name} timezone={timezone} />
            ))}
          </ol>
        )}
      </div>
      <footer className="border-t border-rebar px-4 py-3">
        {canReply ? <ReplyForm reporter={reporter} /> : null}
        {oneWayNote ? <p className="text-caption text-dust">{oneWayNote}</p> : null}
      </footer>
    </div>
  );
}

function Bubble({
  message,
  reporterName,
  timezone,
}: {
  message: DemoPhoneMessage;
  reporterName: string;
  timezone: string;
}) {
  const { t } = useCopy();
  // The phone's view: SiteLog's texts arrive on the left, the reporter's own go out on the right.
  const fromReporter = message.direction === 'in';
  const status = statusLabel(t, message.status);
  return (
    <li className={cn('flex flex-col gap-1', fromReporter ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-card border px-3 py-2 text-[15px]',
          fromReporter
            ? 'border-asphalt bg-asphalt text-chalk'
            : 'border-rebar bg-concrete text-asphalt',
        )}
      >
        <span className="sr-only">{fromReporter ? reporterName : t('devPhone.fromSiteLog')}: </span>
        <Linkified text={message.body} />
      </div>
      <p className="font-mono text-[12px] text-dust">
        {when(message.at, timezone)}
        {message.copyKey ? (
          <>
            {' · '}
            <span className="sr-only">{t('devPhone.copyKey')} </span>
            {message.copyKey}
          </>
        ) : null}
        {' · '}
        <span className="sr-only">{t('devPhone.statusLabel')} </span>
        {status}
      </p>
    </li>
  );
}

function statusLabel(t: CopyT, status: string): string {
  switch (status) {
    case 'queued':
    case 'sent':
    case 'delivered':
    case 'read':
    case 'received':
    case 'failed':
    case 'undeliverable':
      return t(`devPhone.status.${status}`);
    default:
      return status;
  }
}

const URL_RE = /(https?:\/\/[^\s]+?)(?=[.,;:!?)]?(?:\s|$))/g;

/** The text with its links clickable: each opens the field app in a new tab. */
function Linkified({ text }: { text: string }) {
  const { t } = useCopy();
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[1]!;
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <a
        key={start}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-2"
      >
        {url}
        <span className="sr-only"> {t('devPhone.opensInNewTab')}</span>
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function ReplyForm({ reporter }: { reporter: DemoPhoneReporter }) {
  const { t } = useCopy();
  const reply = useDemoPhoneReply();
  const [body, setBody] = useState('');
  const inputId = `demo-reply-${reporter.id}`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    reply.mutate({ reporterId: reporter.id, body: text }, { onSuccess: () => setBody('') });
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={inputId} className="mb-1 block text-caption font-medium text-dust">
          {t('devPhone.replyLabel', { name: reporter.name })}
        </label>
        <Input
          id={inputId}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t('devPhone.replyPlaceholder')}
          maxLength={1600}
          autoComplete="off"
        />
      </div>
      <Button type="submit" variant="secondary" disabled={reply.isPending || !body.trim()}>
        <Send aria-hidden="true" />
        {t('devPhone.send')}
      </Button>
    </form>
  );
}

function Emails({ timezone, enabled }: { timezone: string; enabled: boolean }) {
  const { t } = useCopy();
  const emails = useDemoPhoneEmails({ enabled });
  if (emails.isPending) return enabled ? <PageSkeleton /> : null;
  if (emails.isError)
    return (
      <ErrorState
        thing={t('devPhone.emailThing')}
        error={emails.error}
        onRetry={() => void emails.refetch()}
      />
    );
  if (emails.data.length === 0)
    return (
      <EmptyState icon={Mail} title={t('devPhone.emailLabel')} body={t('devPhone.emailEmpty')} />
    );
  return (
    <ul aria-label={t('devPhone.emailLabel')} className="flex flex-col gap-3">
      {emails.data.map((e) => (
        <EmailCard key={e.id} email={e} timezone={timezone} />
      ))}
    </ul>
  );
}

function EmailCard({ email, timezone }: { email: DemoPhoneEmail; timezone: string }) {
  const { t } = useCopy();
  return (
    <li className="rounded-card border border-rebar bg-chalk p-4">
      <h2 className="font-semibold">{email.subject}</h2>
      <p className="font-mono text-[12px] text-dust">
        {t('devPhone.emailTo', { to: email.recipients.join(', ') })} · {when(email.at, timezone)} ·{' '}
        {email.kind}
      </p>
      <p className="mt-3 whitespace-pre-wrap break-words text-[15px]">
        <Linkified text={email.body} />
      </p>
      {email.attachments.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-caption font-medium text-dust">{t('devPhone.attachments')}</h3>
          <ul className="font-mono text-[12px]">
            {email.attachments.map((a) => (
              <li key={a.filename}>
                {t('devPhone.attachmentSize', {
                  name: a.filename,
                  size: Math.max(1, Math.round(a.bytes / 1024)),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
