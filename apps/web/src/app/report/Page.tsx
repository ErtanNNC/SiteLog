import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronLeft, ChevronRight, FileDown, Pencil, PenLine, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { formatAudioTimestamp, formatDate, formatTimeInTz } from '@sitelog/shared/format.ts';
import type { Source } from '@sitelog/shared/schemas/report.ts';
import { readReportData } from '@sitelog/shared/report/upgrade.ts';
import { useAuth } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { TopBarControls } from '@/components/shell/TopBar';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { ErrorState, ReviewReasonsBanner } from '@/components/sitelog/States';
import { LateBadge, StatusChip } from '@/components/sitelog/StatusChip';
import { MediaPlayerProvider, useMediaPlayer } from '@/components/sitelog/MediaPlayer';
import { Button } from '@/components/ui/Button';
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Form } from '@/components/ui/Form';
import { Label } from '@/components/ui/Label';
import { Textarea } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { unlinkedCompanyReasons } from '@/data/assemble';
import { useDataSource } from '@/data/DataProvider';
import {
  useCreateReportVersion,
  useReportDetail,
  useReportPdf,
  useResolveUnknownCompany,
  useSettings,
  useSignOff,
  useUndoSignOff,
} from '@/data/hooks';
import { officeEntryAuthor } from '@/data/pdfInput';
import type { ReportDetail } from '@/data/types';
import { useLooseCopy, type LooseT } from '@/i18n/useLooseCopy';
import { formatWhen } from '@/lib/format';
import { openInNewTab } from '@/lib/tab';
import { errorMessage } from '@/lib/utils';
import { PhotoPicker } from './PhotoPicker';
import { ReportEditor } from './ReportEditor';
import { ReportView } from './ReportView';
import { durationPhrase, provenancePhrases, wordPhrases } from './provenance';
import { SourcePanel } from './SourcePanel';
import {
  reportFormSchema,
  sameReportData,
  toFormValues,
  toReportData,
  withPhotoEntries,
  type ReportFormValues,
} from './reportForm';
import { reportPhotoEntries, usePhotoDraft } from './usePhotoDraft';

const UNDO_WINDOW_MS = 10 * 60_000;

/** P7 · Report review — structured report + source panel, versions, sign-off, edit → new version (§11.4, F14). */
export default function ReportDetailPage() {
  const { reportId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const vParam = Number(params.get('v'));
  const version = Number.isInteger(vParam) && vParam > 0 ? vParam : null;
  const detail = useReportDetail(reportId, version);
  const { tx: t } = useLooseCopy();

  if (detail.isPending) return <PageSkeleton />;
  if (detail.isError || !detail.data)
    return (
      <ErrorState
        thing={t('report.thing')}
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />
    );
  return (
    <MediaPlayerProvider>
      <ReportScreen
        key={`${reportId}:${detail.data.version}`}
        detail={detail.data}
        onSelectVersion={(v) => {
          const next = new URLSearchParams(params);
          if (v === detail.data.report.currentVersion) next.delete('v');
          else next.set('v', String(v));
          setParams(next, { replace: true });
        }}
      />
    </MediaPlayerProvider>
  );
}

function ReportScreen({
  detail,
  onSelectVersion,
}: {
  detail: ReportDetail;
  onSelectVersion: (v: number) => void;
}) {
  const source = useDataSource();
  const { tx: t, language } = useLooseCopy();
  const player = useMediaPlayer();
  const { role } = useAuth();
  const navigate = useNavigate();
  const signOff = useSignOff();
  const undoSignOff = useUndoSignOff();
  const createVersion = useCreateReportVersion();
  const reportPdf = useReportPdf();
  const resolveCompany = useResolveUnknownCompany();
  const [signOffOpen, setSignOffOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [focusAnchor, setFocusAnchor] = useState<string | null>(null);
  const [pendingData, setPendingData] = useState<ReportDetail['storedData'] | null>(null);
  // The version's photos while editing: re-caption, move, remove, add (uploaded on save).
  const photos = usePhotoDraft(detail.photos);
  const settings = useSettings();
  const [saving, setSaving] = useState(false);
  // False once the page is gone (the user left mid-save): no version is created after that.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const r = detail.report;
  const tz = detail.site.timezone;
  const isCurrent = detail.version === r.currentVersion;
  const canSignOff = role === 'admin' || role === 'pm';
  const now = source.now().getTime();
  const undoAvailable =
    r.status === 'signed_off' &&
    !!r.signedOffAt &&
    now - new Date(r.signedOffAt).getTime() <= UNDO_WINDOW_MS &&
    canSignOff;

  const form = useForm<ReportFormValues>({
    resolver: zodResolver(reportFormSchema),
    defaultValues: useMemo(() => toFormValues(detail.data), [detail.data]),
  });
  const { reset } = form;
  useEffect(() => {
    if (!editing) reset(toFormValues(detail.data));
  }, [detail.data, editing, reset]);

  const provenance = wordPhrases(
    t,
    provenancePhrases(detail, officeEntryAuthor(detail), (seconds) => {
      const d = durationPhrase(seconds);
      return t(d.key, d.vars);
    }),
  );
  const versionLine = (v: ReportDetail['versions'][number]) =>
    t(v.changeNote ? 'report.versionLineNote' : 'report.versionLine', {
      author: v.authorName,
      time: formatWhen(v.createdAt, tz, '', language),
      note: v.changeNote ?? '',
    });
  const viewedVersion = detail.versions.find((v) => v.version === detail.version) ?? null;

  const startEdit = () => {
    if (!isCurrent) {
      onSelectVersion(r.currentVersion);
      return;
    }
    reset(toFormValues(detail.data));
    photos.reset(detail.photos);
    setEditing(true);
  };

  const onSaveClick = form.handleSubmit((values) => {
    const storedV2 = readReportData(detail.storedData);
    let data: ReportDetail['storedData'];
    try {
      // The new version is report data v2 (W1-12): a stored v1 version is edited through its v2
      // view, which keeps every list's order, so the form rows map onto it. data.photos: the
      // version's photos still listed, with their captions (new picks are uploaded on confirm and
      // appended by the server).
      data = toReportData(values, withPhotoEntries(storedV2, photos.kept()), {
        userId: source.user.id,
        at: source.now().toISOString(),
        companies: detail.companies,
      });
    } catch (err) {
      toast.error(errorMessage(err, t('errors.generic')));
      return;
    }
    // A photo change alone is an edit.
    const shown = withPhotoEntries(storedV2, reportPhotoEntries(detail.photos));
    if (sameReportData(data, shown) && !photos.hasNew) {
      toast.message(t('report.editMode.noChanges'));
      return;
    }
    setPendingData(data);
    setNote('');
    setNoteError(null);
    setNoteOpen(true);
  });

  const onConfirmSave = async () => {
    if (!pendingData) return;
    if (!note.trim()) {
      setNoteError(t('report.edit.changeNoteRequired'));
      return;
    }
    setSaving(true);
    let toastId: string | number | undefined;
    try {
      const picked = await photos.settle();
      if (!alive.current) return;
      if (!picked) {
        setNoteOpen(false);
        toast.error(t('report.editMode.photos.notReady'));
        return;
      }
      let uploads: Awaited<ReturnType<typeof photos.upload>> = [];
      if (picked.length) {
        toastId = toast.loading(
          t('report.editMode.photos.uploadingProgress', { i: 1, n: picked.length }),
        );
        try {
          uploads = await photos.upload(source, detail.site.id, picked, (i, n) =>
            toast.loading(t('report.editMode.photos.uploadingProgress', { i, n }), {
              id: toastId,
            }),
          );
        } catch {
          if (alive.current) toast.error(t('report.editMode.photos.uploadFailed'), { id: toastId });
          else toast.dismiss(toastId);
          return;
        }
      }
      // The user left while the photos uploaded: create no version.
      if (!alive.current) {
        if (toastId !== undefined) toast.dismiss(toastId);
        return;
      }
      const res = await createVersion.mutateAsync({
        reportId: r.id,
        data: pendingData,
        changeNote: note.trim(),
        photos: uploads,
      });
      if (toastId !== undefined) toast.dismiss(toastId);
      void reportPdf.prepare(r.id, res.version);
      if (!alive.current) return;
      setNoteOpen(false);
      setEditing(false);
      setPendingData(null);
      void navigate(`/reports/${r.id}?v=${res.version}`, { replace: true });
    } catch {
      // useSourceMutation already showed the error.
      if (toastId !== undefined) toast.dismiss(toastId);
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const onCancelEdit = () => {
    if (form.formState.isDirty || photos.changed) setDiscardOpen(true);
    else setEditing(false);
  };

  const onPdf = () => {
    if (detail.pdfUrl) openInNewTab(detail.pdfUrl);
    else reportPdf.open(r.id, detail.version);
  };

  const resolve = (name: string, action: 'add' | 'map', companyId?: string) => {
    // The new version gets its PDF like an office edit does (no worker in some deployments).
    // An error was already toasted by useSourceMutation.
    void resolveCompany.mutateAsync({ reportId: r.id, name, action, companyId }).then(
      () => reportPdf.prepare(r.id, null),
      () => undefined,
    );
  };
  const pendingReasons = r.needsReview ? r.reviewReasons : [];
  // Crew companies with no company id that are not review reasons (typed in the panel before
  // they were linked on save) get the same Add / Map controls on the current version of a filed
  // report. Not while a WhatsApp report is still being collected: the worker is asking about an
  // unknown company and writes the next version itself.
  const isFiled = r.status === 'filed' || r.status === 'signed_off';
  const reasons = [
    ...pendingReasons,
    ...(isCurrent && isFiled ? unlinkedCompanyReasons(detail.data, pendingReasons) : []),
  ].map((reason) => {
    const [kind, ...rest] = reason.split(':');
    const name = rest.join(':');
    const callAt = kind === 'call_mismatch' ? callSourceAt(detail, name) : null;
    return {
      key: reason,
      text: reasonText(reason, t),
      action: callAt ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => player?.seek(callAt.start, callAt.callId)}
          data-testid="play-mismatch"
        >
          {t('report.reasons.playAt', { ts: formatAudioTimestamp(callAt.start) })}
        </Button>
      ) : kind === 'unknown_company' ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={resolveCompany.isPending}
            onClick={() => resolve(name, 'add')}
          >
            {t('report.reasons.addAsSub')}
          </Button>
          <Select onValueChange={(companyId) => resolve(name, 'map', companyId)}>
            <SelectTrigger
              dense
              className="h-9 w-auto min-w-[180px]"
              aria-label={t('report.reasons.mapTo')}
            >
              <SelectValue placeholder={t('report.reasons.mapTo')} />
            </SelectTrigger>
            <SelectContent>
              {detail.companies
                .filter((c) => c.status === 'confirmed')
                .map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </span>
      ) : undefined,
    };
  });

  return (
    <>
      <TopBarControls>
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={t('report.previous')}
          disabled={!detail.prevReportId}
          asChild={!!detail.prevReportId}
        >
          {detail.prevReportId ? (
            <Link to={`/reports/${detail.prevReportId}`}>
              <ChevronLeft aria-hidden="true" />
            </Link>
          ) : (
            <ChevronLeft aria-hidden="true" />
          )}
        </Button>
        <Button
          variant="subtle"
          size="iconDense"
          aria-label={t('report.next')}
          disabled={!detail.nextReportId}
          asChild={!!detail.nextReportId}
        >
          {detail.nextReportId ? (
            <Link to={`/reports/${detail.nextReportId}`}>
              <ChevronRight aria-hidden="true" />
            </Link>
          ) : (
            <ChevronRight aria-hidden="true" />
          )}
        </Button>
      </TopBarControls>

      <PageHeader
        breadcrumb={[
          { label: t('report.breadcrumb'), to: '/reports' },
          { label: detail.site.name, to: `/sites/${detail.site.id}` },
          { label: r.reportNo },
        ]}
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <span>{t('report.eyebrow', { no: r.reportNo })}</span>
            <StatusChip variant={chipVariant(detail)} size="sm" />
            {r.isLate && r.receivedAt ? (
              <LateBadge time={formatTimeInTz(r.receivedAt, tz)} />
            ) : null}
            <span className="inline-flex items-center gap-1 normal-case tracking-normal">
              <Label htmlFor="version-switch" className="sr-only">
                {t('report.versionSwitcher')}
              </Label>
              <Select
                value={String(detail.version)}
                onValueChange={(v) => onSelectVersion(Number(v))}
                disabled={editing}
              >
                <SelectTrigger
                  id="version-switch"
                  dense
                  className="h-7 w-auto gap-1 px-2 font-mono text-[12px]"
                  data-testid="version-switcher"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {detail.versions.map((v) => (
                    <SelectItem key={v.version} value={String(v.version)} title={versionLine(v)}>
                      {t(v.isCurrent ? 'report.versionCurrent' : 'report.version', {
                        version: v.version,
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {viewedVersion ? (
                <span className="hidden text-[12px] text-dust md:inline" data-testid="version-line">
                  {versionLine(viewedVersion)}
                </span>
              ) : null}
            </span>
          </span>
        }
        title={t('report.title', {
          weekday: formatDate(r.date, 'weekdayMonthDay', language),
          site: detail.site.shortName,
        })}
        subtitle={<span data-testid="provenance">{provenance}</span>}
        actions={
          editing ? (
            <>
              {/* While saving, Cancel would leave a save that still creates the version. */}
              <Button variant="ghost" onClick={onCancelEdit} disabled={saving}>
                {t('report.actions.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void onSaveClick()}
                loading={saving}
                data-testid="save-version"
              >
                <PenLine aria-hidden="true" />
                {t('report.actions.save')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={startEdit} disabled={r.status === 'void'}>
                <Pencil aria-hidden="true" />
                {t('report.actions.edit')}
              </Button>
              <Button variant="ghost" onClick={onPdf}>
                <FileDown aria-hidden="true" />
                {t('report.actions.pdf')}
              </Button>
              {r.status === 'signed_off' ? (
                <span
                  className="inline-flex h-11 items-center gap-2 rounded-btn border border-filed px-3 text-caption font-medium text-chip-filed-fg"
                  data-testid="signed-off-state"
                >
                  {t('report.actions.signedOffBy', { name: r.signedOffByName ?? '—' })}
                  {undoAvailable ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <Button
                        variant="link"
                        size="sm"
                        className="text-chip-filed-fg"
                        loading={undoSignOff.isPending}
                        onClick={() => undoSignOff.mutate({ reportId: r.id })}
                        title={t('report.undoWindow')}
                      >
                        <Undo2 className="!size-4" aria-hidden="true" />
                        {t('report.actions.undo')}
                      </Button>
                    </>
                  ) : null}
                </span>
              ) : canSignOff && r.status === 'filed' ? (
                <Button
                  variant="primary"
                  onClick={() => setSignOffOpen(true)}
                  disabled={!isCurrent}
                  data-testid="sign-off"
                >
                  {t('report.actions.signOff')}
                </Button>
              ) : null}
            </>
          )
        }
      />

      {!isCurrent ? (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-rebar bg-chalk px-4 py-3 text-caption"
          role="status"
        >
          <span>
            {t('report.viewingOld', { version: detail.version, current: r.currentVersion })}
          </span>
          <Button variant="link" size="sm" onClick={() => onSelectVersion(r.currentVersion)}>
            {t('report.viewCurrent')}
          </Button>
        </div>
      ) : null}

      {reasons.length ? (
        <ReviewReasonsBanner reasons={reasons} className="mb-4" data-testid="review-banner" />
      ) : null}

      {editing ? (
        <div className="mb-4 rounded-card border border-signal bg-signal-tint/40 px-4 py-3 text-caption">
          <span className="font-semibold">{t('report.editMode.title')}</span> ·{' '}
          {t('report.editMode.hint')}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          {editing ? (
            <Form {...form}>
              <form onSubmit={(e) => e.preventDefault()}>
                <ReportEditor
                  companies={detail.companies}
                  photos={
                    <PhotoPicker
                      draft={photos}
                      timezone={tz}
                      reportDate={r.date}
                      pdfMaxPhotos={settings.data?.settings.pdf_max_photos}
                      disabled={saving}
                    />
                  }
                />
              </form>
            </Form>
          ) : (
            <ReportView
              detail={detail}
              onShowAnswer={(anchor) => setFocusAnchor(anchor)}
              onOpenHistory={() => {
                const el = document.getElementById('version-switch');
                el?.focus();
              }}
            />
          )}
        </div>
        <aside aria-label={t('report.aside.source')}>
          <SourcePanel detail={detail} focusAnchor={focusAnchor} />
        </aside>
      </div>

      <ConfirmDialog
        open={signOffOpen}
        onOpenChange={setSignOffOpen}
        title={t('report.signOffDialog.title', { no: r.reportNo, version: detail.version })}
        description={t('report.signOffDialog.body')}
        confirmLabel={t('report.signOffDialog.confirm')}
        cancelLabel={t('report.signOffDialog.cancel')}
        loading={signOff.isPending}
        onConfirm={() =>
          signOff.mutate(
            { reportId: r.id, reportNo: r.reportNo },
            { onSettled: () => setSignOffOpen(false) },
          )
        }
      />

      <Dialog open={noteOpen} onOpenChange={(o) => !saving && setNoteOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('report.editMode.saveTitle', { no: r.reportNo })}</DialogTitle>
            <DialogDescription>
              {t('report.editMode.saveBody', { version: r.currentVersion + 1 })}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 grid gap-1.5">
            <Label htmlFor="change-note">{t('report.edit.changeNote')}</Label>
            <Textarea
              id="change-note"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                if (e.target.value.trim()) setNoteError(null);
              }}
              placeholder={t('report.edit.changeNotePlaceholder')}
              aria-invalid={!!noteError}
              aria-describedby={noteError ? 'change-note-error' : undefined}
              rows={3}
              autoFocus
            />
            {noteError ? (
              <p
                id="change-note-error"
                role="alert"
                className="text-caption font-medium text-missing"
              >
                {noteError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNoteOpen(false)} disabled={saving}>
              {t('report.signOffDialog.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={saving}
              onClick={() => void onConfirmSave()}
              data-testid="confirm-save"
            >
              {t('report.actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t('report.editMode.cancelTitle')}
        description={t('report.editMode.cancelBody')}
        confirmLabel={t('report.editMode.discard')}
        cancelLabel={t('report.editMode.keepEditing')}
        destructive
        onConfirm={() => {
          setDiscardOpen(false);
          setEditing(false);
          reset(toFormValues(detail.data));
          photos.reset(detail.photos);
        }}
      />
    </>
  );
}

function chipVariant(detail: ReportDetail) {
  const r = detail.report;
  if (r.status === 'signed_off') return 'signed_off' as const;
  if (r.status === 'filed' && r.needsReview) return 'needs_review' as const;
  if (r.kind === 'weather_day') return 'weather_day' as const;
  if (r.status === 'filed') return 'filed' as const;
  return 'awaiting' as const;
}

/** The review reason's words (P7 banner): `kind:value` codes of `reports.review_reasons`. */
function reasonText(reason: string, t: LooseT): string {
  const [kind = '', ...rest] = reason.split(':');
  const value = rest.join(':');
  switch (kind) {
    case 'unknown_company':
      return t('report.reasons.unknown_company', { name: value });
    case 'low_confidence':
      return t('report.reasons.low_confidence', { path: value });
    case 'unanswered':
      return t('report.reasons.unanswered', { field: value });
    case 'unconfirmed':
      return t('report.reasons.unconfirmed');
    case 'call_mismatch':
      return t('report.reasons.call_mismatch', { path: value || '—' });
    case 'no_photo':
      return t('report.reasons.no_photo');
    default:
      return reason;
  }
}

/**
 * The call second a `call_mismatch:<path>` reason points at (P7 "Play at 2:15"): the first call
 * source of the value at that path ("manpower[1].workers", "manpower.1.workers"), if the report
 * holds that call's recording.
 */
function callSourceAt(
  detail: ReportDetail,
  path: string,
): { callId: string; start: number } | null {
  const keys = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let node: unknown = detail.data;
  let sources: Source[] | undefined;
  for (const k of keys) {
    if (!node || typeof node !== 'object') break;
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.source)) sources = rec.source as Source[];
    node = Array.isArray(node) ? node[Number(k)] : rec[k];
  }
  if (node && typeof node === 'object' && Array.isArray((node as { source?: unknown }).source))
    sources = (node as { source: Source[] }).source;
  const call = sources?.find(
    (s): s is Extract<Source, { type: 'call' }> =>
      s.type === 'call' && detail.clips.some((c) => c.id === s.callId),
  );
  return call ? { callId: call.callId, start: call.start } : null;
}
