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
    /** §9.3 routes: the browser tab's titles. */
    routes: {
      link: 'Opening your link…',
      today: 'Today',
      record: 'Record',
      report: 'Report',
      history: 'Past reports',
      settings: 'Settings',
      expired: 'Link expired',
    },
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
      pastReports: 'Past reports',
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
        photos_window_closed:
          'This report takes no more photos: the time to add them ended at 23:59 the day after.',
        photo_limit: 'This report already has the most photos that can be added after filing.',
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
      failed: 'Couldn’t check on your report. Check your signal and try again.',
      /** field-api no longer finds the report for this phone. */
      notFound: 'This report isn’t available here any more.',
    },
    /** The open question (F7, Field-05; W1-13): one per screen. */
    question: {
      progress: 'Writing your report',
      badge: 'Quick check',
      /** The crew's voice-note second the question is about (m:ss). */
      heardAt: 'Heard at {{time}} in your note',
      close: 'You can close this — I’ll text you when the draft is ready.',
      sending: 'Sending your answer…',
      /** D28: a question with no answers to tap; the reporter types the number. */
      workers: 'Workers',
      hoursEach: 'Hours each',
      hoursLost: 'Hours lost',
      hoursLegend: 'For how long?',
      fullDay: 'Full day',
      setHours: 'Other hours',
      send: 'Send answer',
      invalidNumber: 'Enter a number.',
      /** A question with no answers to tap and no number to type (not asked by the worker today). */
      cannotAnswer: 'This one can’t be answered here yet. The office will check it.',
      errors: {
        question_closed: 'That question was already answered. Here is the latest.',
        wrong_state: 'Your report changed. Here is the latest.',
        answer_not_accepted: 'That answer didn’t work. Try again.',
        offline: 'No connection. Check your signal and try again.',
        generic: 'Couldn’t send your answer. Try again.',
      },
    },
    /** F7's confirmation line after an answer (numbers from code, never the model). */
    confirmation: {
      crew: '{{company}}: {{workers}} workers, {{hours}} hours each — {{total}} hours.',
      crewOne: '{{company}}: 1 worker, {{hours}} hours.',
      workers: '{{company}}: {{workers}} workers.',
      workersOne: '{{company}}: 1 worker.',
      hours: '{{company}}: {{hours}} hours each.',
      companyAdded: '{{company}} added for the office to confirm.',
      companyMapped: 'Logged as {{company}}.',
      weather: 'Weather: {{hours}} hours lost.',
      weatherNone: 'Weather: no time lost.',
      noted: 'Got it.',
    },
    /** The draft (F8, Field-06; W1-13): numbers read-only until M6 (Fix by voice, steppers). */
    draft: {
      eyebrow: 'Draft · {{date}}',
      title: 'Check today’s report',
      crew: 'Crew',
      answered: 'Answered',
      /** The crew line's numbers, read out (the screen shows "5 × 8 h"). */
      crewValue: '{{workers}} workers, {{hours}} hours each',
      crewValueOne: '1 worker, {{hours}} hours',
      notStated: 'Not stated',
      noCrew: 'No crew stated',
      weather: 'Weather',
      done: 'Done',
      delivered: 'Delivered',
      safety: 'Safety',
      next: 'Next workday',
      photos: 'Photos',
      photosCount: '{{count}} attached',
      none: 'None',
      fullDayLost: 'full day lost',
      status: {
        complete: 'complete',
        in_progress: 'in progress',
        started: 'started',
        stopped: 'stopped',
        planned: 'planned',
      },
      percent: '~{{percent}}%',
      toolboxTalk: 'Toolbox talk',
      noIncidents: 'no incidents',
      incidents: '{{count}} incident(s)',
      confirm: 'Confirm & send',
      confirming: 'Sending…',
      errors: {
        draft_changed: 'Your report changed. Check it again, then send.',
        wrong_state: 'Your report changed. Here is the latest.',
        offline: 'No connection. Check your signal and try again.',
        generic: 'Couldn’t send your report. Try again.',
      },
    },
    /** After Confirm & send, until the worker has filed it (the Filed screen is W1-15). */
    filing: {
      title: 'Filing your report…',
      body: 'You’ll get a text with the PDF in a minute.',
    },
    /** The Filed screen (F8, Field-07; W1-15). */
    filed: {
      title: 'Filed.',
      /** `{{no}}` is set in bold mono; `{{name}}` is the reporter's first name. */
      body: 'Daily Report {{no}} is with the office. Thanks, {{name}} — that’s it for today.',
      pdf: 'Open the PDF',
      pdfBadge: 'PDF',
      /** render_pdf has not stored the file yet: the screen checks again. */
      pdfPreparing: 'Preparing the PDF…',
      /** The PDF is still not there after `PDF_WAIT_MS`: the screen stops checking. */
      pdfLate: 'The PDF is on its way. The office already has your report.',
      /** Read by screen readers after "Open the PDF". */
      opensNewTab: '(opens in a new tab)',
      /** F9 (W2-04): spec §9.3 says *Add more photos*; the artboard's button says "Add photos". */
      addPhotos: 'Add more photos',
      pastReports: 'Past reports',
      /**
       * The edit hint; `{{pastReports}}` is set in bold. The artboard goes on "and say what to fix.
       * The office gets a new version; the old one is kept.", which W2-11 (F10) makes true.
       */
      hint: 'Need a change later? Open {{pastReports}}.',
      /** The sheet after the photos are picked (F9: up to 4, an optional voice caption). */
      photos: {
        title: 'Add photos to {{no}}',
        chosen: 'Photos chosen: {{count}}',
        photo: 'Photo {{n}}',
        /** `{{until}}` is the window's end in the site's time zone ("Sat 23:59"). */
        window: 'Photos you can still add: {{count}}, until {{until}}.',
        tooMany: 'Only {{count}} more can be added, so the first {{count}} are kept.',
        caption: 'Voice caption (optional)',
        captionHint: 'Say what the photos show. The office reads it under each photo.',
        record: 'Record a caption',
        stop: 'Stop',
        recording: 'Recording',
        captionReady: 'Caption recorded',
        removeCaption: 'Remove caption',
        noMic: 'The microphone isn’t available. The photos go without a caption.',
        send: 'Send photos',
        cancel: 'Cancel',
        /** After *Send photos*, until the new version exists. */
        adding: 'Adding your photos…',
        /** The caption is being transcribed (the worker makes the version after it). */
        captioning: 'Adding your photos and caption…',
        /** Still no new version after the wait: the screen stops checking. */
        late: 'Your photos are on their way. The office will get them with your caption.',
        added: 'Photos added. Version {{version}} is with the office.',
        failed: 'Couldn’t add the photos.',
      },
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
    /**
     * Past reports (F10, F14, §9.3; W2-03). No artboard: built from §9.3 and the Draft (Field-06)
     * and Filed (Field-07) screens. _Change something_ is W2-11.
     */
    history: {
      intro: 'Your reports from the last 14 days.',
      empty: 'No reports in the last 14 days.',
      status: {
        collecting: 'In progress',
        processing: 'In progress',
        awaiting_answer: 'Needs your answer',
        awaiting_confirmation: 'Ready to check',
        filed: 'Filed',
        signed_off: 'Signed off',
        void: 'Cancelled',
      },
      late: 'Late',
      eyebrow: 'Report · {{date}}',
      version: 'Version {{version}}',
      continue: 'Continue this report',
      noData: 'Nothing to show yet: SiteLog is still writing this report.',
      back: 'Back to Past reports',
      failed: 'Couldn’t load your past reports. Check your signal and try again.',
      reportFailed: 'Couldn’t load this report. Check your signal and try again.',
    },
    /** An expired daily link (F16, §9.3 Expired; W2-03). No artboard: built from §9.3. */
    expired: {
      title: 'This link has expired',
      body: 'We can text today’s link to the phone number the office has for you.',
      noCode: 'Open the link in your latest text message, or ask the office for today’s link.',
      send: 'Send me today’s link',
      sending: 'Sending…',
      sent: 'Sent. Open today’s link in the message we just sent you.',
      reasons: {
        site_paused: 'This site is paused in SiteLog. Ask the office to resume it.',
        site_inactive: 'This site is no longer on your list in SiteLog. Ask the office.',
        not_working_day: 'Today is not a working day for this site, so there is no link for today.',
        no_consent: 'You turned off texts, so we can’t text you the link. Ask the office for it.',
        opted_out: 'You asked us to stop texting you, so we can’t send the link. Ask the office.',
        no_channel: 'We couldn’t text your number. Ask the office to check it.',
      },
      errors: {
        rate_limited: 'You asked a few times already. Try again in {{minutes}} min.',
        offline: 'No connection. Check your signal and try again.',
        generic: 'Couldn’t send the link. Try again.',
      },
    },
    /**
     * Settings (F15, §9.3; W2-02). No artboard: built from §9.3 and the Field-02 / Field-03
     * patterns. The report mode reuses `welcome.pref*`, the language `common.language`.
     */
    settings: {
      channelTitle: 'Where should we send your messages?',
      channelDefault: 'Best available',
      channelDefaultHint: 'SiteLog picks, in your company’s order',
      channels: {
        sms: 'Text message (SMS)',
        whatsapp: 'WhatsApp',
        push: 'Notifications on this phone',
      },
      consentsTitle: 'What you agreed to',
      consents: {
        recording: 'Recording of my voice notes, photos and calls',
        data_processing: 'Processing of my reports for {{company}}',
        sms: 'Texts with my daily report link',
        auto_call: 'Automated calls at report time',
      },
      on: 'On',
      off: 'Off',
      turnOff: 'Turn off',
      /** The button's accessible name: the visible "Turn off" first (WCAG 2.5.3). */
      turnOffLabel: 'Turn off: {{consent}}',
      /** Behind *Turn off* for recording or processing (F15: reports stop, the office is told). */
      stopSheet: {
        title: 'Stop reporting?',
        body: 'With this off, SiteLog can’t take your voice notes or photos, so your reports stop. The office is told. To report again, you agree again on this phone.',
        confirm: 'Turn off',
        cancel: 'Keep it on',
      },
      signOut: 'Sign out this phone',
      signOutSheet: {
        title: 'Sign out this phone?',
        body: 'To report from this phone again, open your link and enter a new code we text you.',
        confirm: 'Sign out',
        cancel: 'Cancel',
      },
      saving: 'Saving…',
      saved: 'Saved',
      back: 'Back to Today',
      failed: 'Couldn’t load your settings. Check your signal and try again.',
      saveFailed: 'Couldn’t save. Check your signal and try again.',
    },
  },
} as const;
