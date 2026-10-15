/**
 * UI copy, English (D9 skeleton). i18next resources by namespace: `common` (both apps) and `field`
 * (field app, EN/ES/TR). Interpolation uses i18next's `{{name}}`. This is the source of the key
 * structure for those two namespaces: `tr.ts` and `es.ts` must have the same keys.
 *
 * The field keys are the W1-04 placeholders and the W1-09 screens (device check, welcome and
 * consent, Today, Recording, sending and Processing, the offline banner), copied from the Field-02,
 * -03, -04 and -10 artboards where they show the text. The panel has no English here: its English
 * is `apps/web/src/copy/en.ts`, which the panel serves as the `panel` EN resource, so new panel
 * strings go there (CLAUDE.md) and only their Turkish lives in `tr.ts`.
 */
export const uiEn = {
  common: {
    appName: 'SiteLog',
    language: 'Language',
    /** Endonyms: each language is named in itself, whatever the UI language. */
    languageNames: { en: 'English', es: 'Español', tr: 'Türkçe' },
    loading: 'Loading…',
    retry: 'Try again',
    close: 'Close',
    errorTitle: 'Something went wrong',
  },
  field: {
    /** §9.3 routes, as placeholder titles. */
    routes: {
      link: 'Opening your link…',
      today: 'Today',
      record: 'Record',
      report: 'Report',
      history: 'Past reports',
      settings: 'Settings',
      expired: 'Link expired',
    },
    placeholderBody: 'This screen is coming next.',
    /** Any other path (the field host serves the app for every path). */
    notFound: {
      title: 'Page not found',
      body: 'That page doesn’t exist, or the link was mistyped.',
      /** The screen's one action: the installed app has no URL bar or back button. */
      action: 'Go to Today',
    },
    /** `/r/:code` (F4 step 1) and what field-api can answer instead of a link. */
    link: {
      notFound: {
        title: 'Link not found',
        body: 'This link doesn’t work. Ask the office to send you a new one.',
      },
      expired: {
        title: 'Link expired',
        body: 'This link has expired. Ask the office to send you today’s link.',
      },
      revoked: {
        title: 'Link no longer valid',
        body: 'This link was turned off. Ask the office to send you a new one.',
      },
      disabled: {
        title: 'Account paused',
        body: 'Your reporting is paused. Ask the office if you think that’s wrong.',
      },
      /** The installed app opened with no link stored on this phone. */
      none: {
        title: 'Open your link',
        body: 'Open SiteLog from the link in your text message.',
      },
      /** Anything else (a bad connection, a server error). */
      failed: 'Couldn’t open your link. Check your signal and try again.',
    },
    /** Device check (F4 step 2): new phones only. */
    device: {
      title: 'Is this {{name}}’s phone?',
      body: 'We text a 6-digit code to the number the office gave us, so only you can report from here.',
      send: 'Yes, text me a code',
      sending: 'Sending the code…',
      sent: 'Code sent. It expires in 10 minutes.',
      codeLabel: '6-digit code',
      verify: 'Continue',
      verifying: 'Checking…',
      resend: 'Send a new code',
      /** The send limit (5 an hour per phone): shown instead of the resend link. */
      resendIn: 'You can ask for another code in {{minutes}} min',
      errors: {
        code_invalid: 'That code isn’t right. Tries left: {{attemptsLeft}}.',
        code_expired: 'That code has expired. Ask for a new one.',
        no_code: 'Ask for a code first.',
        code_undeliverable: 'We couldn’t text this number. Ask the office to check it.',
        rate_limited: 'Too many tries. Try again in {{minutes}} min.',
        offline: 'No connection. Check your signal and try again.',
        generic: 'Something went wrong. Try again.',
      },
    },
    /** Welcome & consent (F4 step 3, Field-02): first open only. */
    welcome: {
      title: 'Hi {{name}} — one minute before your first report',
      notice:
        'Your voice notes, photos and calls are recorded to write the daily report for {{company}}. The office sees them; recordings are kept for 2 years.',
      privacy: 'Privacy notice',
      consentRequired: 'I agree to the recording and processing of my reports',
      consentSms: 'Text me the daily report link',
      consentCall: 'Call me at report time (automated)',
      prefLegend: 'How do you want to report?',
      prefLink: 'Text link',
      prefLinkHint: 'Tap the link, talk, done. Add photos.',
      prefCall: 'Phone call',
      prefCallHint: 'SiteLog calls you and listens.',
      prefNote: 'You can always use the other one.',
      continue: 'Continue',
      saving: 'Saving…',
      requiredHint: 'Tick the first box to continue.',
      failed: 'Couldn’t save. Check your signal and try again.',
    },
    /** Today (F5 step 1, Field-03, Field-10). */
    today: {
      due: 'DUE {{time}}',
      changeSite: 'Change site',
      siteSheetTitle: 'Which site?',
      status: {
        notSent: 'Not sent yet',
        inProgress: 'In progress',
        sent: 'Sent',
        weatherDay: 'Weather day',
        noWork: 'No work today',
      },
      promptsTitle: 'Say it in any order',
      prompts: {
        work: 'Work done & where',
        crew: 'Crew by company',
        hours: 'Hours',
        weather: 'Weather & lost time',
        deliveries: 'Deliveries',
        safety: 'Safety',
      },
      record: 'Record today’s report',
      tapToRecord: 'Tap to record',
      usually: 'Usually 2–3 minutes',
      addPhotos: 'Add photos',
      noWork: 'No work today',
      weather: 'Site closed: weather',
      talkNow: 'Prefer to talk? Talk now',
      talkNowHint: 'The assistant listens in the browser, no number needed',
      call: 'or call {{number}}',
      /** F5: before 12:00 site time a personal link may report the previous working day. */
      dateQuestion: 'Is this for today or yesterday?',
      dateToday: 'Today',
      dateYesterday: 'Yesterday, {{date}}',
      /** The day is filed or closed: nothing more can be added here (edits are F10). */
      closed: 'This day’s report is in. Nothing more can be added from here.',
      /** The No work / Weather confirm sheet (F12; what it writes is spec §19 Q41). */
      daySheet: {
        noWorkTitle: 'No work today?',
        noWorkBody: 'The office will see “No work today” for {{site}}.',
        weatherTitle: 'Site closed for weather?',
        weatherBody: 'The office will see “Weather day” for {{site}}.',
        since: 'Since when?',
        never: 'Never started',
        workersBefore: 'How many were on site before?',
        confirm: 'Confirm',
        cancel: 'Cancel',
        saving: 'Saving…',
        errors: {
          report_in_progress: 'A report is already on its way for today. Finish it first.',
          report_filed: 'Today’s report is already sent.',
          wrong_state: 'Today can’t be changed any more.',
          date_not_allowed: 'That day can’t be changed any more.',
          generic: 'Couldn’t save. Check your signal and try again.',
        },
      },
      photosAdded: 'Sending {{count}} photo(s)…',
      /** A report already started for the day (Field-05/06/07 are W1-13). */
      openReport: 'Open report {{no}}',
      failed: 'Couldn’t load today. Check your signal and try again.',
    },
    /** Recording (F5 step 2, Field-04). */
    recording: {
      title: 'Recording',
      paused: 'Paused',
      starting: 'Starting…',
      keepTalking: 'Keep talking — the screen stays on',
      pausedHint: 'Paused — tap play to go on',
      timerLabel: 'Recording time',
      pause: 'Pause recording',
      resume: 'Resume recording',
      stopSend: 'Stop & send',
      addPhoto: 'Add photo',
      photos: 'Photos',
      photo: 'Photo {{n}}',
      removePhoto: 'Remove photo {{n}}',
      /** 15 minutes per clip (§9.3): the clip is sent; more clips are allowed. */
      maxReached: '15 minutes — sending this clip. Record another one if you need to.',
      tooShort: 'I couldn’t hear anything — try again',
      /** Microphone refused or no MediaRecorder (F5 edge cases). */
      permission: {
        title: 'Microphone needed',
        body: 'Allow the microphone so SiteLog can hear your report.',
        ios: 'iPhone: Settings → Safari → Microphone → Allow',
        android: 'Android: tap the lock icon by the address bar → Permissions → Microphone',
        fallback: 'Or record with your phone’s voice recorder and send the file:',
        pick: 'Choose a recording',
        orCall: 'Or call {{number}}',
      },
      /** No MediaRecorder: the microphone is not the problem, the file fallback is the way. */
      unsupported: {
        title: 'This browser can’t record here',
        body: 'Record with your phone’s voice recorder and send the file.',
      },
      failed: 'Recording stopped unexpectedly. Try again.',
      /** The browser stopped the recording (a call, another app, a headset gone): what was said goes. */
      interrupted: 'The microphone stopped — a call or another app may have taken it.',
    },
    /** After Stop & send, until the report exists (F5 step 3). */
    sending: {
      title: 'Sending…',
      body: 'Sending your recording to the office.',
      queued: 'Saved on your phone — will send when you have signal',
      queuedBody: 'Keep the app open or come back later; it sends by itself.',
      failed: 'Couldn’t send this recording.',
      retry: 'Try again',
      /** A refusal nothing can change: the reporter's tap is the only way a clip leaves the phone. */
      remove: 'Remove this recording',
      backToToday: 'Back to Today',
      /** Why field-api refused a clip or photo (the Recording screen and the offline banner's list). */
      errors: {
        report_filed: 'Today’s report was already sent, so this can’t be added to it.',
        day_closed: 'This day is closed for the site, so this can’t be sent.',
        date_not_allowed: 'That day can’t take a report any more.',
        upload_too_large: 'The file is too large (50 MB at most).',
        media_type_not_allowed: 'That file type can’t be sent.',
        device_unverified: 'Open your link again to check this phone, then it sends.',
        consent_required: 'Open your link again to finish setting up, then it sends.',
        link_expired:
          'This link has expired. Open the link in your latest text message, then it sends.',
        link_revoked:
          'This link was turned off. Open the link in your latest text message, then it sends.',
        link_not_found:
          'This link doesn’t work. Open the link in your latest text message, then it sends.',
        reporter_disabled: 'Your reporting is paused. Ask the office, then try again.',
        site_inactive: 'This site is paused. Ask the office, then try again.',
        file_missing: 'The file is no longer on this phone.',
        generic: 'Couldn’t send this. Ask the office for help.',
      },
    },
    /** Processing (F5 step 4): the report screen while the worker writes the draft. */
    processing: {
      title: 'Writing your report…',
      report: 'Report {{no}}',
      close: 'You can close this — I’ll message you',
      counts: '{{voiceNotes}} voice note(s) · {{photos}} photo(s)',
      /** The step ticks. */
      ticks: {
        transcribed: 'Transcribed',
        crew: 'Crew found',
        weather: 'Weather logged',
        hours: 'Checking hours',
      },
      /** Read after a done tick by screen readers (the tick itself is an icon). */
      tickDone: 'done',
      /** The progress lines (`progressSteps`, §F5 step 3): the worker's message and the simulator. */
      steps: {
        transcribed: 'Transcribed, site noise removed',
        crewOne: '{{n}} on site, 1 subcontractor',
        crewMany: '{{n}} on site, {{k}} subcontractors',
        weather: '{{condition}} {{start}}–{{end}} logged as delay',
        hours: 'Checking subcontractor hours…',
      },
      /** The worker has a question or a draft (their screens are W1-13's). */
      readyTitle: 'Your report is ready to check',
      filedTitle: 'Report filed',
      failed: 'Couldn’t check on your report. Check your signal and try again.',
      /** field-api no longer finds the report for this phone. */
      notFound: 'This report isn’t available here any more.',
    },
    /** The offline banner and the upload queue (F5 step 3). */
    offline: {
      banner: 'No signal — recordings are saved on your phone',
      queued: 'Waiting to send: {{count}}',
      /** Refused by field-api and kept on the phone until the reporter retries or removes it. */
      failed: 'Not sent: {{count}}',
      review: 'Review',
      sheetTitle: 'Not sent',
      voiceNote: 'Voice note · {{date}}',
      photo: 'Photo · {{date}}',
      remove: 'Remove',
      /** The phone's storage refused the item: it lives in this page only. */
      unsaved: 'Not saved on this phone: keep SiteLog open until it is sent.',
    },
  },
} as const;
