import { ArrowLeft, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import type { OrgSettings } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { ReportsSection } from '../settings/ReportsSection';
import { EmailChips } from './fields';

/**
 * F2 step 3 · Reports & reminders. Its settings are Settings' own section (EN/TR since W4-05),
 * without the daily link card's link to Field channels.
 */
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
  const { t } = useCopy();
  return (
    <div className="grid gap-6">
      <div>
        <h2 className="font-h2 text-h2">{t('setup.reports.title')}</h2>
        <p className="mt-1 text-[15px] text-dust">{t('setup.reports.subtitle')}</p>
      </div>
      <ReportsSection draft={draft} update={update} />
      <Card>
        <CardContent className="p-5">
          <h3 className="font-h2 text-h2">{t('setup.reports.recipients')}</h3>
          <p className="mb-4 mt-1 text-caption text-dust">{t('setup.reports.recipientsHint')}</p>
          <EmailChips
            id="setup-recipients"
            emails={recipients}
            onChange={onRecipientsChange}
            label={t('setup.reports.recipients')}
          />
        </CardContent>
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {t('common.back')}
        </Button>
        <Button variant="primary" loading={busy} onClick={onFinish}>
          <Check aria-hidden="true" />
          {t('setup.reports.finish')}
        </Button>
      </div>
    </div>
  );
}
