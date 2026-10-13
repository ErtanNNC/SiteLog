import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { INCIDENT_SEVERITIES, WORK_STATUSES } from '@sitelog/shared/schemas/report.ts';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/Form';
import { Input, Textarea } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { copy } from '@/copy/en';
import type { CompanyOption } from '@/data/types';
import { formatHoursNum } from '@/lib/format';
import { NEW_COMPANY, emptyManpowerRow, type ReportFormValues } from './reportForm';

const t = copy.report.editMode;

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className="pt-3">{children}</CardContent>
    </Card>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="dense" onClick={onClick}>
      <Plus aria-hidden="true" />
      {label}
    </Button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="subtle" size="iconDense" aria-label={label} onClick={onClick}>
      <Trash2 aria-hidden="true" />
    </Button>
  );
}

/**
 * Edit mode body for P7: inline fields per section; rows add/remove; company select with "Add
 * new…". `photos` is the Photos section (PhotoPicker), last as in the report view.
 */
export function ReportEditor({
  companies,
  photos,
}: {
  companies: CompanyOption[];
  photos?: ReactNode;
}) {
  const form = useFormContext<ReportFormValues>();
  const manpower = useFieldArray({ control: form.control, name: 'manpower' });
  const periods = useFieldArray({ control: form.control, name: 'periods' });
  const work = useFieldArray({ control: form.control, name: 'workPerformed' });
  const deliveries = useFieldArray({ control: form.control, name: 'deliveries' });
  const incidents = useFieldArray({ control: form.control, name: 'safety.incidents' });
  const next = useFieldArray({ control: form.control, name: 'nextWorkday' });
  const rows = useWatch({ control: form.control, name: 'manpower' });
  const sortedCompanies = [...companies].sort((a, b) => a.name.localeCompare(b.name));

  const totalWorkers = rows.reduce((a, r) => a + (Number(r.workers) || 0), 0);
  const totalHours = rows.reduce(
    (a, r) => a + (Number(r.workers) || 0) * (Number(r.hoursPerWorker) || 0),
    0,
  );

  return (
    <div className="space-y-4" data-testid="report-editor">
      <Section title={t.summary}>
        <FormField
          control={form.control}
          name="summary"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="sr-only">{t.summary}</FormLabel>
              <FormControl>
                <Textarea {...field} rows={5} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </Section>

      <Section
        title={copy.report.sections.weather}
        action={
          <AddButton
            label={t.addPeriod}
            onClick={() =>
              periods.append({
                origIndex: null,
                condition: '',
                start: '',
                end: '',
                impact: '',
                lostHours: '',
              })
            }
          />
        }
      >
        <FormField
          control={form.control}
          name="conditionsText"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t.conditions}</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {periods.fields.length ? (
          <ul className="mt-4 space-y-3">
            {periods.fields.map((f, i) => (
              <li key={f.id} className="rounded-card border border-rebar p-3">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1.2fr)_90px_90px_100px_auto] md:items-end">
                  <FormField
                    control={form.control}
                    name={`periods.${i}.condition`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.condition}</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`periods.${i}.start`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.start}</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" placeholder="07:00" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`periods.${i}.end`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.end}</FormLabel>
                        <FormControl>
                          <Input {...field} className="font-mono" placeholder="10:30" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`periods.${i}.lostHours`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.lostHours}</FormLabel>
                        <FormControl>
                          <Input {...field} inputMode="decimal" className="font-mono text-right" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <RemoveButton label={t.removePeriod} onClick={() => periods.remove(i)} />
                </div>
                <FormField
                  control={form.control}
                  name={`periods.${i}.impact`}
                  render={({ field }) => (
                    <FormItem className="mt-3">
                      <FormLabel>{t.impact}</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section
        title={copy.report.sections.manpower}
        action={<AddButton label={t.addRow} onClick={() => manpower.append(emptyManpowerRow())} />}
      >
        {manpower.fields.length === 0 ? (
          <p className="text-caption text-dust">{copy.report.manpowerEmpty}</p>
        ) : null}
        <ul className="space-y-3">
          {manpower.fields.map((f, i) => {
            const isNew = rows[i]?.companyId === NEW_COMPANY;
            return (
              <li
                key={f.id}
                className="rounded-card border border-rebar p-3"
                data-testid="manpower-edit-row"
              >
                <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_84px_96px_auto] md:items-end">
                  <FormField
                    control={form.control}
                    name={`manpower.${i}.companyId`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.company}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger dense>
                              <SelectValue placeholder={t.company} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {sortedCompanies.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                                {c.status === 'unconfirmed' ? ` · ${copy.chips.unconfirmed}` : ''}
                              </SelectItem>
                            ))}
                            <SelectItem value={NEW_COMPANY}>
                              {copy.report.manpower.addNewCompany}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {isNew ? (
                    <FormField
                      control={form.control}
                      name={`manpower.${i}.newCompanyName`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t.newCompanyName}</FormLabel>
                          <FormControl>
                            <Input {...field} className="h-10" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ) : (
                    <FormField
                      control={form.control}
                      name={`manpower.${i}.trade`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t.trade}</FormLabel>
                          <FormControl>
                            <Input {...field} className="h-10" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                  <FormField
                    control={form.control}
                    name={`manpower.${i}.area`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.area}</FormLabel>
                        <FormControl>
                          <Input {...field} className="h-10" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`manpower.${i}.workers`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.workers}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            inputMode="numeric"
                            className="h-10 font-mono text-right"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`manpower.${i}.hoursPerWorker`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.hoursPerWorker}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            inputMode="decimal"
                            className="h-10 font-mono text-right"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <RemoveButton
                    label={t.removeRow(rows[i]?.companyName || rows[i]?.newCompanyName || '')}
                    onClick={() => manpower.remove(i)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-right font-mono text-data text-dust tabular">
          {copy.report.manpower.total}: {totalWorkers} {copy.common.workersUnit} ·{' '}
          {formatHoursNum(totalHours)} {copy.common.hoursUnit}
        </p>
      </Section>

      <Section
        title={t.workItems}
        action={
          <AddButton
            label={t.addWork}
            onClick={() =>
              work.append({
                origIndex: null,
                area: '',
                activity: '',
                status: 'in_progress',
                percentComplete: '',
              })
            }
          />
        }
      >
        {work.fields.length === 0 ? (
          <p className="text-caption text-dust">{copy.report.workEmpty}</p>
        ) : null}
        <ul className="space-y-3">
          {work.fields.map((f, i) => (
            <li
              key={f.id}
              className="grid gap-3 rounded-card border border-rebar p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_150px_90px_auto] md:items-end"
            >
              <FormField
                control={form.control}
                name={`workPerformed.${i}.area`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.area}</FormLabel>
                    <FormControl>
                      <Input {...field} className="h-10" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`workPerformed.${i}.activity`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.activity}</FormLabel>
                    <FormControl>
                      <Input {...field} className="h-10" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`workPerformed.${i}.status`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.status}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger dense>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {WORK_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {copy.report.workStatus[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`workPerformed.${i}.percentComplete`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.percent}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="numeric" className="h-10 font-mono text-right" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <RemoveButton label={t.removeWork} onClick={() => work.remove(i)} />
            </li>
          ))}
        </ul>
      </Section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section
          title={t.deliveries}
          action={
            <AddButton
              label={t.addDelivery}
              onClick={() =>
                deliveries.append({
                  origIndex: null,
                  item: '',
                  quantity: '',
                  supplier: '',
                  time: '',
                })
              }
            />
          }
        >
          {deliveries.fields.length === 0 ? (
            <p className="text-caption text-dust">{copy.report.deliveriesEmpty}</p>
          ) : null}
          <ul className="space-y-3">
            {deliveries.fields.map((f, i) => (
              <li key={f.id} className="space-y-2 rounded-card border border-rebar p-3">
                <div className="flex items-end gap-2">
                  <FormField
                    control={form.control}
                    name={`deliveries.${i}.item`}
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>{t.item}</FormLabel>
                        <FormControl>
                          <Input {...field} className="h-10" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <RemoveButton label={t.removeDelivery} onClick={() => deliveries.remove(i)} />
                </div>
                <div className="grid grid-cols-[1fr_1fr_80px] gap-2">
                  <FormField
                    control={form.control}
                    name={`deliveries.${i}.quantity`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.quantity}</FormLabel>
                        <FormControl>
                          <Input {...field} className="h-10" />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`deliveries.${i}.supplier`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.supplier}</FormLabel>
                        <FormControl>
                          <Input {...field} className="h-10" />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`deliveries.${i}.time`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.time}</FormLabel>
                        <FormControl>
                          <Input {...field} className="h-10 font-mono" placeholder="13:00" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title={t.safety}
          action={
            <AddButton
              label={t.addIncident}
              onClick={() =>
                incidents.append({ origIndex: null, description: '', severity: 'near_miss' })
              }
            />
          }
        >
          <FormField
            control={form.control}
            name="safety.toolboxTalk"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t.toolboxTalk}</FormLabel>
                <FormControl>
                  <Input {...field} className="h-10" />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="safety.noIncidentsStated"
            render={({ field }) => (
              <FormItem className="mt-3 flex items-center gap-2">
                <FormControl>
                  <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(!!v)} />
                </FormControl>
                <FormLabel className="font-normal">{t.noIncidents}</FormLabel>
              </FormItem>
            )}
          />
          {incidents.fields.length ? (
            <ul className="mt-3 space-y-2">
              {incidents.fields.map((f, i) => (
                <li key={f.id} className="space-y-2 rounded-card border border-rebar p-3">
                  <div className="flex items-end gap-2">
                    <FormField
                      control={form.control}
                      name={`safety.incidents.${i}.description`}
                      render={({ field }) => (
                        <FormItem className="flex-1">
                          <FormLabel>{t.description}</FormLabel>
                          <FormControl>
                            <Input {...field} className="h-10" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <RemoveButton label={t.removeIncident} onClick={() => incidents.remove(i)} />
                  </div>
                  <FormField
                    control={form.control}
                    name={`safety.incidents.${i}.severity`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.severity}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger dense>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {INCIDENT_SEVERITIES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {t.severities[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </Section>

        <Section
          title={t.nextWorkday}
          action={
            <AddButton
              label={t.addNext}
              onClick={() => next.append({ origIndex: null, item: '' })}
            />
          }
        >
          {next.fields.length === 0 ? (
            <p className="text-caption text-dust">{copy.report.nextEmpty}</p>
          ) : null}
          <ul className="space-y-2">
            {next.fields.map((f, i) => (
              <li key={f.id} className="flex items-end gap-2">
                <FormField
                  control={form.control}
                  name={`nextWorkday.${i}.item`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel className="sr-only">{t.item}</FormLabel>
                      <FormControl>
                        <Input {...field} className="h-10" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <RemoveButton label={t.removeNext} onClick={() => next.remove(i)} />
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {photos}
    </div>
  );
}
