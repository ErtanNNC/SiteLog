import { ArrowLeft, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { copy } from '@/copy/en';
import type { OrgSettings } from '@/data/types';
import { ReportsSection } from '../settings/ReportsSection';
import { EmailChips } from './fields';

export function ReportsStep({
  draft,
  update,
  recipients,
  onRecipientsChange,
  onBack,
  onFinish,
  busy,
}: {
  draft: OrgSettings;
  update: (patch: Partial<OrgSettings>) => void;
  recipients: string[];
  onRecipientsChange: (next: string[]) => void;
  onBack: () => void;
  onFinish: () => void;
  busy: boolean;
}) {
  const c = copy.setup.reports;
  return (
    <div className="grid gap-6">
      <div>
        <h2 className="font-h2 text-h2">{c.title}</h2>
        <p className="mt-1 text-[15px] text-dust">{c.subtitle}</p>
      </div>
      <ReportsSection draft={draft} update={update} />
      <Card>
        <CardContent className="p-5">
          <h3 className="font-h2 text-h2">{c.recipients}</h3>
          <p className="mb-4 mt-1 text-caption text-dust">{c.recipientsHint}</p>
          <EmailChips
            id="setup-recipients"
            emails={recipients}
            onChange={onRecipientsChange}
            label={c.recipients}
          />
        </CardContent>
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {copy.common.back}
        </Button>
        <Button variant="primary" loading={busy} onClick={onFinish}>
          <Check aria-hidden="true" />
          {c.finish}
        </Button>
      </div>
    </div>
  );
}
