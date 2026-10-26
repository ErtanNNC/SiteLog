import { useLocation, useNavigate, useParams } from 'react-router';
import { legalText, parseLegalKey } from '@sitelog/shared/copy/legal/index.ts';
import { formatDate } from '@sitelog/shared/format.ts';
import { languageOf, type Language } from '@sitelog/shared/locale.ts';
import { SolidButton } from '@/components/Buttons';
import { ActionBar, Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { HOME_PATH } from '@/routes/paths';
import { useSession } from '@/session/useSession';

/**
 * A pack's legal text (W4-06; spec §9.1, §15.2, §19 Q28, Q50): `/legal/<key>`, the privacy
 * notice the Welcome screen links (F4 step 3, Field-02's *Privacy notice*), and every text the pack
 * names from Settings (F15). The texts are `copy/legal` in the app's bundle, so the page works
 * offline once the shell is installed (precached), with or without a link. The text is in the
 * app's language when the key has it, else in the first of the pack's field languages that has it
 * (said on the page, and `lang` set on it). Its version and the day it applies from are shown.
 * No artboard: built from Field-02's type and spacing. *Back* returns to where it was opened from,
 * or to Today when it was opened on its own (the installed app has no back button).
 */
export function Legal() {
  const { key = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { session } = useSession();
  const { t, language } = useFieldCopy();
  const fallbacks = (session?.country.fieldLocales ?? []).map((l) => languageOf(l) as Language);
  const found = legalText(key, language, fallbacks);

  function back() {
    // The first entry of this tab is `default`: opened on its own (a texted link), Today.
    if (location.key !== 'default') void navigate(-1);
    else void navigate(HOME_PATH, { replace: true });
  }

  const backBar = (
    <ActionBar>
      <SolidButton onClick={back}>{t('legal.back')}</SolidButton>
    </ActionBar>
  );

  if (!found) {
    return (
      <Screen title={t('legal.unknown.title')} dateLine={false}>
        <ScreenTitle>{t('legal.unknown.title')}</ScreenTitle>
        <p className="m-0 text-[16px] leading-6 text-dust">{t('legal.unknown.body')}</p>
        {backBar}
      </Screen>
    );
  }

  const { doc, text } = found;
  const version = parseLegalKey(doc.key)?.version ?? 1;
  return (
    <Screen title={text.title} dateLine={false}>
      <article lang={found.language} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="m-0 font-mono text-[12px] leading-[18px] tracking-[0.08em] text-dust uppercase">
            <span lang={language}>
              {t('legal.version', {
                version,
                date: formatDate(doc.effective, 'full', language),
              })}
            </span>
          </p>
          <ScreenTitle>{text.title}</ScreenTitle>
        </div>
        {found.language !== language ? (
          <p
            lang={language}
            className="m-0 rounded-card bg-concrete px-3.5 py-3 text-[15px] leading-[21px] text-steel"
          >
            {t('legal.otherLanguage')}
          </p>
        ) : null}
        {text.body.map((paragraph, i) => (
          <p key={i} className="m-0 text-[16px] leading-6 text-asphalt [overflow-wrap:anywhere]">
            {paragraph}
          </p>
        ))}
      </article>
      {backBar}
    </Screen>
  );
}
