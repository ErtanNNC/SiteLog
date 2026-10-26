import { Fragment, useEffect } from 'react';
import { Link } from 'react-router';
import { assetUrl } from '@/lib/asset';
import {
  COMPANY,
  CONTACT_EMAIL,
  LEGAL_DOCS,
  LEGAL_ORDER,
  type Inline,
  type LegalBlock,
  type LegalKey,
} from './content';

const linkClass =
  'font-medium underline decoration-rebar underline-offset-[3px] hover:decoration-asphalt';

function Parts({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === 'string') return <Fragment key={i}>{part}</Fragment>;
        if (part.href.startsWith('/')) {
          return (
            <Link key={i} to={part.href} className={linkClass}>
              {part.text}
            </Link>
          );
        }
        return (
          <a key={i} href={part.href} className={linkClass}>
            {part.text}
          </a>
        );
      })}
    </>
  );
}

function Block({ block }: { block: LegalBlock }) {
  switch (block.type) {
    case 'p':
      return (
        <p>
          <Parts parts={block.parts} />
        </p>
      );
    case 'ul':
      return (
        <ul className="list-disc space-y-1.5 pl-5 marker:text-dust">
          {block.items.map((item, i) => (
            <li key={i}>
              <Parts parts={item} />
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <figure className="rounded-card border border-rebar bg-chalk px-4 py-3">
          <figcaption className="eyebrow text-dust">{block.label}</figcaption>
          <blockquote className="mt-1.5 break-words text-asphalt">{block.text}</blockquote>
        </figure>
      );
  }
}

/**
 * `/sms`, `/terms`, `/privacy`: the US SMS program's public legal documents (content.ts), outside
 * the shell, signed in or not, English only in their own `lang="en"` root.
 */
export default function LegalPage({ doc: key }: { doc: LegalKey }) {
  const doc = LEGAL_DOCS[key];

  useEffect(() => {
    const before = document.title;
    document.title = doc.documentTitle;
    return () => {
      document.title = before;
    };
  }, [doc.documentTitle]);

  return (
    <div lang="en" className="flex min-h-screen flex-col bg-concrete text-asphalt">
      <header className="border-b border-rebar bg-chalk">
        <div className="mx-auto flex w-full max-w-[760px] items-center px-4 py-3 sm:px-6">
          <Link to="/" className="inline-flex min-h-11 items-center">
            <img
              src={assetUrl('brand/logo-lockup.svg')}
              alt="TalkOlog"
              width={156}
              height={32}
              className="h-8 w-auto"
            />
          </Link>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[760px] flex-1 px-4 pb-16 pt-10 sm:px-6">
        <p className="eyebrow text-dust">
          {COMPANY} · Effective: {doc.effective} · Version {doc.version}
        </p>
        <h1 className="mt-2 font-display text-[32px] leading-9 sm:text-h1">{doc.title}</h1>
        <p className="mt-4 text-[17px] leading-7">
          <Parts parts={doc.intro} />
        </p>

        <div className="mt-8 flex flex-col gap-10 text-[16px] leading-[26px]">
          {doc.sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-heading`}
              className="flex flex-col gap-3 border-t border-rebar pt-6"
            >
              <h2 id={`${section.id}-heading`} className="font-h2 text-h2">
                {section.heading}
              </h2>
              {section.blocks.map((block, i) => (
                <Block key={i} block={block} />
              ))}
            </section>
          ))}
        </div>
      </main>

      <footer className="border-t border-rebar bg-chalk">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 py-6 text-caption sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <nav aria-label="Legal">
            <ul className="flex flex-wrap gap-x-5 gap-y-1">
              {LEGAL_ORDER.map((k) => (
                <li key={k}>
                  <Link
                    to={LEGAL_DOCS[k].path}
                    aria-current={k === key ? 'page' : undefined}
                    className="inline-flex min-h-11 items-center underline-offset-[3px] hover:underline aria-[current=page]:font-semibold"
                  >
                    {LEGAL_DOCS[k].title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <p className="text-dust">
            {COMPANY} ·{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className={linkClass}>
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
