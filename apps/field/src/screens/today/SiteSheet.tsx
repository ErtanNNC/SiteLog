import { useId } from 'react';
import type { FieldSite } from '@sitelog/shared/field-contract.ts';
import { Sheet } from '@/components/Sheet';
import { useFieldCopy } from '@/i18n/useFieldCopy';

/** The site switcher (F14, §9.3 "site switcher if > 1"): one row per active site. */
export function SiteSheet({
  open,
  sites,
  currentId,
  onPick,
  onClose,
}: {
  open: boolean;
  sites: FieldSite[];
  currentId: string;
  onPick: (siteId: string) => void;
  onClose: () => void;
}) {
  const { t } = useFieldCopy();
  const titleId = useId();
  return (
    <Sheet open={open} titleId={titleId} onClose={onClose}>
      <h2 id={titleId} className="m-0 text-[22px] leading-7 font-extrabold [font-stretch:118%]">
        {t('today.siteSheetTitle')}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {sites.map((site) => {
          const on = site.id === currentId;
          return (
            <li key={site.id}>
              <button
                type="button"
                aria-current={on ? 'true' : undefined}
                onClick={() => onPick(site.id)}
                className={`flex h-target w-full items-center rounded-card px-4 text-left text-[16px] font-semibold ${
                  on ? 'border-2 border-asphalt bg-white' : 'border border-rebar bg-white'
                }`}
              >
                <span className="truncate">{site.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
