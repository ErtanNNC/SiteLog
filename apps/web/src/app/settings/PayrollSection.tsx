import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { normalizePayrollColumns, PAYROLL_COLUMNS } from '@sitelog/shared/report/payroll.ts';
import { Button } from '@/components/ui/Button';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { copy } from '@/copy/en';
import { SettingsCard, SwitchRow } from './fields';
import type { SectionProps } from './ReportsSection';

/**
 * Payroll export: format preset, column order, include unconfirmed companies (§F18, §P12).
 * The order is org_settings.payroll_columns — saved with "Save changes" and used by
 * api-export-payroll for every CSV.
 */
export function PayrollSection({ draft, update }: SectionProps) {
  const c = copy.settings.payroll;
  const columns = normalizePayrollColumns(draft.payroll_columns);
  const isDefault = columns.every((col, i) => col === PAYROLL_COLUMNS[i]);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= columns.length) return;
    const next = [...columns];
    [next[i], next[j]] = [next[j]!, next[i]!];
    update({ payroll_columns: next });
  };
  return (
    <div className="grid gap-6">
      <SettingsCard title={c.format} hint={c.formatHint}>
        <div className="grid gap-1.5 md:max-w-xs">
          <Label htmlFor="payroll-format">{c.format}</Label>
          <Select
            value={draft.payroll_csv_format}
            onValueChange={(v) => update({ payroll_csv_format: v })}
          >
            <SelectTrigger id="payroll-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="generic">{c.formats.generic}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="mt-5 border-t border-rebar pt-4">
          <SwitchRow
            id="payroll-unconfirmed"
            label={c.includeUnconfirmed}
            hint={c.includeUnconfirmedHint}
            checked={draft.include_unconfirmed_in_payroll}
            onCheckedChange={(v) => update({ include_unconfirmed_in_payroll: v })}
          />
        </div>
      </SettingsCard>

      <SettingsCard title={c.columns} hint={c.columnsHint}>
        <ol className="grid gap-1" data-testid="payroll-columns">
          {columns.map((col, i) => (
            <li
              key={col}
              className="flex h-11 items-center gap-3 rounded-chip border border-rebar bg-chalk px-3"
            >
              <span className="w-6 font-mono text-[12px] text-dust">{i + 1}</span>
              <span className="flex-1 font-mono text-data">{col}</span>
              <Button
                variant="subtle"
                size="iconDense"
                aria-label={c.moveUp(col)}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                variant="subtle"
                size="iconDense"
                aria-label={c.moveDown(col)}
                disabled={i === columns.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ol>
        <Button
          variant="subtle"
          size="dense"
          className="mt-3"
          disabled={isDefault}
          onClick={() => update({ payroll_columns: [...PAYROLL_COLUMNS] })}
        >
          <RotateCcw aria-hidden="true" />
          {c.reset}
        </Button>
      </SettingsCard>
    </div>
  );
}
