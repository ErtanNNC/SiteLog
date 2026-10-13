import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronLeft, ChevronRight, FileDown, Pencil, PenLine, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { formatTimeInTz, formatWeekdayMonthDay } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { TopBarControls } from '@/components/shell/TopBar';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { ErrorState, ReviewReasonsBanner } from '@/components/sitelog/States';
import { LateBadge, StatusChip } from '@/components/sitelog/StatusChip';
import { VoicePlayerProvider } from '@/components/sitelog/VoicePlayer';
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
import { copy } from '@/copy/en';
import { reviewReasonText, unlinkedCompanyReasons } from '@/data/assemble';
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
import { formatDateTimeShort } from '@/lib/format';
import { openInNewTab } from '@/lib/tab';
import { errorMessage } from '@/lib/utils';
import { PhotoPicker } from './PhotoPicker';
import { ReportEditor } from './ReportEditor';
import { ReportView } from './ReportView';
import { SourcePanel } from './SourcePanel';
import {
  reportFormSchema,
  sameReportData,
  toFormValues,
  toReportData,
  type ReportFormValues,
} from './reportForm';
import { reportPhotoEntries, usePhotoDraft } from './usePhotoDraft';

const UNDO_WINDOW_MS = 10 * 60_000;
const cp = copy.report.editMode.photos;

/** P7 · Report review — structured report + source panel, versions, sign-off, edit → new version (§11.4, F14). */
export default function ReportDetailPage() {
  const { reportId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const vParam = Number(params.get('v'));
  const version = Number.isInteger(vParam) && vParam > 0 ? vParam : null;
  const detail = useReportDetail(reportId, version);

  if (detail.isPending) return <PageSkeleton />;
  if (detail.isError || !detail.data)
    return (
      <ErrorState
        thing={copy.nav.reports.toLowerCase()}
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />
    );
  return (
    <VoicePlayerProvider>
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
    </VoicePlayerProvider>
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
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);
  const [pendingData, setPendingData] = useState<ReportDetail['data'] | null>(null);
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

  const provenance = buildProvenance(detail);
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
    let data: ReportDetail['data'];
    try {
      // data.photos: the version's photos still listed, with their captions (new picks are
      // uploaded on confirm and appended by the server).
      data = toReportData(
        values,
        { ...detail.data, photos: photos.kept() },
        {
          userId: source.user.id,
          at: source.now().toISOString(),
          companies: detail.companies,
        },
      );
    } catch (err) {
      toast.error(errorMessage(err, copy.errors.generic));
      return;
    }
    // A photo change alone is an edit.
    const shown = { ...detail.data, photos: reportPhotoEntries(detail.photos) };
    if (sameReportData(data, shown) && !photos.hasNew) {
      toast.message(copy.report.editMode.noChanges);
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
      setNoteError(copy.report.edit.changeNoteRequired);
      return;
    }
    setSaving(true);
    let toastId: string | number | undefined;
    try {
      const picked = await photos.settle();
      if (!alive.current) return;
      if (!picked) {
        setNoteOpen(false);
        toast.error(cp.notReady);
        return;
      }
      let uploads: Awaited<ReturnType<typeof photos.upload>> = [];
      if (picked.length) {
        toastId = toast.loading(cp.uploading(1, picked.length));
        try {
          uploads = await photos.upload(source, detail.site.id, picked, (i, n) =>
            toast.loading(cp.uploading(i, n), { id: toastId }),
          );
        } catch {
          if (alive.current) toast.error(cp.uploadFailed, { id: toastId });
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
    return {
      key: reason,
      text: reviewReasonText(reason),
      action:
        kind === 'unknown_company' ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={resolveCompany.isPending}
              onClick={() => resolve(name, 'add')}
            >
              {copy.states.reviewReasons.addAsSub}
            </Button>
            <Select onValueChange={(companyId) => resolve(name, 'map', companyId)}>
              <SelectTrigger
                dense
                className="h-9 w-auto min-w-[180px]"
                aria-label={copy.states.reviewReasons.mapTo}
              >
                <SelectValue placeholder={copy.states.reviewReasons.mapTo} />
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
          aria-label={copy.report.previous}
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
          aria-label={copy.report.next}
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
          { label: copy.report.breadcrumb, to: '/reports' },
          { label: detail.site.name, to: `/sites/${detail.site.id}` },
          { label: r.reportNo },
        ]}
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <span>{copy.report.eyebrow(r.reportNo)}</span>
            <StatusChip variant={chipVariant(detail)} label={chipLabel(detail)} size="sm" />
            {r.isLate && r.receivedAt ? (
              <LateBadge time={formatTimeInTz(r.receivedAt, tz)} />
            ) : null}
            <span className="inline-flex items-center gap-1 normal-case tracking-normal">
              <Label htmlFor="version-switch" className="sr-only">
                {copy.report.versionSwitcher}
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
                    <SelectItem
                      key={v.version}
                      value={String(v.version)}
                      title={copy.report.versionLine(
                        v.authorName,
                        formatDateTimeShort(v.createdAt, tz),
                        v.changeNote,
                      )}
                    >
                      {copy.report.version(v.version, v.isCurrent)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {viewedVersion ? (
                <span className="hidden text-[12px] text-dust md:inline" data-testid="version-line">
                  {copy.report.versionLine(
                    viewedVersion.authorName,
                    formatDateTimeShort(viewedVersion.createdAt, tz),
                    viewedVersion.changeNote,
                  )}
                </span>
              ) : null}
            </span>
          </span>
        }
        title={copy.report.title(formatWeekdayMonthDay(r.date), detail.site.shortName)}
        subtitle={<span data-testid="provenance">{provenance}</span>}
        actions={
          editing ? (
            <>
              {/* While saving, Cancel would leave a save that still creates the version. */}
              <Button variant="ghost" onClick={onCancelEdit} disabled={saving}>
                {copy.report.actions.cancel}
              </Button>
              <Button
                variant="primary"
                onClick={() => void onSaveClick()}
                loading={saving}
                data-testid="save-version"
              >
                <PenLine aria-hidden="true" />
                {copy.report.actions.save}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={startEdit} disabled={r.status === 'void'}>
                <Pencil aria-hidden="true" />
                {copy.report.actions.edit}
              </Button>
              <Button variant="ghost" onClick={onPdf}>
                <FileDown aria-hidden="true" />
                {copy.report.actions.pdf}
              </Button>
              {r.status === 'signed_off' ? (
                <span
                  className="inline-flex h-11 items-center gap-2 rounded-btn border border-filed px-3 text-caption font-medium text-chip-filed-fg"
                  data-testid="signed-off-state"
                >
                  {copy.report.actions.signedOffBy(r.signedOffByName ?? '—')}
                  {undoAvailable ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <Button
                        variant="link"
                        size="sm"
                        className="text-chip-filed-fg"
                        loading={undoSignOff.isPending}
                        onClick={() => undoSignOff.mutate({ reportId: r.id })}
                        title={copy.report.undoWindow}
                      >
                        <Undo2 className="!size-4" aria-hidden="true" />
                        {copy.report.actions.undo}
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
                  {copy.report.actions.signOff}
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
          <span>{copy.report.viewingOld(detail.version, r.currentVersion)}</span>
          <Button variant="link" size="sm" onClick={() => onSelectVersion(r.currentVersion)}>
            {copy.report.viewCurrent}
          </Button>
        </div>
      ) : null}

      {reasons.length ? (
        <ReviewReasonsBanner reasons={reasons} className="mb-4" data-testid="review-banner" />
      ) : null}

      {editing ? (
        <div className="mb-4 rounded-card border border-signal bg-signal-tint/40 px-4 py-3 text-caption">
          <span className="font-semibold">{copy.report.editMode.title}</span> ·{' '}
          {copy.report.editMode.hint}
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
              onOpenMessage={(id) => setOpenMessageId(id)}
              onOpenHistory={() => {
                const el = document.getElementById('version-switch');
                el?.focus();
              }}
            />
          )}
        </div>
        <aside aria-label={copy.report.aside.source}>
          <SourcePanel detail={detail} openMessageId={openMessageId} />
        </aside>
      </div>

      <ConfirmDialog
        open={signOffOpen}
        onOpenChange={setSignOffOpen}
        title={copy.report.signOffDialog.title(r.reportNo, detail.version)}
        description={copy.report.signOffDialog.body}
        confirmLabel={copy.report.signOffDialog.confirm}
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
            <DialogTitle>{copy.report.editMode.saveTitle(r.reportNo)}</DialogTitle>
            <DialogDescription>
              {copy.report.editMode.saveBody(r.currentVersion + 1)}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 grid gap-1.5">
            <Label htmlFor="change-note">{copy.report.edit.changeNote}</Label>
            <Textarea
              id="change-note"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                if (e.target.value.trim()) setNoteError(null);
              }}
              placeholder={copy.report.edit.changeNotePlaceholder}
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
              {copy.common.cancel}
            </Button>
            <Button
              variant="primary"
              loading={saving}
              onClick={() => void onConfirmSave()}
              data-testid="confirm-save"
            >
              {copy.report.actions.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={copy.report.editMode.cancelTitle}
        description={copy.report.editMode.cancelBody}
        confirmLabel={copy.report.editMode.discard}
        cancelLabel={copy.report.editMode.keepEditing}
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

function chipLabel(detail: ReportDetail): string {
  return copy.chips[chipVariant(detail)];
}

function buildProvenance(detail: ReportDetail): string {
  const r = detail.report;
  const tz = detail.site.timezone;
  const name = detail.reporter?.name ?? copy.sites.reporter;
  const enteredBy = officeEntryAuthor(detail);
  const parts: string[] = [];
  if (enteredBy && r.filedAt)
    parts.push(copy.report.provenance.enteredBy(enteredBy, formatTimeInTz(r.filedAt, tz)));
  else if (r.receivedAt)
    parts.push(copy.report.provenance.reportedBy(name, formatTimeInTz(r.receivedAt, tz)));
  // Typed in the panel: there is no WhatsApp confirmation to report.
  if (!enteredBy) {
    if (r.confirmedAt)
      parts.push(copy.report.provenance.confirmed(formatTimeInTz(r.confirmedAt, tz)));
    else if (r.filedAt) parts.push(copy.report.provenance.filedWithoutConfirmation);
  }
  for (const v of detail.versions) {
    if (v.version === 1) continue;
    const t = formatTimeInTz(v.createdAt, tz);
    if (v.author === 'reporter_reply') parts.push(copy.report.provenance.editedByReply(t));
    else if (v.author === 'office_user')
      parts.push(copy.report.provenance.editedBy(v.authorName, t));
  }
  if (r.status === 'signed_off' && r.signedOffAt)
    parts.push(
      copy.report.provenance.signedOff(r.signedOffByName ?? '—', formatTimeInTz(r.signedOffAt, tz)),
    );
  return parts.join(' · ');
}
