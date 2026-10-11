import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { copy } from '@/copy/en';
import { useAddInvoice } from '@/data/hooks';
import type { HoursMatrix } from '@/data/types';
import { formatHoursNum, weekdayName } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  matrix: HoursMatrix;
  onAdded?: (companyId: string) => void;
}

/** "Add invoice": company, invoice no, period, per-day hours grid (prefilled from the week), file. */
export function AddInvoiceDialog({ open, onOpenChange, matrix, onAdded }: Props) {
  const c = copy.hours.addDialog;
  const add = useAddInvoice();
  const [companyId, setCompanyId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [periodStart, setPeriodStart] = useState(matrix.weekStart);
  const [periodEnd, setPeriodEnd] = useState(matrix.weekEnd);
  const [hours, setHours] = useState<string[]>(() => matrix.days.map(() => ''));
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const companies = matrix.companies.filter((x) => !x.isSelfPerform && x.status === 'confirmed');

  const reset = () => {
    setCompanyId('');
    setInvoiceNo('');
    setPeriodStart(matrix.weekStart);
    setPeriodEnd(matrix.weekEnd);
    setHours(matrix.days.map(() => ''));
    setFile(null);
    setErrors({});
  };

  const pickCompany = (id: string) => {
    setCompanyId(id);
    const row = matrix.rows.find((r) => r.companyId === id);
    setHours(matrix.days.map((_, i) => (row?.days[i] ? String(row.days[i]) : '')));
  };

  const parsed = hours.map((h) => (h.trim() === '' ? 0 : Number(h)));
  const total = parsed.every((n) => Number.isFinite(n))
    ? parsed.reduce((a, b) => a + b, 0)
    : NaN;

  const submit = () => {
    const next: Record<string, string> = {};
    if (!companyId) next.company = c.companyRequired;
    if (!invoiceNo.trim()) next.invoiceNo = c.invoiceNoRequired;
    if (periodEnd < periodStart) next.period = c.periodInvalid;
    if (!Number.isFinite(total)) next.hours = c.hoursInvalid;
    setErrors(next);
    if (Object.keys(next).length) return;
    add.mutate(
      {
        companyId,
        invoiceNo: invoiceNo.trim(),
        periodStart,
        periodEnd,
        lines: matrix.days.map((date, i) => ({ date, hours: parsed[i] ?? 0 })),
        totalHours: total,
        file,
      },
      {
        onSuccess: () => {
          onAdded?.(companyId);
          onOpenChange(false);
          reset();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{c.title}</DialogTitle>
          <DialogDescription>{c.description}</DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="inv-company">{c.company}</Label>
              <Select value={companyId} onValueChange={pickCompany}>
                <SelectTrigger id="inv-company" aria-invalid={!!errors.company}>
                  <SelectValue placeholder={c.companyPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((co) => (
                    <SelectItem key={co.id} value={co.id}>
                      {co.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.company ? (
                <p role="alert" className="text-caption font-medium text-missing">
                  {errors.company}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inv-no">{c.invoiceNo}</Label>
              <Input
                id="inv-no"
                value={invoiceNo}
                onChange={(e) => setInvoiceNo(e.target.value)}
                placeholder={c.invoiceNoPlaceholder}
                aria-invalid={!!errors.invoiceNo}
                className="font-mono"
              />
              {errors.invoiceNo ? (
                <p role="alert" className="text-caption font-medium text-missing">
                  {errors.invoiceNo}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inv-start">{c.periodStart}</Label>
              <Input
                id="inv-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inv-end">{c.periodEnd}</Label>
              <Input
                id="inv-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                aria-invalid={!!errors.period}
                className="font-mono"
              />
              {errors.period ? (
                <p role="alert" className="text-caption font-medium text-missing">
                  {errors.period}
                </p>
              ) : null}
            </div>
          </div>

          <fieldset className="grid gap-1.5">
            <legend className="text-caption font-medium">{c.hours}</legend>
            <p className="text-caption text-dust">{c.hoursHint}</p>
            <div className="grid grid-cols-5 gap-2">
              {matrix.days.map((d, i) => (
                <div key={d} className="grid gap-1">
                  <Label htmlFor={`inv-h-${i}`} className="eyebrow text-dust">
                    {weekdayName(d).slice(0, 3)}
                  </Label>
                  <Input
                    id={`inv-h-${i}`}
                    inputMode="decimal"
                    value={hours[i] ?? ''}
                    onChange={(e) =>
                      setHours((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                    }
                    className="px-2 text-right font-mono tabular"
                    aria-invalid={!!errors.hours}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-caption">
              <span className="text-dust">{c.total}</span>
              <span className="font-mono text-data font-semibold tabular" data-testid="invoice-total">
                {Number.isFinite(total) ? `${formatHoursNum(total)} ${copy.common.hoursUnit}` : '—'}
              </span>
            </div>
            {errors.hours ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {errors.hours}
              </p>
            ) : null}
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor="inv-file">{c.file}</Label>
            <input
              id="inv-file"
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-caption text-dust file:mr-3 file:h-10 file:rounded-btn file:border file:border-rebar file:bg-chalk file:px-3 file:font-semibold file:text-asphalt"
            />
            <p className="text-caption text-dust">{c.fileHint}</p>
          </div>

          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{copy.common.cancel}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={add.isPending}>
              {c.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
