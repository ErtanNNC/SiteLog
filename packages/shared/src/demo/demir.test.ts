import { describe, expect, it } from 'vitest';
import { buildDemirDemo, DEMIR_GLOSSARY, DEMIR_ORG_ID, DEMIR_USERS } from './demir.ts';
import { smsRenderOptions } from '../channels.ts';
import { renderSms } from '../copy/sms.ts';
import { formatDateInTz, isE164 } from '../format.ts';
import { buildKestrelDemo, DEMO_USERS } from './kestrel.ts';
import { demoPack } from './countries.ts';
import { demoId } from './ids.ts';
import { linkCodeHash } from '../links.ts';
import { STARTER_GLOSSARY_TR } from '../glossary/starter.tr.ts';

const demir = buildDemirDemo();

describe('Demir Yapı A.Ş. (§18.2)', () => {
  it('is a Turkish demo org: Europe/Istanbul, 17:30, tr-TR, metric, TRY', () => {
    expect(demir.org).toMatchObject({
      id: DEMIR_ORG_ID,
      name: 'Demir Yapı A.Ş.',
      timezone: 'Europe/Istanbul',
      locale: 'tr-TR',
      country: 'TR',
      units: 'metric',
      currency: 'TRY',
      is_demo: true,
    });
    expect(demir.settings).toMatchObject({ default_deadline: '17:30:00', pdf_paper: 'a4' });
  });

  it('has the two sites with codes and their reporters, both TR', () => {
    expect(demir.sites.map((s) => [s.name, s.project_code, s.timezone])).toEqual([
      ['Kartal Konutları — B Blok', 'KK-1203', 'Europe/Istanbul'],
      ['Ataşehir Ofis Binası', 'AO-0512', 'Europe/Istanbul'],
    ]);
    expect(demir.reporters.map((r) => [r.name, r.locale, r.languages, r.contact_pref])).toEqual([
      ['Emre Yıldız', 'tr-TR', ['tr'], 'call'],
      ['Selin Kaya', 'tr-TR', ['tr'], 'link'],
    ]);
    for (const r of demir.reporters) expect(isE164(r.phone_e164)).toBe(true);
    expect(demir.siteReporters).toEqual(
      demir.sites.map((s, i) => ({
        site_id: s.id,
        reporter_id: demir.reporters[i]!.id,
        is_primary: true,
      })),
    );
  });

  it('has the four companies with their trades and the four glossary seeds verbatim', () => {
    expect(demir.companies.map((c) => [c.name, c.trade, c.is_self_perform])).toEqual([
      ['Usta Beton', 'Beton', false],
      ['Volt Elektrik', 'Elektrik', false],
      ['Akış Mekanik', 'Mekanik', false],
      ['Demir Yapı öz ekip', 'Genel işçilik', true],
    ]);
    // "TBM / tool box" is two phrases a reporter says: terms match the heard phrase exactly. The
    // crew word is kind `company` (spec §19 Q138's recommended default).
    const seeds = demir.glossary.filter((g) => g.status !== 'built_in');
    expect(seeds.map((g) => [g.heard, g.official, g.kind, g.language, g.org_id, g.status])).toEqual(
      [
        ['döküm', 'Beton dökümü', 'term', 'tr', DEMIR_ORG_ID, 'confirmed'],
        ['kalıp söktük', 'Kalıp sökümü yapıldı', 'term', 'tr', DEMIR_ORG_ID, 'confirmed'],
        ['demirci ekibi', 'Donatı ekibi', 'company', 'tr', DEMIR_ORG_ID, 'confirmed'],
        ['TBM', 'İş güvenliği bilgilendirmesi', 'term', 'tr', DEMIR_ORG_ID, 'confirmed'],
        ['tool box', 'İş güvenliği bilgilendirmesi', 'term', 'tr', DEMIR_ORG_ID, 'confirmed'],
      ],
    );
    expect(DEMIR_GLOSSARY).toHaveLength(5);
    expect(new Set(seeds.map((g) => g.id)).size).toBe(5);
  });

  it('has the Turkish starter glossary as built_in, less the phrases the §18.2 seeds hold (Q238)', () => {
    const builtIn = demir.glossary.filter((g) => g.status === 'built_in');
    const seeded = new Set(DEMIR_GLOSSARY.map(([heard, , kind]) => `${kind}:${heard}`));
    expect(builtIn.map((g) => [g.heard, g.official, g.kind])).toEqual(
      STARTER_GLOSSARY_TR.filter((t) => !seeded.has(`${t.kind}:${t.heard}`)).map((t) => [
        t.heard,
        t.official,
        t.kind,
      ]),
    );
    // "döküm", "TBM" and "tool box" are §18.2 seeds already (confirmed), so the org has them once.
    expect(builtIn).toHaveLength(STARTER_GLOSSARY_TR.length - 3);
    for (const g of builtIn)
      expect(g).toMatchObject({ org_id: DEMIR_ORG_ID, language: 'tr', times_heard: 0 });
    expect(new Set(demir.glossary.map((g) => g.id)).size).toBe(demir.glossary.length);
  });

  it('invents nothing §18.2 does not give: no reports', () => {
    expect(demir.reports).toEqual([]);
    expect(demir.siteDays).toEqual([]);
    expect(demir.manpower).toEqual([]);
    for (const s of demir.sites) expect([s.address, s.lat, s.lng]).toEqual([null, null, null]);
  });

  it('has its own TR admin, Elif Aydın, a member of Demir Yapı only (spec §19 question 18)', () => {
    expect(demir.users).toEqual([
      {
        id: demoId('user:elif'),
        email: 'elif@demiryapi.example',
        name: 'Elif Aydın',
        title: 'Operasyon',
        role: 'admin',
      },
    ]);
    expect(DEMIR_USERS).toBe(demir.users);
    // Her panel language is the org's tr-TR (ui_locale null), set up with the org.
    expect(demir.members).toEqual([
      {
        org_id: DEMIR_ORG_ID,
        user_id: demoId('user:elif'),
        role: 'admin',
        display_name: 'Elif Aydın',
        title: 'Operasyon',
        created_at: demir.org.created_at,
        ui_locale: null,
      },
    ]);
    // Not one of Kestrel's office users, and the dotless ı survives as one character.
    const kestrel = buildKestrelDemo();
    expect(kestrel.members.map((m) => m.user_id)).not.toContain(demoId('user:elif'));
    expect(DEMO_USERS.map((u) => u.id)).not.toContain(demoId('user:elif'));
    expect(kestrel.members.every((m) => m.org_id === kestrel.org.id)).toBe(true);
    expect([...'Aydın']).toHaveLength(5);
    expect(demir.users[0]!.name.normalize('NFC')).toBe(demir.users[0]!.name);
    // The seed logs the membership itself (the org_members trigger skips the service).
    expect(demir.audit.filter((a) => a.entity === 'org_member')).toEqual([
      expect.objectContaining({
        action: 'member.added',
        actor_type: 'system',
        entity_id: demoId('user:elif'),
        diff: { role: 'admin' },
        created_at: demir.org.created_at,
      }),
    ]);
  });

  it('texts the welcome in Turkish without a call number (no TR voice number yet)', () => {
    const [emre, selin] = demir.messages;
    const code = (body: string) => /\/r\/([A-Z0-9]{6})$/.exec(body)![1]!;
    expect(emre!.body).toBe(
      renderSms(
        'welcome',
        'tr',
        {
          first: 'Emre',
          company: 'Demir Yapı A.Ş.',
          site: 'Kartal Konutları — B Blok',
          deadline: '17:30',
          link: `https://go.talkolog.com/r/${code(emre!.body!)}`,
        },
        // The TR pack: no voice number, one-way SMS, links allowed (spec §4.6).
        { hasVoiceNumber: false, twoWay: false, linksAllowed: true },
      ),
    );
    expect(smsRenderOptions(demoPack('TR'))).toEqual({
      hasVoiceNumber: false,
      twoWay: false,
      linksAllowed: true,
    });
    expect(selin!.body).toMatch(
      /^Merhaba Selin, ben TalkOlog, Demir Yapı A\.Ş\. için Ataşehir Ofis Binası/,
    );
    for (const m of demir.messages) {
      expect(m).toMatchObject({
        copy_key: 'welcome',
        provider: 'console',
        channel: 'sms',
        org_id: DEMIR_ORG_ID,
      });
      expect(m.body).not.toMatch(/STOP|HELP|arayın/); // one-way, no number
      const link = demir.fieldLinks.find((l) => l.code_hash === linkCodeHash(code(m.body!)))!;
      expect(link).toMatchObject({ kind: 'personal', reporter_id: m.reporter_id });
    }
    expect(
      demir.consents.filter((c) => c.reporter_id === demir.reporters[0]!.id).map((c) => c.type),
    ).toContain('auto_call');
  });

  it('numbers its audit rows in its own range', () => {
    expect(demir.audit.map((a) => a.id)).toEqual(
      demir.audit.map((_, i) => 9_000_000_000_000 + 2_000_000 + i + 1),
    );
  });

  it('sets up before the live demo day, on the day it is active from (D36)', () => {
    for (const date of ['2026-10-14', '2026-11-06', '2027-03-08', '2026-03-09']) {
      const d = buildDemirDemo({ date });
      const now = buildKestrelDemo({ date }).now;
      const since = d.sites[0]!.active_since!;
      expect(since < date, date).toBe(true);
      for (const s of d.sites) expect(s.active_since).toBe(since);
      const instants = [
        d.org.created_at,
        d.settings.updated_at,
        ...d.members.map((m) => m.created_at),
        ...d.sites.map((s) => s.created_at),
        ...d.reporters.flatMap((r) => [r.created_at, r.invited_at, r.activated_at]),
        ...d.companies.map((c) => c.created_at),
        ...d.glossary.map((g) => g.first_seen_at),
        ...d.messages.map((m) => m.created_at),
        ...d.fieldLinks.map((l) => l.created_at),
        ...d.consents.map((c) => c.given_at),
        ...d.audit.map((a) => a.created_at),
      ];
      for (const at of instants) {
        expect(at! < now, `${date}: ${at}`).toBe(true);
        expect(formatDateInTz(at!, 'Europe/Istanbul'), `${date}: ${at}`).toBe(since);
      }
    }
  });
});
