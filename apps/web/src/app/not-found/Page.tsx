import { Link } from 'react-router';
import { EmptyState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { useCopy } from '@/i18n/useCopy';

export default function NotFoundPage() {
  const { t } = useCopy();
  return (
    <div className="mx-auto max-w-lg py-12">
      <EmptyState
        hero
        title={t('states.notFoundTitle')}
        body={t('states.notFound')}
        action={
          <Button variant="secondary" asChild>
            <Link to="/">{t('states.goHome')}</Link>
          </Button>
        }
      />
    </div>
  );
}
