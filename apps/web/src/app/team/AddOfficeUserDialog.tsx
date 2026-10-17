import { useState } from 'react';
import { MEMBER_ROLES, type MemberRole } from '@sitelog/shared/enums.ts';
import { ORG_LOCALES, type OrgLocale } from '@sitelog/shared/locale.ts';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/Checkbox';
import { useAddOfficeUser } from '@/data/hooks';
import { useCopy } from '@/i18n/useCopy';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The UI language choice: the company's (stored null, §6.3), or one the panel speaks. */
const ORG_DEFAULT = 'org';
type UiChoice = typeof ORG_DEFAULT | OrgLocale;

/**
 * F24 "Add office user": email + role + UI language (W4-03: the company's, English or Turkish,
 * `org_members.ui_locale`) → the magic-link invite (api-invite-office-user).
 */
export function AddOfficeUserDialog({
  open,
  onOpenChange,
  orgLocale,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The org's locale: what "the company's language" means. */
  orgLocale: OrgLocale;
}) {
  const { t } = useCopy();
  const add = useAddOfficeUser();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('pm');
  const [ui, setUi] = useState<UiChoice>(ORG_DEFAULT);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e)) {
      setError(t('team.addUser.emailInvalid'));
      return;
    }
    setError(null);
    add.mutate(
      { email: e, role, uiLocale: ui === ORG_DEFAULT ? null : ui },
      {
        onSuccess: () => {
          onOpenChange(false);
          setEmail('');
          setRole('pm');
          setUi(ORG_DEFAULT);
        },
      },
    );
  };

  const uiOptions: Array<{ value: UiChoice; label: string }> = [
    {
      value: ORG_DEFAULT,
      label: t('team.addUser.uiLanguageOrg', { language: t(`team.uiLocales.${orgLocale}`) }),
    },
    ...ORG_LOCALES.map((l) => ({ value: l, label: t(`team.uiLocales.${l}`) })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-32px)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('team.addUser.title')}</DialogTitle>
          <DialogDescription>{t('team.addUser.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="ou-email">{t('team.addUser.email')}</Label>
            <Input
              id="ou-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('team.addUser.emailPlaceholder')}
              aria-invalid={!!error}
            />
            {error ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {error}
              </p>
            ) : null}
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-caption font-medium">{t('team.addUser.role')}</legend>
            <RadioGroup
              value={role}
              onValueChange={(v) => setRole(v as MemberRole)}
              aria-label={t('team.addUser.role')}
            >
              {MEMBER_ROLES.map((r) => (
                <label key={r} className="flex min-h-target items-start gap-3 text-[15px]">
                  <RadioGroupItem
                    value={r}
                    className="mt-0.5"
                    aria-label={t(`team.officeRoles.${r}`)}
                  />
                  <span>
                    <span className="font-medium">{t(`team.officeRoles.${r}`)}</span>
                    <span className="block text-caption text-dust">
                      {t(`team.addUser.roleHelp.${r}`)}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="text-caption font-medium">{t('team.addUser.uiLanguage')}</legend>
            <RadioGroup
              value={ui}
              onValueChange={(v) => setUi(v as UiChoice)}
              aria-label={t('team.addUser.uiLanguage')}
              className="gap-1"
            >
              {uiOptions.map((o) => (
                <label key={o.value} className="flex min-h-target items-center gap-3 text-[15px]">
                  <RadioGroupItem value={o.value} aria-label={o.label} />
                  {o.label}
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{t('common.cancel')}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={add.isPending}>
              {t('team.addUser.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
