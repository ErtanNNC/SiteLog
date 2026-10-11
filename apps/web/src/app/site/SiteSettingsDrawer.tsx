import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { formatMonthDay, formatPhone } from '@sitelog/shared/format.ts';
import { StatusChip } from '@/components/sitelog/StatusChip';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
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
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/Form';
import { Input, Textarea } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { copy } from '@/copy/en';
import { usePauseSite, useResumeSite, useSaveSiteRecipients, useUpdateSite } from '@/data/hooks';
import type { UpdateSitePatch } from '@/data/source';
import type { SiteDetail } from '@/data/types';
import { formatLanguages } from '@/lib/format';
import { uniq } from '@/lib/utils';

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Europe/Berlin',
  'Australia/Sydney',
];

const HHMM = /^\d{2}:\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const numeric = (v: string) => v === '' || !Number.isNaN(Number(v));

const schema = z.object({
  name: z.string().trim().min(1, copy.siteDetail.settings.nameRequired),
  projectCode: z.string().trim().min(1, copy.siteDetail.settings.codeRequired),
  address: z.string().trim(),
  lat: z.string().trim().refine(numeric, copy.siteDetail.settings.latLngInvalid),
  lng: z.string().trim().refine(numeric, copy.siteDetail.settings.latLngInvalid),
  timezone: z.string().min(1),
  deadline: z
    .string()
    .trim()
    .refine((v) => v === '' || HHMM.test(v), copy.siteDetail.settings.timeInvalid),
  workingHours: z.string().trim(),
  recipients: z.string().superRefine((v, ctx) => {
    for (const email of splitEmails(v)) {
      if (!EMAIL.test(email)) {
        ctx.addIssue({
          code: 'custom',
          message: copy.siteDetail.settings.recipientsInvalid(email),
        });
        return;
      }
    }
  }),
});
type FormValues = z.infer<typeof schema>;

function splitEmails(v: string): string[] {
  return uniq(
    v
      .split(/[\n,;]+/)
      .map((e) => e.trim())
      .filter(Boolean),
  );
}

function defaultsFor(detail: SiteDetail): FormValues {
  const s = detail.site;
  return {
    name: s.name,
    projectCode: s.projectCode,
    address: s.address ?? '',
    lat: s.lat === null ? '' : String(s.lat),
    lng: s.lng === null ? '' : String(s.lng),
    timezone: s.timezone,
    deadline: '',
    workingHours: s.workingHours ?? '',
    recipients: detail.recipients.join('\n'),
  };
}

/** P5 site settings drawer: name, code, address / lat-lng, tz, deadline override, hours, reporters, recipients, pause. */
export function SiteSettingsDrawer({
  open,
  onOpenChange,
  detail,
  orgDeadline,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: SiteDetail;
  /** The deadline currently in effect ("17:30"), shown as the hint for the override field. */
  orgDeadline: string;
}) {
  const site = detail.site;
  const updateSite = useUpdateSite();
  const saveRecipients = useSaveSiteRecipients();
  const pauseSite = usePauseSite();
  const resumeSite = useResumeSite();
  const [confirm, setConfirm] = useState<'pause' | 'resume' | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaultsFor(detail),
  });
  const { reset } = form;
  useEffect(() => {
    if (open) reset(defaultsFor(detail));
  }, [open, detail, reset]);

  const timezones = uniq([...TIMEZONES, site.timezone]);
  const saving = updateSite.isPending || saveRecipients.isPending;

  const onSubmit = form.handleSubmit(async (v) => {
    const patch: UpdateSitePatch = {};
    if (v.name !== site.name) patch.name = v.name;
    if (v.projectCode !== site.projectCode) patch.projectCode = v.projectCode;
    if ((v.address || null) !== site.address) patch.address = v.address || null;
    const lat = v.lat === '' ? null : Number(v.lat);
    const lng = v.lng === '' ? null : Number(v.lng);
    if (lat !== site.lat) patch.lat = lat;
    if (lng !== site.lng) patch.lng = lng;
    if (v.timezone !== site.timezone) patch.timezone = v.timezone;
    if (v.deadline !== '') patch.deadline = v.deadline;
    if ((v.workingHours || null) !== site.workingHours) patch.workingHours = v.workingHours || null;
    const emails = splitEmails(v.recipients);
    const recipientsChanged = emails.join(',') !== detail.recipients.join(',');
    if (Object.keys(patch).length) {
      await updateSite.mutateAsync({ siteId: site.id, patch });
    }
    if (recipientsChanged) {
      await saveRecipients.mutateAsync({ siteId: site.id, emails });
    }
    onOpenChange(false);
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent side="right" className="max-w-lg overflow-y-auto p-0 scrollbar-thin">
          <Form {...form}>
            <form onSubmit={(e) => void onSubmit(e)} className="flex min-h-full flex-col">
              <div className="border-b border-rebar px-6 py-5">
                <DialogHeader>
                  <DialogTitle>{copy.siteDetail.settings.title}</DialogTitle>
                  <DialogDescription>
                    {site.name} · <span className="font-mono">{site.projectCode}</span>
                    {site.status === 'paused' && site.pausedAt
                      ? ` · ${copy.siteDetail.settings.pausedNote(formatMonthDay(site.pausedAt.slice(0, 10)))}`
                      : ''}
                  </DialogDescription>
                </DialogHeader>
              </div>

              <div className="flex-1 space-y-5 px-6 py-5">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{copy.siteDetail.settings.name}</FormLabel>
                      <FormControl>
                        <Input {...field} autoComplete="off" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="projectCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{copy.siteDetail.settings.projectCode}</FormLabel>
                      <FormControl>
                        <Input {...field} className="font-mono" autoComplete="off" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{copy.siteDetail.settings.address}</FormLabel>
                      <FormControl>
                        <Input {...field} autoComplete="street-address" />
                      </FormControl>
                      <FormDescription>{copy.siteDetail.settings.addressHint}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="lat"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{copy.siteDetail.settings.lat}</FormLabel>
                        <FormControl>
                          <Input {...field} inputMode="decimal" className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="lng"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{copy.siteDetail.settings.lng}</FormLabel>
                        <FormControl>
                          <Input {...field} inputMode="decimal" className="font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="timezone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{copy.siteDetail.settings.timezone}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {timezones.map((tz) => (
                            <SelectItem key={tz} value={tz}>
                              {tz}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="deadline"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{copy.siteDetail.settings.deadline}</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder={orgDeadline} className="font-mono" />
                        </FormControl>
                        <FormDescription>
                          {copy.siteDetail.settings.deadlineHint(orgDeadline)}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="workingHours"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{copy.siteDetail.settings.workingHours}</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="07:00–15:30" className="font-mono" />
                        </FormControl>
                        <FormDescription>
                          {copy.siteDetail.settings.workingHoursHint}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <section aria-label={copy.siteDetail.settings.reporters}>
                  <h3 className="text-caption font-medium">{copy.siteDetail.settings.reporters}</h3>
                  {detail.reporters.length === 0 ? (
                    <p className="mt-1 text-caption text-dust">
                      {copy.siteDetail.settings.noReporters}
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y divide-rebar rounded-card border border-rebar">
                      {detail.reporters.map((r) => (
                        <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                          <Avatar name={r.name} size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium">{r.name}</span>
                              <Badge variant={r.isPrimary ? 'dark' : 'neutral'}>
                                {r.isPrimary ? copy.siteDetail.primary : copy.siteDetail.backup}
                              </Badge>
                              {r.status === 'invited' ? (
                                <StatusChip
                                  variant="pending"
                                  label={copy.chips.inviteSent}
                                  size="sm"
                                />
                              ) : null}
                            </div>
                            <div className="font-mono text-[12px] text-dust">
                              {formatPhone(r.phone)} · {formatLanguages(r.languages)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-1 text-caption text-dust">
                    {copy.siteDetail.settings.reportersHint}{' '}
                    <Link to="/team" className="text-level hover:underline">
                      {copy.nav.team}
                    </Link>
                  </p>
                </section>

                <FormField
                  control={form.control}
                  name="recipients"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{copy.siteDetail.settings.recipients}</FormLabel>
                      <FormControl>
                        <Textarea {...field} rows={3} spellCheck={false} />
                      </FormControl>
                      <FormDescription>{copy.siteDetail.settings.recipientsHint}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="border-t border-rebar pt-4">
                  {site.status === 'paused' ? (
                    <Button
                      variant="ghost"
                      size="dense"
                      onClick={() => setConfirm('resume')}
                      loading={resumeSite.isPending}
                    >
                      {copy.siteDetail.resumeSite}
                    </Button>
                  ) : (
                    <Button
                      variant="destructive"
                      size="dense"
                      onClick={() => setConfirm('pause')}
                      loading={pauseSite.isPending}
                    >
                      {copy.siteDetail.pauseSite}
                    </Button>
                  )}
                </div>
              </div>

              <DialogFooter className="mt-0 border-t border-rebar px-6 py-4">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  {copy.common.cancel}
                </Button>
                <Button type="submit" variant="primary" loading={saving}>
                  {copy.common.saveChanges}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm === 'resume'
            ? copy.siteDetail.settings.resumeTitle(site.name)
            : copy.siteDetail.settings.pauseTitle(site.name)
        }
        description={
          confirm === 'resume'
            ? copy.siteDetail.settings.resumeBody
            : copy.siteDetail.settings.pauseBody
        }
        confirmLabel={
          confirm === 'resume'
            ? copy.siteDetail.settings.resumeConfirm
            : copy.siteDetail.settings.pauseConfirm
        }
        destructive={confirm === 'pause'}
        loading={pauseSite.isPending || resumeSite.isPending}
        onConfirm={() => {
          const vars = { siteId: site.id, siteName: site.name };
          const done = () => {
            setConfirm(null);
            onOpenChange(false);
          };
          if (confirm === 'resume') resumeSite.mutate(vars, { onSettled: done });
          else pauseSite.mutate(vars, { onSettled: done });
        }}
      />
    </>
  );
}
