import { Link } from 'react-router';
import { EmptyState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { copy } from '@/copy/en';

export default function NotFoundPage() {
  return (
    <div className="mx-auto max-w-lg py-12">
      <EmptyState
        hero
        title={copy.states.notFoundTitle}
        body={copy.states.notFound}
        action={
          <Button variant="secondary" asChild>
            <Link to="/">{copy.states.goHome}</Link>
          </Button>
        }
      />
    </div>
  );
}
