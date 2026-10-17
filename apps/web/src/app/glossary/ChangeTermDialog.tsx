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
import { useReviewGlossaryTerm } from '@/data/hooks';
import type { GlossaryTerm } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';

/**
 * W4-08 (§19 Q238): change how reports write a built-in starter term. Saved by the audited
 * `review_glossary_term` (`change`): the term becomes the org's confirmed term, and the starter
 * seed never puts SiteLog's wording back.
 */
export function ChangeTermDialog({
  term,
  onOpenChange,
}: {
  term: GlossaryTerm | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useCopy();
  return (
    <Dialog open={term !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('glossary.builtIn.changeTitle')}</DialogTitle>
          <DialogDescription>
            {t('glossary.builtIn.changeDescription', { heard: term?.heard ?? '' })}
          </DialogDescription>
        </DialogHeader>
        {term ? (
          <ChangeTermForm key={term.id} term={term} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ChangeTermForm({ term, onDone }: { term: GlossaryTerm; onDone: () => void }) {
  const { t } = useCopy();
  const review = useReviewGlossaryTerm();
  const [official, setOfficial] = useState(term.official ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const value = official.trim();
    if (!value) {
      setError(t('glossary.form.officialRequired'));
      return;
    }
    review.mutate({ termId: term.id, action: 'change', official: value }, { onSuccess: onDone });
  };

  return (
    <form
      className="mt-4 grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="builtin-official">{t('glossary.changeLabel')}</Label>
        <Input
          id="builtin-official"
          value={official}
          onChange={(e) => setOfficial(e.target.value)}
          aria-invalid={!!error}
          autoFocus
        />
        {error ? (
          <p role="alert" className="text-caption font-medium text-missing">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter className="mt-2">
        <DialogClose asChild>
          <Button variant="ghost">{t('common.cancel')}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" loading={review.isPending}>
          {t('glossary.saveChange')}
        </Button>
      </DialogFooter>
    </form>
  );
}
