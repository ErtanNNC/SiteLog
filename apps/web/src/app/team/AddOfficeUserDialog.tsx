import { useState } from 'react';
import { MEMBER_ROLES, type MemberRole } from '@sitelog/shared/enums.ts';
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
import { copy } from '@/copy/en';
import { useAddOfficeUser } from '@/data/hooks';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Add office user": email + role → magic-link invite (F20). */
export function AddOfficeUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const c = copy.team.addUser;
  const add = useAddOfficeUser();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('pm');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e)) {
      setError(c.emailInvalid);
      return;
    }
    setError(null);
    add.mutate(
      { email: e, role },
      {
        onSuccess: () => {
          onOpenChange(false);
          setEmail('');
          setRole('pm');
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{c.title}</DialogTitle>
          <DialogDescription>{c.description}</DialogDescription>
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
            <Label htmlFor="ou-email">{c.email}</Label>
            <Input
              id="ou-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={c.emailPlaceholder}
              aria-invalid={!!error}
            />
            {error ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {error}
              </p>
            ) : null}
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-caption font-medium">{c.role}</legend>
            <RadioGroup value={role} onValueChange={(v) => setRole(v as MemberRole)}>
              {MEMBER_ROLES.map((r) => (
                <label key={r} className="flex min-h-10 items-start gap-3 text-[15px]">
                  <RadioGroupItem value={r} className="mt-0.5" aria-label={copy.team.officeRoles[r]} />
                  <span>
                    <span className="font-medium">{copy.team.officeRoles[r]}</span>
                    <span className="block text-caption text-dust">{c.roleHelp[r]}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{copy.common.cancel}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={add.isPending}>
              {c.send}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
