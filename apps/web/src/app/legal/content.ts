/**
 * The panel's three public legal pages: `/sms` (the US SMS program), `/terms` and `/privacy`.
 * They are the documents Twilio's reviewers read for the US pack's toll-free verification (spec
 * §5.2 step 7, §15.2), so they are English only (owner decision 2026-10-20): they render outside
 * the shell, signed in or not, in their own `lang="en"` root, and are not keyed panel copy (no
 * `t()`, no `<EnglishOnly>`; `routes.english-only.test.ts` holds both). The texts live here as
 * data, one page component (`Page.tsx`) renders them.
 *
 * Facts must stay true to the product: the sample texts are rendered from the SMS catalogue
 * (`packages/shared/src/copy/sms.en.ts`), so a wording change there shows here; the processors and
 * retention periods follow spec §5.2 and §15. A new version of a document gets a new
 * `version` and `effective` date.
 */
import { smsEn, smsReplyHintEn } from '@sitelog/shared/copy/sms.en.ts';

export type LegalKey = 'sms' | 'terms' | 'privacy';

/** Text, or a link: a path in the panel (`/terms`) or a `mailto:`. */
export type Inline = string | { href: string; text: string };

export type LegalBlock =
  | { type: 'p'; parts: Inline[] }
  | { type: 'ul'; items: Inline[][] }
  /** A quoted text shown as it is said or sent: the verbal script, a sample message. */
  | { type: 'quote'; label: string; text: string };

export interface LegalSection {
  id: string;
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDoc {
  key: LegalKey;
  path: `/${LegalKey}`;
  /** The page's `<h1>`. */
  title: string;
  /** `document.title`. */
  documentTitle: string;
  effective: string;
  version: number;
  intro: Inline[];
  sections: LegalSection[];
}

export const COMPANY = 'Yalp LLC';
export const CONTACT_EMAIL = 'ertan@yalpllc.com';
export const EFFECTIVE = '2026-10-20';

const email: Inline = { href: `mailto:${CONTACT_EMAIL}`, text: CONTACT_EMAIL };
const terms: Inline = { href: '/terms', text: 'Terms of Service' };
const privacy: Inline = { href: '/privacy', text: 'Privacy Policy' };
const smsPage: Inline = { href: '/sms', text: 'SMS program' };

const p = (...parts: Inline[]): LegalBlock => ({ type: 'p', parts });
const ul = (...items: (Inline | Inline[])[]): LegalBlock => ({
  type: 'ul',
  items: items.map((i) => (Array.isArray(i) ? i : [i])),
});

/** What a sample message shows in place of each catalogue placeholder. */
const SAMPLE_VALUES: Record<string, string> = {
  first: '<first name>',
  company: '<Company>',
  site: '<Site>',
  deadline: '<time>',
  time: '<time>',
  link: '<link>',
  pdf_link: '<link>',
  report_no: '<report number>',
  number: '<phone number>',
};

/** A catalogue text with its placeholders shown as `<…>`. */
export function sampleText(text: string): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => SAMPLE_VALUES[key] ?? whole);
}

/** The US pack's first text: §9.2 `welcome` plus the two-way reply clause, as `renderSms` sends it. */
export const SAMPLE_WELCOME = sampleText(smsEn.welcome.withoutNumber + smsReplyHintEn);

export const VERBAL_SCRIPT =
  'We use TalkOlog for daily site reports. If you agree, TalkOlog will text you or message you on WhatsApp on behalf of [Company name] about your daily report for [Site]: your daily report link, up to two reminders if the report is missing, a question if something is unclear, and a confirmation when the report is filed. Usually 1 to 4 messages per workday. Message and data rates may apply. You can reply HELP for help or STOP to opt out at any time. Our terms are at talkolog.com/terms and our privacy policy at talkolog.com/privacy. Do you agree to receive these messages from TalkOlog at this number? Yes or no?';

/** The panel's required box (`team.invite.smsAttest`, version `team.invite_sms.v2`). */
export const OPT_IN_CHECKBOX =
  '<Name> agreed to get daily report messages from TalkOlog by text or WhatsApp';

/** §19 Q372: the program's messages go by SMS or WhatsApp. */
const CHANNELS =
  'TalkOlog sends these messages by SMS or by WhatsApp, as one program: the same messages, at the same frequency, from the same TalkOlog number. A message may come on WhatsApp first and by SMS when WhatsApp cannot reach you.';

const FREQUENCY = 'Usually 1 to 4 messages per workday.';
const RATES = 'Message and data rates may apply.';
const CARRIERS = 'Carriers are not liable for delayed or undelivered messages.';
const NO_SHARING_MARKETING =
  'No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.';
const NO_SHARING_OPT_IN =
  'Text messaging originator opt-in data and consent will not be shared with any third parties.';

/** The program's message types (§9.2 keys), shared by `/sms` and the Terms. */
const MESSAGE_TYPES: Inline[] = [
  'Your daily report link.',
  'Up to two reminders when the day’s report is missing.',
  'A question when something in the report is unclear.',
  'A note that your report is ready to check.',
  'A confirmation, with a link to the PDF, when the report is filed.',
];

const sms: LegalDoc = {
  key: 'sms',
  path: '/sms',
  title: 'TalkOlog SMS program',
  documentTitle: 'SMS program · TalkOlog',
  effective: EFFECTIVE,
  version: 2,
  intro: [
    `TalkOlog is a service of ${COMPANY}. This page describes the text messages TalkOlog sends to field staff in the United States, by SMS or WhatsApp, how people agree to receive them and how to stop them.`,
  ],
  sections: [
    {
      id: 'what',
      heading: 'What TalkOlog is',
      blocks: [
        p(
          'TalkOlog turns a site manager’s short spoken report into the official daily report of a construction site. Construction companies (our customers, the employers) use it for their sites. Each workday, TalkOlog texts the people who report for a site a personal link to a mobile web recorder; they tap the link and talk for about three minutes, and TalkOlog drafts the daily report for them to check and file.',
        ),
      ],
    },
    {
      id: 'who',
      heading: 'Who receives texts',
      blocks: [
        p(
          'Field staff of TalkOlog’s customers: site managers, superintendents and foremen whose employer has set them up to report for a site. TalkOlog does not text the public, and nobody can sign up for these texts on their own.',
        ),
      ],
    },
    {
      id: 'opt-in',
      heading: 'How people opt in',
      blocks: [
        p(
          'Opt-in is verbal, given to the employer. Before adding a worker, the employer’s office manager asks the worker, in person or by phone, using this script:',
        ),
        { type: 'quote', label: 'Verbal opt-in script', text: VERBAL_SCRIPT },
        p(
          'Only if the worker says yes does the office manager enter the worker’s mobile number in the TalkOlog panel and tick the required box:',
        ),
        { type: 'quote', label: 'Required box in the TalkOlog panel', text: OPT_IN_CHECKBOX },
        p(
          'The number cannot be added without that box. TalkOlog records the agreement with the office manager’s name and the time it was given.',
        ),
        p(
          'The first message identifies TalkOlog and the employer and says how to opt out and get help:',
        ),
        { type: 'quote', label: 'Sample first message', text: SAMPLE_WELCOME },
        p(
          'When the worker opens the link, the TalkOlog app asks for consent again before anything is recorded.',
        ),
      ],
    },
    {
      id: 'messages',
      heading: 'Messages you may receive',
      blocks: [
        ul(...MESSAGE_TYPES),
        p(CHANNELS),
        p(
          'The same program also sends the replies to your HELP, STOP, START, CALL or TEXT messages and short service notes about your report, such as a confirmation when a change to a filed report is saved. All texts are about your daily site report.',
        ),
        {
          type: 'quote',
          label: 'Sample daily link',
          text: sampleText(smsEn.daily_link.withoutNumber),
        },
        { type: 'quote', label: 'Sample reminder', text: sampleText(smsEn.reminder_1) },
        { type: 'quote', label: 'Sample filed confirmation', text: sampleText(smsEn.filed) },
      ],
    },
    {
      id: 'frequency',
      heading: 'Frequency and cost',
      blocks: [p(FREQUENCY), p(RATES)],
    },
    {
      id: 'help-stop',
      heading: 'HELP and STOP',
      blocks: [
        ul(
          'Reply STOP to opt out. You will get one confirmation and no further texts.',
          'Reply START to resume.',
          'Reply HELP for help.',
          'On WhatsApp, STOP works the same way: reply STOP to the TalkOlog chat and TalkOlog sends you no further WhatsApp messages.',
        ),
        { type: 'quote', label: 'Reply to STOP', text: sampleText(smsEn.stop_confirm) },
        { type: 'quote', label: 'Reply to HELP', text: sampleText(smsEn.help.withoutNumber) },
        p('You can also ask your office, or write to ', email, '.'),
        p(CARRIERS),
      ],
    },
    {
      id: 'privacy',
      heading: 'No marketing, no sharing',
      blocks: [
        p('TalkOlog never uses these texts for marketing.'),
        p(NO_SHARING_MARKETING, ' ', NO_SHARING_OPT_IN),
        p('Read our ', terms, ' and our ', privacy, '.'),
      ],
    },
    {
      id: 'contact',
      heading: 'Contact',
      blocks: [p(`${COMPANY}, Wyoming, USA. Email `, email, '.')],
    },
  ],
};

const termsDoc: LegalDoc = {
  key: 'terms',
  path: '/terms',
  title: 'Terms of Service',
  documentTitle: 'Terms of Service · TalkOlog',
  effective: EFFECTIVE,
  version: 2,
  intro: [
    `These terms govern the use of TalkOlog, a service operated by ${COMPANY}, a Wyoming (USA) limited liability company (“we”, “us”). By creating an account, using the TalkOlog panel or the field app, or receiving TalkOlog messages, you agree to them.`,
  ],
  sections: [
    {
      id: 'service',
      heading: '1. The service',
      blocks: [
        p(
          'TalkOlog produces daily construction site reports from voice. Field staff record a short spoken report through a personal link to a mobile web recorder, or speak with TalkOlog’s voice assistant; TalkOlog drafts the daily report, crew hours and weather-delay records, which the reporter confirms and the customer’s office reviews in the TalkOlog panel.',
        ),
      ],
    },
    {
      id: 'accounts',
      heading: '2. Accounts',
      blocks: [
        ul(
          'The customer is the employer organisation that signs up for TalkOlog. It is responsible for its account and everything done under it.',
          'Office users are people the customer invites to the panel. They sign in with their work email and must keep access to it secure.',
          'Field users (site managers, foremen and other reporters) do not have accounts. The customer adds them, and they receive a personal link that works on the phone they verify. Personal links must not be shared.',
        ),
      ],
    },
    {
      id: 'customer',
      heading: '3. Customer responsibilities',
      blocks: [
        ul(
          'Use TalkOlog only lawfully and for the daily reporting of your own work.',
          'Before adding a worker’s mobile number, obtain the worker’s agreement to receive TalkOlog texts, as described in our SMS program, and add only numbers of people who agreed.',
          'Tell your workers how their reports, recordings and data are used, as your own obligations as their employer require.',
          'Keep the data you enter (sites, people, companies, numbers) accurate and up to date, and review reports before you rely on them.',
        ),
      ],
    },
    {
      id: 'sms',
      heading: '4. SMS messaging terms',
      blocks: [
        p(
          'TalkOlog texts field users, by SMS or WhatsApp, on behalf of their employer about their daily site report. The messages are:',
        ),
        ul(...MESSAGE_TYPES),
        p(FREQUENCY, ' ', RATES),
        p(
          'Reply STOP to opt out, START to resume and HELP for help. ',
          CARRIERS,
          ' Texts are never used for marketing. ',
          NO_SHARING_MARKETING,
        ),
        p('Full details: our ', smsPage, '.'),
      ],
    },
    {
      id: 'acceptable-use',
      heading: '5. Acceptable use',
      blocks: [
        p('You must not:'),
        ul(
          'send unlawful, harassing or misleading content through TalkOlog, or use it to message people who have not agreed;',
          'try to access data of another organisation, probe or disrupt the service, or get around its limits or security;',
          'reverse engineer the service except where the law allows it;',
          'resell the service or use it to build a competing product.',
        ),
        p('We may suspend access that breaks these rules or puts the service or others at risk.'),
      ],
    },
    {
      id: 'ai',
      heading: '6. AI-generated content',
      blocks: [
        p(
          'TalkOlog uses AI to transcribe recordings and to draft reports from what the reporter said. A report is filed only after the reporter confirms it, and totals are calculated by our software, not by the AI. Drafts can still contain mistakes: the customer reviews filed reports and remains responsible for the reports it relies on or sends to others. Office edits create a new version; earlier versions are kept.',
        ),
      ],
    },
    {
      id: 'fees',
      heading: '7. Fees and trials',
      blocks: [
        p(
          'Prices, trial periods and billing terms are shown in the Billing page of the panel and apply as shown there. Unpaid accounts may be paused after notice. Fees are exclusive of taxes unless stated.',
        ),
      ],
    },
    {
      id: 'data',
      heading: '8. Data and privacy',
      blocks: [
        p(
          'The customer owns the data it and its field users put into TalkOlog. We process it to provide the service, as described in our ',
          privacy,
          '. As between us, the customer decides why the data of its workers is collected, and we process it on its behalf.',
        ),
      ],
    },
    {
      id: 'ip',
      heading: '9. Intellectual property',
      blocks: [
        p(
          'TalkOlog, its software, design and brand belong to Yalp LLC. We grant the customer a non-exclusive, non-transferable right to use the service during the subscription. Feedback you give us may be used to improve the service without obligation.',
        ),
      ],
    },
    {
      id: 'disclaimers',
      heading: '10. Disclaimers',
      blocks: [
        p(
          'The service is provided “as is” and “as available”. To the extent the law allows, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose and non-infringement. We do not guarantee that messages, calls or the service will be uninterrupted, delivered on time or free of errors.',
        ),
      ],
    },
    {
      id: 'liability',
      heading: '11. Limitation of liability',
      blocks: [
        p(
          'To the extent the law allows, Yalp LLC is not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue or data. Our total liability for any claim relating to the service is limited to the fees the customer paid us for the service in the twelve months before the claim.',
        ),
      ],
    },
    {
      id: 'termination',
      heading: '12. Termination',
      blocks: [
        p(
          'The customer may stop using TalkOlog and cancel at any time from the panel or by email. We may suspend or end the service for a breach of these terms, for non-payment, or if the law requires it. On termination the customer may ask for an export of its reports; afterwards we delete its data as described in our ',
          privacy,
          '.',
        ),
      ],
    },
    {
      id: 'changes',
      heading: '13. Changes to these terms',
      blocks: [
        p(
          'We may update these terms. The new version and its effective date are published on this page, and customers are told of material changes in advance by email or in the panel. Continuing to use TalkOlog after a change takes effect means accepting it.',
        ),
      ],
    },
    {
      id: 'law',
      heading: '14. Governing law',
      blocks: [
        p(
          'These terms are governed by the laws of the State of Wyoming, USA, without regard to its conflict-of-laws rules. The courts located in Wyoming have exclusive jurisdiction, unless the law gives you the right to sue elsewhere.',
        ),
      ],
    },
    {
      id: 'contact',
      heading: '15. Contact',
      blocks: [p(`${COMPANY}, Wyoming, USA. Email `, email, '.')],
    },
  ],
};

const privacyDoc: LegalDoc = {
  key: 'privacy',
  path: '/privacy',
  title: 'Privacy Policy',
  documentTitle: 'Privacy Policy · TalkOlog',
  effective: EFFECTIVE,
  version: 2,
  intro: [
    `This policy explains how ${COMPANY}, a Wyoming (USA) limited liability company, handles personal information in TalkOlog. TalkOlog is used by employers (our customers) for the daily reports of their construction sites. For the data of field workers, the employer decides why it is collected and we process it on the employer’s behalf.`,
  ],
  sections: [
    {
      id: 'collected',
      heading: 'Information we collect',
      blocks: [
        p('From office users of the panel:'),
        ul(
          'name, work email, role and language;',
          'the organisation’s details: company name, sites, subcontractors, report settings and billing contact.',
        ),
        p('From field workers, through their employer and the field app:'),
        ul(
          'name and mobile number, entered by the employer;',
          'voice recordings and their transcripts;',
          'photos added to a report;',
          'the content of daily reports: crew, hours, work done, deliveries, weather delays and the answers to questions;',
          'consents given, preferences (a link by text or a call) and messages sent and received;',
          'link and device data: when a personal link is opened, a cookie that keeps the verified phone signed in for up to 180 days, and the times of requests.',
        ),
        p(
          'Calls with the TalkOlog voice assistant are recorded. Every call starts with a recording notice, played before anything said is processed; a worker who declines the consent asked on a first call is not recorded and nothing of that call is sent to our providers.',
        ),
      ],
    },
    {
      id: 'use',
      heading: 'How we use it',
      blocks: [
        ul(
          'to send the daily report link, reminders, questions and confirmations;',
          'to transcribe recordings and draft the daily report, crew hours and weather-delay records;',
          'to make the report PDF and send it to the office;',
          'to show the office its sites, reports and team, and to keep an audit log of changes, consents and messages;',
          'to run, secure, support and bill the service.',
        ),
        p('We do not sell personal information and do not use it for advertising.'),
      ],
    },
    {
      id: 'ai',
      heading: 'AI processing',
      blocks: [
        p(
          'Transcripts are drafted into reports by an AI model (Anthropic’s Claude). Phone numbers are removed before any text is sent to the model, and the model never decides to file a report: the reporter confirms it.',
        ),
      ],
    },
    {
      id: 'processors',
      heading: 'Service providers',
      blocks: [
        p('We share information only with providers that process it for us to run TalkOlog:'),
        ul(
          'Supabase: database, file storage, sign-in and server functions;',
          'Netlify: hosting of the TalkOlog websites;',
          'Fly.io: background processing (transcription, report drafting, PDFs, messages);',
          'Twilio: text messages and WhatsApp messages (WhatsApp messages also pass through Meta);',
          'LiveKit: voice calls with the assistant;',
          'Deepgram: speech-to-text and the assistant’s English and Spanish voice;',
          'Microsoft Azure AI Speech: the assistant’s Turkish voice;',
          'OpenAI: backup speech-to-text when the main transcription is unavailable;',
          'Anthropic: Claude, for drafting reports and understanding answers;',
          'Resend: email of reports and notices to the office;',
          'Stripe: billing (payment details go to Stripe, not to us);',
          'Open-Meteo: weather for each site’s location;',
          'Sentry: error reports;',
          'Google Fonts: the panel’s typefaces, loaded by the browser.',
        ),
        p(
          'We may also disclose information when the law requires it, or to a successor in a merger or sale, under this policy.',
        ),
      ],
    },
    {
      id: 'sms',
      heading: 'Text messages',
      blocks: [
        p(
          'Field workers receive TalkOlog texts (SMS or WhatsApp) only after agreeing to them with their employer (see our ',
          smsPage,
          '). Reply STOP to opt out and HELP for help.',
        ),
        p(NO_SHARING_MARKETING, ' ', NO_SHARING_OPT_IN),
      ],
    },
    {
      id: 'retention',
      heading: 'Retention',
      blocks: [
        ul(
          'Voice recordings, call recordings, photos and transcripts are deleted after the customer’s retention period, by default 730 days (two years).',
          'Recordings of callers whose number is not set up with TalkOlog are deleted after 30 days unless the office links the number.',
          'Daily reports, their versions and PDFs are kept as the customer’s records for as long as the customer’s account requires, then deleted.',
          'Account, consent and audit records are kept for the life of the account and as the law requires.',
        ),
      ],
    },
    {
      id: 'rights',
      heading: 'Your rights',
      blocks: [
        p(
          'You can ask to access, correct or delete your information. Field workers should ask their employer, which controls their data; we help the employer answer. You can also write to ',
          email,
          ' and we will pass the request on or answer it ourselves. Field workers can turn texts and recording consent off in the field app’s Settings at any time.',
        ),
      ],
    },
    {
      id: 'security',
      heading: 'Security',
      blocks: [
        p(
          'Data is encrypted in transit; each organisation sees only its own data; field workers reach only their own reports, through their personal link on a verified phone; files are shared through short-lived signed links; and changes are recorded in an audit log. No system is perfectly secure, and we will tell customers of a breach that affects their data as the law requires.',
        ),
      ],
    },
    {
      id: 'children',
      heading: 'Children',
      blocks: [
        p(
          'TalkOlog is a workplace service for adults. It is not directed at children under 16, and we do not knowingly collect their information.',
        ),
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to this policy',
      blocks: [
        p(
          'We will publish any new version on this page with its effective date and tell customers of material changes in advance.',
        ),
      ],
    },
    {
      id: 'contact',
      heading: 'Contact',
      blocks: [p(`${COMPANY}, Wyoming, USA. Email `, email, '. See also our ', terms, '.')],
    },
  ],
};

export const LEGAL_DOCS: Record<LegalKey, LegalDoc> = {
  sms,
  terms: termsDoc,
  privacy: privacyDoc,
};

/** The footer's order. */
export const LEGAL_ORDER: LegalKey[] = ['sms', 'terms', 'privacy'];
